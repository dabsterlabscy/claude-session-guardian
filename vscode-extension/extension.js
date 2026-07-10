// Session Guardian — VS Code companion UI.
// Shows Claude Code usage two zero-token ways (no model calls): a status-bar item and a graphical
// sidebar gauge (WebviewView). Data comes from the plugin's cache file, with a ccusage fallback.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CACHE_CANDIDATES = [
  path.join(os.homedir(), '.claude', 'plugins', 'data', 'session-guardian-dabster-labs', 'sense-cache.json'),
  path.join(os.homedir(), '.claude', 'session-guardian', 'sense-cache.json'),
];
const STALE_MS = 5 * 60_000;

let item, timer, lastBucket = null, lastCcusage = 0, fallbackUsage = null, view = null;

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
  item.command = 'sessionGuardian.gauge.focus'; // click reveals the sidebar gauge
  item.show();

  const provider = new GaugeProvider();
  context.subscriptions.push(
    item,
    vscode.window.registerWebviewViewProvider('sessionGuardian.gauge', provider, { webviewOptions: { retainContextWhenHidden: true } }),
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

// Resolve the usage to show: fresh cache, else ccusage fallback, else stale cache.
function currentUsage() {
  const c = cfg();
  const cache = readCache();
  if (cache && cache.usage && (Date.now() - cache.at) <= STALE_MS) return { usage: cache.usage, at: cache.at, source: cache.usage.official ? 'official' : 'cache' };
  if (c.ccusageFallback) {
    maybeRunCcusage();
    if (fallbackUsage) return { usage: fallbackUsage.usage, at: fallbackUsage.at, source: 'estimate' };
  }
  if (cache && cache.usage) return { usage: cache.usage, at: cache.at, source: 'stale' };
  return null;
}

function render() {
  const c = cfg();
  const cur = currentUsage();

  if (!cur) {
    item.text = '$(pulse) usage n/a';
    item.tooltip = 'Session Guardian: no usage data yet (runs during Claude Code sessions).';
    item.backgroundColor = undefined;
    postToView(null, c);
    return;
  }

  const u = cur.usage;
  const pct = Math.round(u.usedPct ?? 0);
  const reset = hhmm(u.resetIso);
  const stale = cur.source === 'stale';
  const icon = pct >= c.critPct ? '$(flame)' : pct >= c.warnPct ? '$(warning)' : '$(pulse)';
  item.text = `${icon} ${pct}% · ${reset}${stale ? ' (stale)' : ''}`;

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Claude Code usage** _(${cur.source})_\n\n`);
  md.appendMarkdown(`- 5-hour: **${pct}%** · resets **${reset}**` + (u.remainingMinutes != null ? ` (~${u.remainingMinutes} min)` : '') + `\n`);
  if (u.weeklyPct != null) md.appendMarkdown(`- 7-day: **${Math.round(u.weeklyPct)}%** · resets ${hhmm(u.weeklyResetIso)}\n`);
  md.appendMarkdown(`\n_updated ${hhmm(new Date(cur.at).toISOString())} · click for the gauge_`);
  item.tooltip = md;

  if (pct >= c.critPct) item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  else if (pct >= c.warnPct) item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  else item.backgroundColor = undefined;

  const bucket = pct >= c.critPct ? 'crit' : pct >= c.warnPct ? 'warn' : 'ok';
  if (bucket !== lastBucket) {
    lastBucket = bucket;
    if (bucket === 'crit') vscode.window.showWarningMessage(`Claude usage ${pct}% — resets ${reset}.`, 'Open gauge').then(p => { if (p) vscode.commands.executeCommand('sessionGuardian.gauge.focus'); });
    else if (bucket === 'warn') vscode.window.showInformationMessage(`Claude usage at ${pct}% — resets ${reset}.`);
  }

  postToView(cur, c);
}

function postToView(cur, c) {
  if (!view) return;
  const u = cur && cur.usage;
  view.webview.postMessage({
    type: 'update',
    pct: u ? Math.round(u.usedPct ?? 0) : null,
    reset: u ? hhmm(u.resetIso) : '—',
    remaining: u && u.remainingMinutes != null ? u.remainingMinutes : null,
    weeklyPct: u && u.weeklyPct != null ? Math.round(u.weeklyPct) : null,
    weeklyReset: u ? hhmm(u.weeklyResetIso) : null,
    source: cur ? cur.source : 'n/a',
    updated: cur ? hhmm(new Date(cur.at).toISOString()) : '—',
    warnPct: c.warnPct, critPct: c.critPct,
  });
}

function maybeRunCcusage() {
  if (Date.now() - lastCcusage < 60_000) return;
  lastCcusage = Date.now();
  const child = spawn('ccusage', ['blocks', '--active', '--json'], { shell: true, windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('error', () => {});
  child.on('close', () => {
    try {
      const b = (JSON.parse(out).blocks || []).find((x) => x.isActive && !x.isGap);
      if (!b) return;
      const start = new Date(b.startTime).getTime(), end = new Date(b.endTime).getTime(), now = Date.now();
      const pct = Math.max(0, Math.min(100, Math.round(((now - start) / Math.max(1, end - start)) * 100)));
      fallbackUsage = { at: Date.now(), usage: { usedPct: pct, resetIso: b.endTime, remainingMinutes: Math.max(0, Math.round((end - now) / 60000)), weeklyPct: null, official: false } };
      render();
    } catch {}
  });
}

function showDetail() {
  const cur = currentUsage();
  if (!cur) { vscode.window.showInformationMessage('Session Guardian: no usage data yet.'); return; }
  const u = cur.usage;
  vscode.window.showInformationMessage(`Claude usage — 5h: ${Math.round(u.usedPct ?? 0)}% (resets ${hhmm(u.resetIso)})` + (u.weeklyPct != null ? ` · 7d: ${Math.round(u.weeklyPct)}%` : '') + ` · ${cur.source}`);
}

class GaugeProvider {
  resolveWebviewView(webviewView) {
    view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getHtml(webviewView.webview);
    webviewView.onDidDispose(() => { view = null; });
    render(); // paint immediately
  }
}

function getHtml(webview) {
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 14px 12px; }
  .big { font-size: 40px; font-weight: 700; line-height: 1; }
  .sub { opacity: .8; font-size: 12px; margin-top: 4px; }
  .track { height: 10px; border-radius: 6px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.25)); overflow: hidden; margin: 14px 0 6px; }
  .fill { height: 100%; width: 0%; border-radius: 6px; transition: width .4s ease, background .4s; }
  .row { display:flex; justify-content:space-between; font-size:12px; opacity:.85; margin-top:4px; }
  .wk { margin-top: 18px; font-size: 12px; opacity: .85; }
  .wtrack { height: 6px; border-radius: 4px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.25)); overflow:hidden; margin-top:6px; }
  .wfill { height:100%; width:0%; background: var(--vscode-charts-blue, #4aa); border-radius:4px; transition:width .4s; }
  .foot { margin-top: 16px; font-size: 11px; opacity: .55; }
  .na { opacity:.6; font-size:13px; }
</style></head>
<body>
  <div id="app" class="na">Waiting for usage… (runs during Claude Code sessions)</div>
  <script nonce="${nonce}">
    const green='#3fb950', yellow='#d29922', red='#f85149';
    window.addEventListener('message', (e) => {
      const d = e.data; if (d.type !== 'update') return;
      const app = document.getElementById('app');
      if (d.pct == null) { app.className='na'; app.textContent='Waiting for usage… (runs during Claude Code sessions)'; return; }
      const color = d.pct >= d.critPct ? red : d.pct >= d.warnPct ? yellow : green;
      app.className='';
      app.innerHTML =
        '<div class="big" style="color:'+color+'">'+d.pct+'%</div>'+
        '<div class="sub">5-hour window used</div>'+
        '<div class="track"><div class="fill" style="width:'+d.pct+'%;background:'+color+'"></div></div>'+
        '<div class="row"><span>resets '+d.reset+'</span><span>'+(d.remaining!=null?('~'+d.remaining+' min left'):'')+'</span></div>'+
        (d.weeklyPct!=null ? ('<div class="wk">7-day: <b>'+d.weeklyPct+'%</b> · resets '+(d.weeklyReset||'?')+'<div class="wtrack"><div class="wfill" style="width:'+d.weeklyPct+'%"></div></div></div>') : '')+
        '<div class="foot">'+d.source+' · updated '+d.updated+'</div>';
    });
  </script>
</body></html>`;
}

function deactivate() { if (timer) clearInterval(timer); }

module.exports = { activate, deactivate };
