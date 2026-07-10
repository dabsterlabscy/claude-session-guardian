#!/usr/bin/env node
// Optional status line. Prints e.g. "⏳ 55% · reset 15:00" for the human.
// Wire it in settings.json:  "statusLine": { "type": "command", "command": "node \"<path>/scripts/statusline.mjs\"" }
import { loadConfig, sense, fmtLocal } from './lib.mjs';

try {
  const config = loadConfig();
  const u = sense(config);
  if (u.noActiveBlock) { process.stdout.write('🛡️ idle'); process.exit(0); }
  const warn = u.usedPct >= (config.thresholdPct ?? 85);
  const icon = warn ? '⚠️' : '⏳';
  process.stdout.write(`${icon} ${u.usedPct}% · reset ${fmtLocal(u.resetIso)}`);
} catch {
  process.stdout.write('🛡️ —');
}
process.exit(0);
