---
name: status
description: Show the current Session Guardian usage estimate — how much of the 5-hour window is used, when it resets, and how much time is left. Use when the user asks about their usage, limit, or reset time.
---

# Session Guardian — status

Report the current usage estimate to the user.

1. Run the sensor:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sense.mjs" --force --pretty
   ```
2. Read the JSON and tell the user, plainly:
   - `usedPct` — estimated % of the current 5-hour window used (this is an **estimate** from ccusage, not the official number).
   - `remainingMinutes` and the local reset time (convert `resetIso` to local).
   - `elapsedPct` (time-based) and, if not null, `costPct` (spend-based) so they see which one is driving the number.
   - `costUSD` for the block.
3. If `noActiveBlock` is true, say there's no active usage block right now (idle).
4. If the number is at or above the configured `thresholdPct`, remind them the brake will fire and a checkpoint + auto-resume will be armed.

Keep it to 2–4 lines. Do not dump raw JSON unless asked.
