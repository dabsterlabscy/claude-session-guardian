#!/usr/bin/env node
// Runs on SessionStart. Idempotent and fast: seeds the data dir + user config, and checks that
// ccusage is reachable (installs it in the background if missing). Never blocks the session.
import { execFile } from 'node:child_process';
import { loadConfig, dataDir, sense, log } from './lib.mjs';

try {
  loadConfig();     // seeds guardian.config.json on first run
  dataDir();        // ensures the data dir exists

  // Prime the sense cache without blocking startup; if ccusage is missing, install it in the background.
  try {
    const usage = sense(loadConfig(), { force: true });
    log(`bootstrap: sensor ok (${usage.noActiveBlock ? 'no active block' : usage.usedPct + '%'})`);
  } catch {
    log('bootstrap: ccusage not reachable, attempting background global install');
    const cmd = process.platform === 'win32' ? 'cmd' : 'npm';
    const args = process.platform === 'win32' ? ['/c', 'npm', 'i', '-g', 'ccusage'] : ['i', '-g', 'ccusage'];
    const child = execFile(cmd, args, { stdio: 'ignore' }, (err) => {
      log(err ? `bootstrap: ccusage install failed (${err.message}); sensor will fall back to npx`
              : 'bootstrap: ccusage installed globally');
    });
    child.unref();
  }
} catch (e) {
  try { log(`bootstrap error: ${String(e && e.message || e)}`); } catch { /* ignore */ }
}
// SessionStart hooks may print additionalContext, but we stay silent to keep startup clean.
process.exit(0);
