// Session Guardian — VS Code companion UI.
// Shows Claude Code usage + Guardian state in VS Code's own status bar and a sidebar dashboard
// (WebviewView). Zero model tokens: it reads the plugin's cache, config, and event log.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DATA_DIRS = [
  path.join(os.homedir(), '.claude', 'plugins', 'data', 'session-guardian-dabster-labs'),
  path.join(os.homedir(), '.claude', 'session-guardian'),
];
const STALE_MS = 5 * 60_000;

let item, timer, lastBucket = null, lastCcusage = 0, fallbackUsage = null, view = null;

function cfgUI() {
  const c = vscode.workspace.getConfiguration('sessionGuardian');
  return {
    warnPct: c.get('warnPct', 80),
    critPct: c.get('critPct', 95),
    refreshSeconds: Math.max(5, c.get('refreshSeconds', 30)),
    ccusageFallback: c.get('ccusageFallback', true),
  };
}

// The data dir holding the freshest cache — config + events live alongside it.
function activeDataDir() {
  let best = null, bestAt = -1;
  for (const d of DATA_DIRS) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(d, 'sense-cache.json'), 'utf8'));
      if (c && c.at > bestAt) { bestAt = c.at; best = d; }
    } catch { /* skip */ }
  }
  return best || DATA_DIRS[0];
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function readCache() { return readJson(path.join(activeDataDir(), 'sense-cache.json')); }

function guardianConfig() {
  const c = readJson(path.join(activeDataDir(), 'guardian.config.json')) || {};
  return {
    thresholdPct: c.thresholdPct ?? 91,
    autonomous: c.autonomous !== false,
    maxAutoCycles: c.maxAutoCycles ?? 6,
    milestonePcts: c.milestonePcts || [],
    killSwitchFile: c.killSwitchFile || 'STOP-GUARDIAN',
    notifyTopic: c.notifyTopic || '',
  };
}

function killSwitchOn(gc) {
  try { return fs.existsSync(path.join(activeDataDir(), gc.killSwitchFile)); } catch { return false; }
}

