---
name: notify
description: Set up (or test/disable) Session Guardian phone push notifications via ntfy — no account, server, or n8n needed. Use when the user wants phone alerts for when Guardian auto-resumes, or asks to enable/test/turn off push.
---

# Session Guardian — phone push setup

Guide the user through enabling phone notifications (via [ntfy](https://ntfy.sh) — free, no account).

1. Run the setup helper (creates a unique private topic and saves it to the config):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/notify-setup.mjs"
   ```
2. Read the JSON output and relay it to the user as clear, friendly steps:
   - Which app to install (give the Android + iOS links from `apps`).
   - The exact **topic name** to subscribe to (`topic`), and that the server stays `ntfy.sh` unless `server` differs.
   - Mention they can open `subscribeUrl` in a browser to see the topic.
   - Pass along the `privacyNote` (the topic is a shared secret; self-hosting via `notifyUrl` is the private option — the user has a Hetzner box).
3. Offer to send a **test push** right now so they can confirm it works on their phone:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/notify-setup.mjs" --test
   ```
   Tell them to check their phone; if nothing arrives, they haven't subscribed to the topic yet.
4. To turn it off later: `node "${CLAUDE_PLUGIN_ROOT}/scripts/notify-setup.mjs" --off`.

Keep it to a short numbered list. The whole point is that the user only installs an app and subscribes to one topic — no accounts, no server, no n8n.
