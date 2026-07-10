// Shared helpers for Session Guardian: paths, config, logging, and the ccusage sensor.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(__dirname, '..');

// Persistent data dir. Inside a plugin, Claude Code sets CLAUDE_PLUGIN_DATA (survives updates).
// Falls back to ~/.claude/session-guardian when run standalone.
export function dataDir() {
  const d = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'session-guardian');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function stateDir(sessionId) {
  const base = path.join(dataDir(), 'state');
  const d = sessionId ? path.join(base, sanitizeId(sessionId)) : base;
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function sanitizeId(id) {
  return String(id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'unknown';
}

export function shortId(id) {
  return sanitizeId(id).slice(0, 12);
}

export function loadConfig() {
  const defaults = readJson(path.join(PLUGIN_ROOT, 'guardian.config.default.json')) || {};
  const userPath = path.join(dataDir(), 'guardian.config.json');
  const user = readJson(userPath) || {};
  // Seed a user config on first run so it's easy to find and edit.
  if (!fs.existsSync(userPath)) {
    try { fs.writeFileSync(userPath, JSON.stringify(stripDocs(defaults), null, 2)); } catch { /* non-fatal */ }
  }
  return { ...defaults, ...user };
}

function stripDocs(obj) {
  const { _docs, ...rest } = obj || {};
  return rest;
}

export function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(path.join(dataDir(), 'guardian.log'), line); } catch { /* ignore */ }
}

