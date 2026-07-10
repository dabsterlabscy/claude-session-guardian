#!/usr/bin/env node
// One-command setup for phone push (ntfy — no account, no server, no n8n).
//   (default)  ensure a unique topic exists in the config, print subscribe instructions
//   --test     send a test push to the configured topic
//   --off      disable push (clear the topic)
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataDir, loadConfig, pushNotify } from './lib.mjs';

const configPath = path.join(dataDir(), 'guardian.config.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; } };
const writeCfg = (c) => fs.writeFileSync(configPath, JSON.stringify(c, null, 2) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

const APPS = {
  android: 'https://play.google.com/store/apps/details?id=io.heckel.ntfy',
  ios: 'https://apps.apple.com/app/ntfy/id1625396347',
  fdroid: 'https://f-droid.org/en/packages/io.heckel.ntfy/',
};

const mode = process.argv.includes('--off') ? 'off' : process.argv.includes('--test') ? 'test' : 'setup';

if (mode === 'off') {
  const c = readCfg(); c.notifyTopic = ''; writeCfg(c);
  out({ status: 'disabled', message: 'Phone push turned off (topic cleared).' });
  process.exit(0);
}

if (mode === 'test') {
  const c = loadConfig();
  if (!c.notifyTopic) { out({ status: 'no-topic', message: 'No topic set yet. Run setup first.' }); process.exit(0); }
  await pushNotify(c, 'Session Guardian', 'Test push — if you see this on your phone, alerts are working.');
  out({ status: 'test-sent', topic: c.notifyTopic, url: `${(c.notifyUrl || 'https://ntfy.sh').replace(/\/+$/, '')}/${c.notifyTopic}`, message: 'Test push sent. Check your phone (make sure you subscribed to the topic).' });
  process.exit(0);
}

// setup: generate a unguessable topic if none, persist it, return instructions
const c = readCfg();
let created = false;
if (!c.notifyTopic) {
  c.notifyTopic = 'guardian-' + randomBytes(9).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toLowerCase();
  if (!c.notifyUrl) c.notifyUrl = 'https://ntfy.sh';
  writeCfg(c);
  created = true;
}
const base = (c.notifyUrl || 'https://ntfy.sh').replace(/\/+$/, '');
out({
  status: created ? 'created' : 'exists',
  topic: c.notifyTopic,
  subscribeUrl: `${base}/${c.notifyTopic}`,
  server: base,
  apps: APPS,
  steps: [
    `Install the free "ntfy" app on your phone: Android ${APPS.android} · iOS ${APPS.ios}`,
    `Open ntfy → tap "+" (Subscribe to topic).`,
    (base === 'https://ntfy.sh')
      ? `Enter this topic name: ${c.notifyTopic}  (leave server as ntfy.sh)`
      : `Set server to ${base} and topic to: ${c.notifyTopic}`,
    `Done. Guardian will push a one-line summary here whenever an auto-resume completes.`,
    `Tip: open ${base}/${c.notifyTopic} in a browser to see/test the topic. Or run the test option to send one now.`,
  ],
  privacyNote: 'The topic name is a shared secret on the public ntfy.sh server — keep it private. For full privacy, self-host ntfy (e.g. on your Hetzner box) and set notifyUrl to it.',
});
