#!/usr/bin/env node
// Schedules a one-shot OS task to auto-resume this session shortly after the window resets.
// Windows: PowerShell Register-ScheduledTask (locale-safe). macOS/Linux: `at` (best effort).
// Called by Claude when the brake fires. Idempotent per session (re-registers with -Force).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, dataDir, stateDir, shortId, killSwitchActive, allowlistBlocks, cyclesLeft, PLUGIN_ROOT, log } from './lib.mjs';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function done(msg, code = 0) {
  process.stdout.write(msg + '\n');
  process.exit(code);
}

const session = arg('session');
const cwd = arg('cwd') || process.cwd();
const resetIso = arg('reset');
const statePath = arg('state') || stateDir(session);

if (!session || !resetIso) done('Session Guardian: missing --session/--reset; nothing armed.', 1);

const config = loadConfig();

if (config.autonomous === false) done('Session Guardian: autonomous resume disabled in config; not arming.');
if (killSwitchActive(config, cwd)) done('Session Guardian: kill switch present; not arming.');
if (allowlistBlocks(config, cwd)) done(`Session Guardian: ${cwd} not in projectAllowlist; not arming.`);
if (cyclesLeft(config, session) <= 0) done(`Session Guardian: maxAutoCycles (${config.maxAutoCycles}) reached; not arming.`);

// Fire time = reset + buffer, in LOCAL time. If already past, fire a minute from now.
const buffer = (config.resumeBufferMinutes ?? 2) * 60000;
let fireMs = new Date(resetIso).getTime() + buffer;
if (!(fireMs > Date.now())) fireMs = Date.now() + 60000;
const fire = new Date(fireMs);
const p = (n) => String(n).padStart(2, '0');
const fireLocal = `${fire.getFullYear()}-${p(fire.getMonth() + 1)}-${p(fire.getDate())}T${p(fire.getHours())}:${p(fire.getMinutes())}:${p(fire.getSeconds())}`;

const taskName = `SessionGuardian_${shortId(session)}`;
const resumeScript = path.join(PLUGIN_ROOT, 'scripts', 'resume.mjs');
const nodeExe = process.execPath;

try {
  if (process.platform === 'win32') {
    // Wrapper .cmd keeps quoting sane for the scheduler.
    const wrapper = path.join(dataDir(), `wake-${shortId(session)}.cmd`);
    fs.writeFileSync(wrapper,
      `@echo off\r\n"${nodeExe}" "${resumeScript}" --session "${session}" --cwd "${cwd}" --state "${statePath}"\r\n`);
    const ps = [
      `$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "${wrapper}"'`,
      `$t = New-ScheduledTaskTrigger -Once -At '${fireLocal}'`,
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable`,
      `Register-ScheduledTask -TaskName '${taskName}' -Action $a -Trigger $t -Settings $s -Force -Description 'Session Guardian auto-resume' | Out-Null`,
    ].join('; ');
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'ignore', 'pipe'] });
  } else if (process.platform === 'darwin' || process.platform === 'linux') {
    // Best-effort one-shot via `at`. HH:MM today (at figures out the date from context).
    const atTime = `${p(fire.getHours())}:${p(fire.getMinutes())}`;
    const cmd = `"${nodeExe}" "${resumeScript}" --session "${session}" --cwd "${cwd}" --state "${statePath}"`;
    execFileSync('sh', ['-c', `echo '${cmd}' | at ${atTime}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  } else {
    done(`Session Guardian: unsupported platform ${process.platform}; cannot schedule auto-resume.`, 1);
  }
} catch (e) {
  log(`arm failed: ${String(e && e.message || e)}`);
  done(`Session Guardian: failed to schedule auto-resume (${String(e && e.message || e)}). Checkpoint is still saved.`, 1);
}

log(`armed auto-resume '${taskName}' at ${fireLocal} (reset ${resetIso}), cwd ${cwd}`);
done(`Session Guardian: auto-resume armed for ${fireLocal} (task ${taskName}).`);