function recentEvents(n = 8) {
  try {
    return fs.readFileSync(path.join(activeDataDir(), 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).slice(-n).reverse();
  } catch { return []; }
}

function hhmm(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '?' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function activate(context) {
  item = vscode.window.createStatusBarItem('sessionGuardian.usage', vscode.StatusBarAlignment.Right, 100);
  item.name = 'Session Guardian';
  item.command = 'sessionGuardian.gauge.focus';
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
  timer = setInterval(render, cfgUI().refreshSeconds * 1000);
}

function currentUsage() {
  const c = cfgUI();
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
  const c = cfgUI();
  const cur = currentUsage();
  const gc = guardianConfig();

  if (!cur) {
    item.text = '$(pulse) usage n/a';
    item.tooltip = 'Session Guardian: no usage data yet (runs during Claude Code sessions).';
    item.backgroundColor = undefined;
    postToView(null, c, gc);
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
  md.appendMarkdown(`\n_click for the dashboard_`);
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

  postToView(cur, c, gc);
}

const EVENT_META = {
  brake_fired: (e) => ({ icon: '⚠', label: `Brake fired — ${e.pct}%` }),
  resume_scheduled: (e) => ({ icon: '▸', label: `Resume scheduled → ${e.fireLocal || '?'}` }),
  resume_fired: (e) => ({ icon: '↻', label: `Resume started${e.project ? ' — ' + e.project : ''}` }),
  resume_completed: (e) => ({ icon: e.exit === 0 ? '✓' : '✗', label: `Resume ${e.exit === 0 ? 'completed' : 'failed'}${e.project ? ' — ' + e.project : ''}` }),
};

function postToView(cur, c, gc) {
  if (!view) return;
  const u = cur && cur.usage;
  const events = recentEvents(8).map((e) => {
    const m = (EVENT_META[e.type] || (() => ({ icon: '•', label: e.type })))(e);
    return { icon: m.icon, label: m.label, time: hhmm(new Date(e.ts).toISOString()) };
  });
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
    guardian: {
      threshold: gc.thresholdPct,
      autonomous: gc.autonomous,
      maxCycles: gc.maxAutoCycles,
      milestones: gc.milestonePcts,
      killSwitch: killSwitchOn(gc),
      push: !!gc.notifyTopic,
    },
    events,
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
    webviewView.webview.html = getHtml();
    webviewView.onDidDispose(() => { view = null; });
    render();
  }
}

function getHtml() {
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 12px 20px; }
  .big { font-size: 38px; font-weight: 700; line-height: 1; }
  .sub { opacity: .75; font-size: 11px; margin-top: 3px; }
  .track { height: 9px; border-radius: 6px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.25)); overflow: hidden; margin: 12px 0 5px; }
  .fill { height: 100%; width: 0%; border-radius: 6px; transition: width .4s ease, background .4s; }
  .row { display:flex; justify-content:space-between; font-size:11px; opacity:.85; }
  .wk { margin-top: 14px; font-size: 11px; opacity:.85; }
  .wtrack { height: 5px; border-radius: 4px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.25)); overflow:hidden; margin-top:5px; }
  .wfill { height:100%; width:0%; background: var(--vscode-charts-blue, #4aa); border-radius:4px; transition:width .4s; }
  h4 { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; opacity: .55; margin: 20px 0 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,.2)); padding-bottom: 4px; }
  .spec { display:flex; justify-content:space-between; font-size:12px; padding:2px 0; }
  .spec b { font-weight:600; }
  .pill { font-size:10px; padding:1px 6px; border-radius:8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .ev { display:grid; grid-template-columns: 16px 1fr auto; gap:6px; font-size:11px; padding:3px 0; align-items:baseline; }
  .ev .t { opacity:.55; }
  .na { opacity:.6; font-size:12px; }
  .muted { opacity:.5; font-size:11px; }
</style></head>
<body>
  <div id="app" class="na">Waiting for usage… (runs during Claude Code sessions)</div>
  <script nonce="${nonce}">
    const green='#3fb950', yellow='#d29922', red='#f85149';
    const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    window.addEventListener('message', (e) => {
      const d = e.data; if (d.type !== 'update') return;
      const app = document.getElementById('app');
      const g = d.guardian || {};
      let html = '';
      if (d.pct == null) {
        html = '<div class="na">Waiting for usage… (runs during Claude Code sessions)</div>';
      } else {
        const color = d.pct >= d.critPct ? red : d.pct >= d.warnPct ? yellow : green;
        html += '<div class="big" style="color:'+color+'">'+d.pct+'%</div>';
        html += '<div class="sub">5-hour window used'+(d.source==='estimate'?' (estimate)':d.source==='stale'?' (stale)':'')+'</div>';
        html += '<div class="track"><div class="fill" style="width:'+d.pct+'%;background:'+color+'"></div></div>';
        html += '<div class="row"><span>resets '+d.reset+'</span><span>'+(d.remaining!=null?('~'+d.remaining+' min left'):'')+'</span></div>';
        if (d.weeklyPct!=null) html += '<div class="wk">7-day: <b>'+d.weeklyPct+'%</b> · resets '+(d.weeklyReset||'?')+'<div class="wtrack"><div class="wfill" style="width:'+d.weeklyPct+'%"></div></div></div>';
      }
      // Guardian specs
      html += '<h4>Guardian</h4>';
      html += '<div class="spec"><span>Brake at</span><b>'+(g.threshold!=null?g.threshold+'%':'—')+'</b></div>';
      html += '<div class="spec"><span>Autonomous resume</span><span class="pill">'+(g.autonomous?'on':'off')+'</span></div>';
      html += '<div class="spec"><span>Max auto-cycles</span><b>'+(g.maxCycles!=null?g.maxCycles:'—')+'</b></div>';
      if (g.milestones && g.milestones.length) html += '<div class="spec"><span>Milestone alerts</span><b>'+g.milestones.join(', ')+'%</b></div>';
      html += '<div class="spec"><span>Phone push</span><span class="pill">'+(g.push?'on':'off')+'</span></div>';
      if (g.killSwitch) html += '<div class="spec"><span>Kill-switch</span><span class="pill" style="background:'+red+';color:#fff">ACTIVE</span></div>';
      // Recent activity
      html += '<h4>Recent activity</h4>';
      if (d.events && d.events.length) {
        for (const ev of d.events) html += '<div class="ev"><span>'+esc(ev.icon)+'</span><span>'+esc(ev.label)+'</span><span class="t">'+esc(ev.time)+'</span></div>';
      } else {
        html += '<div class="muted">No brakes or resumes yet — this fills up when Guardian acts.</div>';
      }
      if (d.updated) html += '<div class="muted" style="margin-top:14px">updated '+esc(d.updated)+'</div>';
      app.className=''; app.innerHTML = html;
    });
  </script>
</body></html>`;
}

function deactivate() { if (timer) clearInterval(timer); }

module.exports = { activate, deactivate };
