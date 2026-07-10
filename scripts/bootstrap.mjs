#!/usr/bin/env node
// Runs on SessionStart. Idempotent, fast, and does NOT run ccusage (so nothing flashes on start):
// it seeds the data dir + config and auto-wires the live status line. The status line itself is
// what reads Claude Code's official rate-limit numbers and feeds them to the brake hooks.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, dataDir, readCache, log, PLUGIN_ROOT } from './lib.mjs';

// Auto-install our status line into ~/.claude/settings.json so usage "just appears".
// Idempotent, self-healing (re-points to the current plugin path), never clobbers a user's own.
function ensureStatusLine(config) {
  if (config.manageStatusLine === false) return;
  const settingsPath = process.env.GUARDIAN_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
    catch { log('bootstrap: settings.json unparseable; leaving status line unmanaged'); return; }
  }
  const script = path.join(PLUGIN_ROOT, 'scripts', 'statusline.mjs');
  const command = `node "${script}"`;
  const refreshInterval = config.statusRefreshSeconds ?? 10;
  const cur = settings.statusLine;
  const ours = cur && typeof cur.command === 'string'
    && cur.command.includes('statusline.mjs') && cur.command.toLowerCase().includes('session-guardian');
  if (cur && !ours) { log('bootstrap: a custom statusLine is set; not overriding it'); return; }
  if (cur && cur.command === command && cur.refreshInterval === refreshInterval) return;
  settings.statusLine = { type: 'command', command, refreshInterval };
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    log(`bootstrap: status line wired -> ${script} (refreshInterval ${refreshInterval}s)`);
  } catch (e) { log(`bootstrap: could not wire status line (${String(e && e.message || e)})`); }
}

try {
  const cfg = loadConfig();     // seeds guardian.config.json on first run
  dataDir();                    // ensures the data dir exists
  ensureStatusLine(cfg);
  const c = readCache();
  log(`bootstrap: ready (cache ${c && c.usage ? c.usage.usedPct + '%' : 'empty — fills on first status render'})`);
} catch (e) {
  try { log(`bootstrap error: ${String(e && e.message || e)}`); } catch { /* ignore */ }
}
process.exit(0);
