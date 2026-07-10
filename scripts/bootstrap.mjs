#!/usr/bin/env node
// Runs on SessionStart. Idempotent and fast: seeds the data dir + user config, auto-wires the
// live status line, and checks that ccusage is reachable (installs it if missing). Never blocks.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { loadConfig, dataDir, sense, log, PLUGIN_ROOT } from './lib.mjs';

// Auto-install our status line into ~/.claude/settings.json so it "just appears".
// Idempotent, self-healing (re-points to the current plugin path each session), and it never
// clobbers a status line the user set themselves.
function ensureStatusLine(config) {
  if (config.manageStatusLine === false) return;
  const settingsPath = process.env.GUARDIAN_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
    catch { log('bootstrap: settings.json unparseable; leaving status line unmanaged'); return; }
  }
  const script = path.join(PLUGIN_ROOT, 'scripts', 'statusline.mjs');
  const desired = `node "${script}"`;
  const cur = settings.statusLine;
  const ours = cur && typeof cur.command === 'string'
    && cur.command.includes('statusline.mjs') && cur.command.toLowerCase().includes('session-guardian');
  if (cur && !ours) { log('bootstrap: a custom statusLine is set; not overriding it'); return; }
  if (cur && cur.command === desired) return; // already correct
  settings.statusLine = { type: 'command', command: desired };
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    log(`bootstrap: status line wired -> ${script}`);
  } catch (e) { log(`bootstrap: could not wire status line (${String(e && e.message || e)})`); }
}

try {
  const cfg = loadConfig();     // seeds guardian.config.json on first run
  dataDir();        // ensures the data dir exists
  ensureStatusLine(cfg);

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
