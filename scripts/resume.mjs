#!/usr/bin/env node
// Fired by the scheduled task at reset time. Re-checks guardrails, then resumes the session
// headlessly with a bounded prompt so it continues from the checkpoint. Self-deletes its task.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { loadConfig, stateDir, shortId, killSwitchActive, allowlistBlocks, cyclesLeft, consumeCycle, dataDir, log } from './lib.mjs';
import { notify } from './notify.mjs';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const session = arg('session');
const cwd = arg('cwd') || process.cwd();
const statePath = arg('state') || stateDir(session);
const taskName = `SessionGuardian_${shortId(session)}`;

function deleteTask() {
  try {
    if (process.platform === 'win32') {
      execFileSync('schtasks', ['/delete', '/tn', taskName, '/f'], { stdio: 'ignore' });
    }
  } catch { /* task may already be gone */ }
}

function stop(msg) { log(`resume: ${msg}`); process.exit(0); }

if (!session) stop('missing --session; aborting.');

const config = loadConfig();

// Self-clean the one-shot task first, so a blocked resume doesn't linger.
deleteTask();

if (killSwitchActive(config, cwd)) stop(`kill switch present in ${cwd} or data dir; not resuming.`);
if (allowlistBlocks(config, cwd)) stop(`${cwd} not in projectAllowlist; not resuming.`);
if (cyclesLeft(config, session) <= 0) stop(`maxAutoCycles reached; not resuming.`);

const checkpoint = path.join(statePath, 'SESSION-STATE.md');
if (!fs.existsSync(checkpoint)) stop(`no checkpoint at ${checkpoint}; nothing to resume.`);

const left = consumeCycle(config, session);
const prompt = config.resumePrompt || 'Auto-resume by Session Guardian. Read SESSION-STATE.md, do the next 1-2 planned steps, update the checkpoint, then stop.';

log(`resuming session ${session} in ${cwd} (cycles left after this: ${left})`);
notify('🛡️ Session Guardian', `Window reset — resuming your session in ${path.basename(cwd)}…`);

const logFd = fs.openSync(path.join(dataDir(), 'guardian.log'), 'a');
try {
  const args = ['--resume', session, '-p', '--dangerously-skip-permissions'];
  const opts = { cwd, input: prompt, stdio: ['pipe', logFd, logFd], timeout: 1000 * 60 * 60 * 5 };
  const res = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', 'claude', ...args], opts)
    : spawnSync('claude', args, opts);
  log(`resume finished (exit ${res.status}) for session ${session}`);
} catch (e) {
  log(`resume spawn error: ${String(e && e.message || e)}`);
} finally {
  try { fs.closeSync(logFd); } catch { /* ignore */ }
}
