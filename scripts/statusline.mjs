#!/usr/bin/env node
// Status line. Instant: reads the cached usage only, and refreshes ccusage in the background.
// Prints e.g. "⏳ 55% · reset 15:00".  Auto-wired into settings.json by bootstrap.mjs.
import { loadConfig, senseCached, fmtLocal } from './lib.mjs';

try {
  const config = loadConfig();
  const u = senseCached(config);
  if (u.unknown) { process.stdout.write('🛡️ …'); process.exit(0); }
  if (u.noActiveBlock) { process.stdout.write('🛡️ idle'); process.exit(0); }
  const warn = u.usedPct >= (config.thresholdPct ?? 85);
  const icon = warn ? '⚠️' : '⏳';
  process.stdout.write(`${icon} ${u.usedPct}% · reset ${fmtLocal(u.resetIso)}`);
} catch {
  process.stdout.write('🛡️ —');
}
process.exit(0);
