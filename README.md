# Session Guardian

A Claude Code plugin that watches your **5-hour usage window**, **checkpoints your work before you hit the limit** — even while you're away — and **auto-resumes the session** when the window resets.

Install it once per machine; it protects every project automatically, because the 5-hour limit is per-account, not per-project.

---

## Why

Claude Code shows you a popup like *"90% used, resets in 3 hours"*, but:

- **Nothing acts on it.** Claude won't proactively checkpoint as you approach the limit.
- **When you hit the limit, the session just stops (429).** There's no built-in auto-resume.

So if you step away mid-task, you can come back to a dead session and lost context. Session Guardian fixes that.

## How it works

```
status line (official 5h+7d usage)  →  hook brake @ threshold  →  checkpoint file  →  scheduled OS task  →  autonomous resume  →  (repeat)
```

1. **Sense** — the status line receives Claude Code's **own** rate-limit numbers on stdin (`rate_limits.five_hour` and `.seven_day`: `used_percentage` + `resets_at`) — the exact figures behind the native popups, for both the 5-hour and weekly windows. `scripts/statusline.mjs` displays them and caches them for the brake. This is the **official** number, not an estimate, and it's instant. ([`ccusage`](https://github.com/ryoppippi/ccusage) is kept only as a hidden fallback for headless auto-resume runs, where there is no status line.)
2. **Brake** — a `PostToolUse` + `UserPromptSubmit` hook checks the estimate (cheaply, cached). `PostToolUse` fires after *every* tool, so it catches long autonomous runs while you're away. When usage crosses `thresholdPct` (default 85%), it injects a one-time-per-window reminder telling Claude to wrap up.
3. **Checkpoint** — Claude writes `SESSION-STATE.md` (*Done so far / Next steps / Resume command*) so a fresh session can continue with zero extra context.
4. **Arm** — `scripts/arm-wakeup.mjs` schedules a one-shot OS task (Windows Task Scheduler / macOS `at` / Linux `at`) for just after the reset time.
5. **Resume** — at reset, `scripts/resume.mjs` re-checks the guardrails and runs `claude --resume <id> -p` with a bounded prompt, continuing from the checkpoint. The resumed session runs the same hooks, so it re-checkpoints and re-arms — a self-sustaining loop until the work is done or `maxAutoCycles` is hit.

**Desktop notifications:** you get a native toast when the brake fires (*"~87% used · checkpointing · auto-resume ~15:00"*) and again when the session auto-resumes — so you know what's happening even if you stepped away. Windows uses a dependency-free PowerShell toast; macOS uses `osascript`; Linux uses `notify-send`.

## Install

Requires **Node.js** (for the scripts and ccusage) and **Claude Code**.

```
/plugin marketplace add dabsterlabscy/claude-session-guardian
/plugin install session-guardian@dabster-labs
```

That's it — the `SessionStart` hook bootstraps everything automatically: installs `ccusage` if missing, seeds your config, and **wires the live status line** (`⏳ 55% · reset 15:00`) into `~/.claude/settings.json`. Restart Claude Code to activate.

The status line is self-healing (re-points to the current plugin path on each start) and never overrides a `statusLine` you set yourself. To manage it manually instead, set `"manageStatusLine": false` in the config.

## Configuration

Edit `~/.claude/session-guardian/guardian.config.json` (or `${CLAUDE_PLUGIN_DATA}/guardian.config.json`). See `guardian.config.default.json` for the full annotated list.

| Key | Default | Meaning |
| --- | --- | --- |
| `thresholdPct` | `85` | Fire the brake at this % of the window used. |
| `costBudgetPer5hWindowUSD` | `null` | `null` = brake on **time only** (safe, no false alarms). Set a number to also brake on spend (ccusage `costUSD`). Raw token counts are ignored because they're dominated by cache reads. |
| `autonomous` | `true` | `true` = auto-resume at reset. `false` = checkpoint only. |
| `maxAutoCycles` | `6` | Hard cap on consecutive autonomous resumes. |
| `projectAllowlist` | `[]` | Empty = resume anywhere. Add absolute cwd paths to restrict autonomous resume. |
| `killSwitchFile` | `STOP-GUARDIAN` | A file with this name in the project or data dir disables all arming/resuming. |
| `resumeBufferMinutes` | `2` | Schedule the resume this many minutes after the estimated reset. |

## Guardrails (autonomous safety)

Autonomous resume only proceeds when **all** hold: no kill-switch file, cwd passes the allowlist, and `maxAutoCycles` isn't exhausted. The resume prompt is deliberately **bounded** ("do the next 1–2 planned steps, then stop") — not "finish everything". Every action is logged to `guardian.log`.

**Stop it instantly:** create an empty file named `STOP-GUARDIAN` in your project folder.

## Commands

- `/session-guardian:status` — current usage estimate + reset time.
- `/session-guardian:verify` — health-check ccusage, config, and pending scheduled tasks; offer repairs.

## Limitations (honest)

- The 5h/weekly `%` is Claude Code's official number **while a status line is running** (interactive sessions). During a headless auto-resume run there's no status line, so the brake there falls back to a ccusage estimate.
- Autonomous resume needs the **machine on** at reset time (local scheduler). An always-on box (or cron on a server) is a future option.
- Windows scheduling is fully implemented; macOS/Linux use `at` as a best-effort one-shot.
- Autonomous `claude --resume -p` runs with `--dangerously-skip-permissions` — that's why the allowlist, kill-switch, and cycle cap exist.

## Manual end-to-end test

```bash
node scripts/sense.mjs --pretty            # sensor
# lower thresholdPct to 1 in config, then in a session do a couple of tool calls → Claude should checkpoint
node scripts/arm-wakeup.mjs --session <id> --cwd <dir> --reset <ISO> --state <dir>   # arms a task
# verify: PowerShell> Get-ScheduledTask -TaskName "SessionGuardian_*"
```

## Uninstall

`/plugin uninstall session-guardian@dabster-labs`, then remove any leftover tasks:
`Get-ScheduledTask -TaskName "SessionGuardian_*" | Unregister-ScheduledTask -Confirm:$false` (Windows).

---

Built by [Dabster Labs](https://dabsterlabs-ai.cy) · MIT
