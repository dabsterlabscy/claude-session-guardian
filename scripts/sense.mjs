#!/usr/bin/env node
// Sensor CLI. Prints the current usage as JSON.
//   (default) instant read of the cache the status line maintains (official 5h + 7d numbers)
//   --force   run the ccusage fallback now (slow estimate; used when no status line has run)
//   --pretty  pretty-print
import { loadConfig, senseNow, senseCached } from './lib.mjs';

const force = process.argv.includes('--force');
const pretty = process.argv.includes('--pretty');

try {
  const config = loadConfig();
  const usage = force ? senseNow(config) : senseCached(config);
  process.stdout.write(JSON.stringify(usage, null, pretty ? 2 : 0) + '\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }) + '\n');
  process.exit(1);
}
