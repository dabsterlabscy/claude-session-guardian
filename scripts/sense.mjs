#!/usr/bin/env node
// Standalone sensor. Prints the current 5-hour usage estimate as JSON.
// Usage: node sense.mjs [--force] [--pretty]
import { loadConfig, sense } from './lib.mjs';

const force = process.argv.includes('--force');
const pretty = process.argv.includes('--pretty');

try {
  const config = loadConfig();
  const usage = sense(config, { force });
  process.stdout.write(JSON.stringify(usage, null, pretty ? 2 : 0) + '\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }) + '\n');
  process.exit(1);
}
