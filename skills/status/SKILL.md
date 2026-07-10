---
name: status
description: Show the current Session Guardian usage estimate — how much of the 5-hour window is used, when it resets, and how much time is left. Use when the user asks about their usage, limit, or reset time.
---

# Session Guardian — status

Report the current usage to the user.

1. Read the cached usage (populated by the status line from Claude Code's official rate-limit data):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sense.mjs" --pretty
   ```
2. Read the JSON and tell the user, plainly:
   - `usedPct` — % of the current **5-hour** window used. If `official` is true this is Claude Code's own number (same as the popups); otherwise it's a ccusage fallback estimate.
   - `remainingMinutes` and the local reset time (convert `resetIso` to local).
   - `weeklyPct` / `weeklyResetIso` — the **7-day** window, if present.
3. If the output has `unknown: true` (no status line has run yet this session), say usage isn't available yet — it appears once the status line renders; or run with `--force` for a ccusage estimate.
4. If `usedPct` is at/above `thresholdPct`, remind them the brake will fire (checkpoint + auto-resume armed).

Keep it to 2–4 lines. Don't dump raw JSON unless asked.
