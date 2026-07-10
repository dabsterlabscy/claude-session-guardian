#!/usr/bin/env node
// Runs on PostToolUse and UserPromptSubmit. Cheap by default (reads cached sense).
// When usage crosses the threshold, injects a one-time-per-block reminder telling Claude
// to checkpoint and arm autonomous resume. It never blocks — only adds context.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, sense, stateDir, killSwitchActive, PLUGIN_ROOT, fmtLocal, readStdinJson, log } from './lib.mjs';

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

  const usage = sense(config);
  if (usage.noActiveBlock || usage.usedPct < (config.thresholdPct ?? 85)) emit(null);

  // Remind once per 5h block per session.
  const sdir = stateDir(sessionId);
  const marker = path.join(sdir, `reminded-${(usage.blockId || 'x').replace(/[^0-9A-Za-z]/g, '')}`);
  if (fs.existsSync(marker)) emit(null);
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch { /* ignore */ }

  const statePath = sdir;
  const armScript = path.join(PLUGIN_ROOT, 'scripts', 'arm-wakeup.mjs');
  const resetLocal = fmtLocal(usage.resetIso);
  const killName = config.killSwitchFile || 'STOP-GUARDIAN';

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
${armLine}
4. Then briefly tell the user you've checkpointed, and stop.
${config.autonomous === false ? '' : `Guardian will auto-resume this session shortly after ${resetLocal}. To cancel, create an empty file named ${killName} in ${cwd}.`}`;

  log(`brake fired: ${usage.usedPct}% (${eventName}, session ${sessionId}), reset ${usage.resetIso}`);
  emit({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } });
} catch (e) {
  // Never break the session over a monitoring failure.
  try { log(`hook error: ${String(e && e.message || e)}`); } catch { /* ignore */ }
  emit(null);
}
