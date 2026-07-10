// Session Guardian — VS Code status bar companion.
// Claude Code's built-in status line is terminal-only, so this native VS Code extension shows the
// same usage (from the plugin's cache) in VS Code's own status bar. Falls back to ccusage when the
// cache is missing/stale so the item works even when Claude Code isn't actively running.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// The plugin writes its cache to CLAUDE_PLUGIN_DATA (installed) or ~/.claude/session-guardian (standalone).
const CACHE_CANDIDATES = [
  path.join(os.homedir(), '.claude', 'plugins', 'data', 'session-guardian-dabster-labs', 'sense-cache.json'),
  path.join(os.homedir(), '.claude', 'session-guardian', 'sense-cache.json'),
];

const STALE_MS = 5 * 60_000;
let item, timer, lastBucket = null, lastCcusage = 0, fallbackUsage = null;

function cfg() {
  const c = vscode.workspace.getConfiguration('sessionGuardian');
  return {
    warnPct: c.get('warnPct', 80),
    critPct: c.get('critPct', 95),
    refreshSeconds: Math.max(5, c.get('refreshSeconds', 30)),
    ccusageFallback: c.get('ccusageFallback', true),
  };
}

function activate(context) {
  item = vscode.window.createStatusBarItem('sessionGuardian.usage', vscode.StatusBarAlignment.Right, 100);
  item.name = 'Session Guardian';
  item.command = 'sessionGuardian.showDetail';
  item.show();
  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('sessionGuardian.showDetail', showDetail),
    vscode.commands.registerCommand('sessionGuardian.refresh', () => { lastCcusage = 0; render(); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('sessionGuardian')) restartTimer(); }),
  );
  restartTimer();
}

function restartTimer() {
  if (timer) clearInterval(timer);
  render();
  timer = setInterval(render, cfg().refreshSeconds * 1000);
}

// Read the freshest parseable cache from the candidate paths.
function readCache() {
  let best = null;
  for (const p of CACHE_CANDIDATES) {
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (c && c.at && (!best || c.at > best.at)) best = c;
    } catch { /* missing/partial */ }
  }
  return best;
}

function hhmm(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '?' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function render() {
  const c = cfg();
  let usage = null, at = null, source = 'cache';
  const cache = readCache();
  if (cache && cache.usage && (Date.now() - cache.at) <= STALE_MS) {
    usage = cache.usage; at = cache.at;
  } else if (c.ccusageFallback) {
    maybeRunCcusage();                 // async; updates fallbackUsage for a later tick
    if (fallbackUsage) { usage = fallbackUsage.usage; at = fallbackUsage.at; source = 'ccusage'; }
    else if (cache && cache.usage) { usage = cache.usage; at = cache.at; source = 'stale'; }
  } else if (cache && cache.usage) {
    usage = cache.usage; at = cache.at; source = 'stale';
  }

  if (!usage) {
    item.text = '$(pulse) usage n/a';
    item.tooltip = 'Session Guardian: no usage data yet. Runs during Claude Code sessions.';
    item.backgroundColor = undefined;
    return;
  }

  const pct = Math.round(usage.usedPct ?? 0);
  const reset = hhmm(usage.resetIso);
  const stale = source === 'stale' || (at && Date.now() - at > STALE_MS);
  const icon = pct >= c.critPct ? '$(flame)' : pct >= c.warnPct ? '$(warning)' : '$(pulse)';
  item.text = `${icon} ${pct}% · ${reset}${stale ? ' (stale)' : ''}`;

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Claude Code usage** _(${usage.official ? 'official' : source === 'ccusage' ? 'estimate' : source})_\n\n`);
  md.appendMarkdown(`- 5-hour: **${pct}%** used · resets **${reset}**` + (usage.remainingMinutes != null ? ` (~${usage.remainingMinutes} min)` : '') + `\n`);
  if (usage.weeklyPct != null) md.appendMarkdown(`- 7-day: **${Math.round(usage.weeklyPct)}%** · resets ${hhmm(usage.weeklyResetIso)}\n`);
  md.appendMarkdown(`\n_Updated ${hhmm(new Date(at).toISOString())} · click for detail_`);
  item.tooltip = md;

  if (pct >= c.critPct) item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  else if (pct >= c.warnPct) item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  else item.backgroundColor = undefined;

  const bucket = pct >= c.critPct ? 'crit' : pct >= c.warnPct ? 'warn' : 'ok';
  if (bucket !== lastBucket) {
    lastBucket = bucket;
    if (bucket === 'crit') vscode.window.showWarningMessage(`Claude usage ${pct}% — resets ${reset}.`, 'Detail').then(p => { if (p) showDetail(); });
    else if (bucket === 'warn') vscode.window.showInformationMessage(`Claude usage at ${pct}% — resets ${reset}.`);
  }
}

// Throttled ccusage fallback (≤ once/60s). Computes a time-based estimate from the active block.
function maybeRunCcusage() {
  if (Date.now() - lastCcusage < 60_000) return;
  lastCcusage = Date.now();
  const args = ['blocks', '--active', '--json'];
  const child = spawn('ccusage', args, { shell: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('error', () => { /* ccusage not installed */ });
  child.on('close', () => {
    try {
      const b = (JSON.parse(out).blocks || []).find((x) => x.isActive && !x.isGap);
      if (!b) return;
      const start = new Date(b.startTime).getTime(), end = new Date(b.endTime).getTime(), now = Date.now();
      const pct = Math.max(0, Math.min(100, Math.round(((now - start) / Math.max(1, end - start)) * 100)));
      fallbackUsage = { at: Date.now(), usage: { usedPct: pct, resetIso: b.endTime, remainingMinutes: Math.max(0, Math.round((end - now) / 60000)), weeklyPct: null, official: false } };
    } catch { /* ignore */ }
  });
}

function showDetail() {
  const cache = readCache();
  const u = (cache && cache.usage) || (fallbackUsage && fallbackUsage.usage);
  if (!u) { vscode.window.showInformationMessage('Session Guardian: no usage data yet.'); return; }
  vscode.window.showInformationMessage(
    `Claude usage — 5h: ${Math.round(u.usedPct ?? 0)}% (resets ${hhmm(u.resetIso)})` +
    (u.weeklyPct != null ? ` · 7d: ${Math.round(u.weeklyPct)}%` : '') +
    (u.official ? ' · official' : ' · estimate'),
  );
}

function deactivate() { if (timer) clearInterval(timer); }

module.exports = { activate, deactivate };
