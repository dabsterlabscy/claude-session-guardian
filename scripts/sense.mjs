#!/usr/bin/env node
// Sensor CLI. Prints the current 5-hour usage estimate as JSON.
//   --force   run ccusage now (slow, authoritative) and update the cache
//   (default) instant cached read; refreshes in the background if stale
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
