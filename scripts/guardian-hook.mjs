#!/usr/bin/env node
// Runs on PostToolUse and UserPromptSubmit. Cheap by default (reads cached sense).
// When usage crosses the threshold, injects a one-time-per-block reminder telling Claude
// to checkpoint and arm autonomous resume. It never blocks — only adds context.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, senseCached, stateDir, killSwitchActive, PLUGIN_ROOT, fmtLocal, readStdinJson, log, logEvent } from './lib.mjs';
import { notify } from './notify.mjs';

function emit(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

try {
  const input = await readStdinJson();
  const eventName = input.hook_event_name || 'PostToolUse';
  const sessionId = input.session_id || 'unknown';
  const cwd = input.cwd || process.cwd();

  const config = loadConfig();

  // Kill switch → stay silent.
  if (killSwitchActive(config, cwd)) emit(null);

  const usage = senseCached(config);
  if (usage.unknown || usage.noActiveBlock) emit(null);

  // CORRECTNESS: only ACT on Claude Code's OWN rate-limit numbers (usage.official === true, present
  // when a terminal status line feeds them). The ccusage fallback is a TIME-based estimate — it
  // reflects wall-clock elapsed in the 5-hour window, not real token usage — so it must never fire
  // the brake, milestones, or banner. (That mismatch caused false "93% used" alarms in the VS Code
  // extension, where no official number is available.) Opt in with config.brakeOnEstimate: true.
  if (!usage.official && config.brakeOnEstimate !== true) emit(null);

  const sdir = stateDir(sessionId);
  // Stable per-window key (hour precision) so milestone/remind markers dedupe even if the
  // reported reset time wobbles by a few seconds between renders.
  const blockKey = (usage.blockId
    || (usage.resetIso ? new Date(usage.resetIso).toISOString().slice(0, 13) : 'x')
  ).replace(/[^0-9A-Za-z]/g, '');
  const resetLocal = fmtLocal(usage.resetIso);

  // Ambient heads-up toasts at milestones (independent of the brake), once per block per level.
  // This is the main "you can see it" signal in the VS Code extension, which has no status line.
  for (const m of (config.milestonePcts || [])) {
    if (usage.usedPct >= m) {
      const mk = path.join(sdir, `ms-${blockKey}-${m}`);
      if (!fs.existsSync(mk)) {
        try { fs.writeFileSync(mk, new Date().toISOString()); } catch { /* ignore */ }
        const wk = (typeof usage.weeklyPct === 'number' && usage.weeklyPct >= 50) ? ` · 7d ${usage.weeklyPct}%` : '';
        notify('🛡️ Session Guardian', `~${usage.usedPct}% used · resets ${resetLocal}${wk}`);
        log(`milestone ${m}% toast: ${usage.usedPct}% (session ${sessionId})`);
      }
    }
  }

  const thr = config.thresholdPct ?? 91;

  // In-chat banner: on a user prompt with elevated (pre-brake) usage, have Claude surface a
  // one-line usage banner at the top of its reply — the "central in the chat" signal.
  // Set chatBannerPct to 0 for an always-on banner, or very high to disable it.
  if (eventName === 'UserPromptSubmit' && usage.usedPct >= (config.chatBannerPct ?? 50) && usage.usedPct < thr) {
    const line = `🛡️ Usage ${usage.usedPct}% · reset ${resetLocal}${usage.remainingMinutes != null ? ` · ~${usage.remainingMinutes}min left` : ''}`
      + ((typeof usage.weeklyPct === 'number' && usage.weeklyPct >= 50) ? ` · 7d ${usage.weeklyPct}%` : '');
    emit({ hookSpecificOutput: { hookEventName: eventName, additionalContext:
      `Session Guardian: usage is elevated. Begin your reply with this exact line, then a blank line, before your normal answer:\n${line}` } });
  }

  // Brake fires at the threshold.
  if (usage.usedPct < thr) emit(null);

  // Remind (checkpoint + arm) once per 5h block per session.
  const marker = path.join(sdir, `reminded-${blockKey}`);
  if (fs.existsSync(marker)) emit(null);
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch { /* ignore */ }

  const statePath = sdir;
  const armScript = path.join(PLUGIN_ROOT, 'scripts', 'arm-wakeup.mjs');
  const killName = config.killSwitchFile || 'STOP-GUARDIAN';
  const checkpointExtra = config.checkpointExtra
    || 'Also update the project files/notes you normally maintain (e.g. a daily .md, README, task log, or a commit) so the work is saved the way you work.';
  const weeklyNote = (typeof usage.weeklyPct === 'number' && usage.weeklyPct >= 50)
    ? `\nNote: your 7-day usage is also at ~${usage.weeklyPct}%${usage.weeklyResetIso ? ` (resets ${fmtLocal(usage.weeklyResetIso)})` : ''}.`
    : '';

  const armLine = config.autonomous === false
    ? '(Autonomous resume is disabled in config — no auto-resume will be scheduled.)'
    : `3. Arm autonomous auto-resume by running this exact command:\n`
      + `   node "${armScript}" --session "${sessionId}" --cwd "${cwd}" --reset "${usage.resetIso}" --state "${statePath}"`;

  const context =
`⚠️ SESSION GUARDIAN — you are approaching the 5-hour usage limit (~${usage.usedPct}% used; window resets ~${resetLocal}, about ${usage.remainingMinutes} min left).
Wrap up cleanly now, before the window runs out:
1. Finish only the current step — don't start new work.
2. Write/update a checkpoint file at:
   ${path.join(statePath, 'SESSION-STATE.md')}
   with these sections: "## Done so far", "## Next steps" (ordered, concrete), "## Resume command". Write enough that a fresh session can continue with zero extra context.
   ${checkpointExtra}
${armLine}
4. Then briefly tell the user you've checkpointed, and stop.${weeklyNote}
${config.autonomous === false ? '' : `Guardian will auto-resume this session shortly after ${resetLocal}. To cancel, create an empty file named ${killName} in ${cwd}.`}`;

  log(`brake fired: ${usage.usedPct}% (${eventName}, session ${sessionId}), reset ${usage.resetIso}`);
  logEvent('brake_fired', { session: sessionId, cwd, pct: usage.usedPct, resetIso: usage.resetIso });
  const armed = config.autonomous === false ? 'checkpoint only' : `auto-resume ~${resetLocal}`;
  notify('⚠️ Session Guardian', `~${usage.usedPct}% used · checkpointing · ${armed}`);
  emit({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } });
} catch (e) {
  // Never break the session over a monitoring failure.
  try { log(`hook error: ${String(e && e.message || e)}`); } catch { /* ignore */ }
  emit(null);
}
