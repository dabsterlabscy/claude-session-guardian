#!/usr/bin/env node
// Status line. Reads Claude Code's OWN rate-limit numbers from the stdin JSON (official, instant),
// caches them for the brake hooks to read, and prints e.g. "⏳ 62% · reset 15:00 · 7d 40%".
// Never runs ccusage, so it renders in a few ms and won't get cancelled by the status-line timeout.
import { loadConfig, parseRateLimits, writeUsageCache, readCache, fmtLocal, readStdinJson } from './lib.mjs';

try {
  const config = loadConfig();
  let u = null;
  try {
    const input = await readStdinJson(500);
    u = parseRateLimits(input);
    if (u) writeUsageCache(u);       // hand the official numbers to the brake hooks
  } catch { /* fall through to cache */ }

  if (!u) {
    const c = readCache();           // last known value (e.g. from a headless fallback); stay instant
    if (c && c.usage) u = c.usage;
  }
  if (!u) { process.stdout.write('🛡️ …'); process.exit(0); }

  const pct = u.usedPct ?? 0;
  const icon = pct >= (config.thresholdPct ?? 85) ? '⚠️' : '⏳';
  let s = `${icon} ${pct}% · reset ${fmtLocal(u.resetIso)}`;
  if (typeof u.weeklyPct === 'number' && u.weeklyPct >= 50) s += ` · 7d ${u.weeklyPct}%`;
  process.stdout.write(s);
} catch {
  process.stdout.write('🛡️ —');
}
process.exit(0);
