---
name: verify
description: Health-check and repair Session Guardian — confirm ccusage works, the sensor reads usage, config is valid, and list/clean any scheduled auto-resume tasks. Use when the user asks to check, test, debug, or fix Session Guardian.
---

# Session Guardian — verify & repair

Run these checks and report a short pass/fail summary, then offer fixes.

1. **Sensor / ccusage**
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sense.mjs" --force
   ```
   - Success → sensor OK. `error` in output → ccusage is missing/broken. Repair: `npm i -g ccusage` (or ensure `npx` has network on first run).

2. **Config** — read the user config and show the active values:
   ```
   node -e "import('${CLAUDE_PLUGIN_ROOT}/scripts/lib.mjs').then(m=>console.log(JSON.stringify(m.loadConfig(),null,2)))"
   ```
   Highlight `thresholdPct`, `autonomous`, `maxAutoCycles`, `projectAllowlist`, `killSwitchFile`. The file lives at `${CLAUDE_PLUGIN_DATA}/guardian.config.json` (or `~/.claude/session-guardian/guardian.config.json`).

3. **Scheduled auto-resume tasks** (Windows):
   ```
   schtasks /query /tn "SessionGuardian_*" /fo LIST 2>NUL
   ```
   (macOS/Linux: `atq`.) Report any pending auto-resume jobs and their run time. To cancel one: `schtasks /delete /tn "<name>" /f`.

4. **Kill switch / cycles** — check whether a kill-switch file exists in the current project or data dir, and read `state/<session>/cycles.json` if present to show remaining autonomous cycles.

5. **Log tail** — show the last few lines of `${CLAUDE_PLUGIN_DATA}/guardian.log` so the user can see recent brake/arm/resume activity.

Summarize as: Sensor ✓/✗, Config ✓, Pending tasks: N, Cycles left: N. Then ask if they want any repairs applied.