// Kill switch: a file with the configured name in the project dir OR the data dir disables everything.
export function killSwitchActive(config, cwd) {
  const name = config.killSwitchFile || 'STOP-GUARDIAN';
  const spots = [cwd && path.join(cwd, name), path.join(dataDir(), name)].filter(Boolean);
  return spots.some((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

// Allowlist: empty list = allow everywhere. Otherwise cwd must be inside one of the listed dirs.
export function allowlistBlocks(config, cwd) {
  const list = config.projectAllowlist || [];
  if (!list.length) return false;
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const c = norm(cwd);
  return !list.some((allowed) => {
    const a = norm(allowed);
    return c === a || c.startsWith(a + '/');
  });
}

// Autonomous-resume budget, tracked per session in state/<session>/cycles.json.
function cyclesPath(session) { return path.join(stateDir(session), 'cycles.json'); }

export function cyclesLeft(config, session) {
  const rec = readJson(cyclesPath(session));
  if (rec && typeof rec.left === 'number') return rec.left;
  return config.maxAutoCycles ?? 6;
}

export function consumeCycle(config, session) {
  const left = cyclesLeft(config, session) - 1;
  try { fs.writeFileSync(cyclesPath(session), JSON.stringify({ left, updated: new Date().toISOString() })); } catch { /* ignore */ }
  return left;
}

// --- ccusage sensor -------------------------------------------------------

function runCcusageRaw() {
  const args = ['blocks', '--active', '--json'];
  const win = process.platform === 'win32';
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000, windowsHide: true };
  // Prefer a globally-installed ccusage (fast); fall back to npx (downloads once, then cached).
  // On Windows the bins are .cmd shims, so route through cmd.exe with explicit args (no shell:true).
  const attempts = win
    ? [
        () => execFileSync('cmd', ['/c', 'ccusage', ...args], opts),
        () => execFileSync('cmd', ['/c', 'npx', '-y', 'ccusage@latest', ...args], opts),
      ]
    : [
        () => execFileSync('ccusage', args, opts),
        () => execFileSync('npx', ['-y', 'ccusage@latest', ...args], opts),
      ];
  let lastErr;
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt());
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('ccusage failed');
}

// Returns the active block object, or null if none.
function activeBlock() {
  const parsed = runCcusageRaw();
  const blocks = (parsed && parsed.blocks) || [];
  return blocks.find((b) => b.isActive && !b.isGap) || null;
}

// Compute usage from an active block + config. Pure, so it's easy to test.
export function computeUsage(block, config) {
  const start = new Date(block.startTime).getTime();
  const end = new Date(block.endTime).getTime();
  const now = Date.now();
  const span = Math.max(1, end - start);
  const elapsedPct = clampPct(((now - start) / span) * 100);
  const budget = config.costBudgetPer5hWindowUSD;
  const costPct = budget && budget > 0 ? clampPct((block.costUSD / budget) * 100) : null;
  const usedPct = costPct == null ? elapsedPct : Math.max(elapsedPct, costPct);
  const remainingMinutes = Math.max(0, Math.round((end - now) / 60000));
  return {
    usedPct: Math.round(usedPct),
    elapsedPct: Math.round(elapsedPct),
    costPct: costPct == null ? null : Math.round(costPct),
    resetIso: block.endTime,
    remainingMinutes,
    blockId: block.id,
    costUSD: round2(block.costUSD),
    totalTokens: block.totalTokens,
  };
}

function clampPct(x) { return Math.max(0, Math.min(100, x)); }
function round2(x) { return Math.round((x || 0) * 100) / 100; }

function cacheFile() { return path.join(dataDir(), 'sense-cache.json'); }

export function readCache() { return readJson(cacheFile()); }

export function writeUsageCache(usage) {
  try { fs.writeFileSync(cacheFile(), JSON.stringify({ at: Date.now(), usage })); } catch { /* ignore */ }
}

// The authoritative sensor: the status line's stdin JSON carries Claude Code's OWN rate-limit
// numbers (the same ones behind the "90% used, resets in 3h" popups) — for both the 5-hour and
// 7-day windows. Returns our usage shape, or null when the fields aren't present.
export function parseRateLimits(input) {
  const rl = input && input.rate_limits;
  if (!rl || (!rl.five_hour && !rl.seven_day)) return null;
  const fh = rl.five_hour || {};
  const sd = rl.seven_day || {};
  const toIso = (s) => (typeof s === 'number' ? new Date(s * 1000).toISOString() : null);
  const num = (x) => (typeof x === 'number' ? Math.round(x) : null);
  const resetIso = toIso(fh.resets_at);
  const usedPct = num(fh.used_percentage);
  if (usedPct == null && resetIso == null) return null;
  const remainingMinutes = resetIso ? Math.max(0, Math.round((new Date(resetIso).getTime() - Date.now()) / 60000)) : null;
  return {
    usedPct: usedPct ?? 0,
    resetIso,
    remainingMinutes,
    weeklyPct: num(sd.used_percentage),
    weeklyResetIso: toIso(sd.resets_at),
    official: true,
  };
}

// Run ccusage now (slow: a few seconds) and write the cache. Used by the sense.mjs CLI and the
// detached background refresh — NEVER call this on a latency-sensitive path (statusline/hooks).
export function senseNow(config) {
  const block = activeBlock();
  const usage = block
    ? computeUsage(block, config)
    : { usedPct: 0, elapsedPct: 0, costPct: null, resetIso: null, remainingMinutes: null, blockId: null, noActiveBlock: true };
  try { fs.writeFileSync(cacheFile(), JSON.stringify({ at: Date.now(), usage })); } catch { /* ignore */ }
  return usage;
}

// Kick a background refresh of the cache (fire-and-forget). Env (incl. CLAUDE_PLUGIN_DATA) is inherited.
export function refreshDetached() {
  try {
    const script = path.join(PLUGIN_ROOT, 'scripts', 'sense.mjs');
    const child = spawn(process.execPath, [script, '--force'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch { /* ignore */ }
}

// Instant read for statusline/hooks: return the cached value, and refresh in the background if stale.
// Never runs ccusage synchronously, so it's always fast (< ~150ms process spawn).
export function senseCached(config) {
  const ttl = (config.senseCacheSeconds || 60) * 1000;
  const c = readCache();
  if (c && c.at && c.usage && Date.now() - c.at < ttl) return { ...c.usage, cached: true };
  refreshDetached();
  if (c && c.usage) return { ...c.usage, stale: true };
  return { usedPct: 0, elapsedPct: 0, costPct: null, resetIso: null, remainingMinutes: null, blockId: null, unknown: true };
}

// Read a small JSON blob from stdin (hook/statusline payload). Never throws, never hangs.
export async function readStdinJson(timeoutMs = 800) {
  return new Promise((resolve) => {
    let data = '', done = false;
    const finish = () => { if (done) return; done = true; try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } };
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', finish);
    process.stdin.on('error', () => { if (!done) { done = true; resolve({}); } });
    setTimeout(finish, timeoutMs).unref?.();
  });
}

export function fmtLocal(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
