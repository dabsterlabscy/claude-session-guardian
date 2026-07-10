# Session Guardian — VS Code Status Bar

Companion VS Code extension for the [Session Guardian](https://github.com/dabsterlabscy/claude-session-guardian) Claude Code plugin.

Claude Code's built-in status line only renders in the **terminal**, not the VS Code extension. This adds two native, **zero-token** VS Code surfaces:

- A **status bar item** (bottom-right): `⏱ 62% · 15:00` — click it to open the gauge.
- A **sidebar gauge** (Session Guardian icon in the Activity Bar): a graphical panel with a big %, colored bar, reset time, and the weekly window.

- Reads the usage cache the Claude Code plugin maintains (`~/.claude/plugins/data/session-guardian-dabster-labs/sense-cache.json`).
- Falls back to running `ccusage` directly when the cache is missing/stale, so it works even outside a Claude Code session.
- Colors the item **yellow at 80%** and **red at 95%**, and shows a toast when you cross those thresholds.
- Click the item for a usage detail popup.
- Hover for 5-hour + weekly breakdown.

> The number is Claude Code's **official** figure only when a terminal `claude` status line is feeding the cache; inside the VS Code extension alone it's a **ccusage estimate** (Claude Code doesn't expose the official rate-limit numbers to the extension).

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `sessionGuardian.warnPct` | 80 | Yellow at/above this %. |
| `sessionGuardian.critPct` | 95 | Red + toast at/above this %. |
| `sessionGuardian.refreshSeconds` | 30 | Status bar refresh interval. |
| `sessionGuardian.ccusageFallback` | true | Run ccusage when the cache is stale/missing. |

## Install (sideload)

```bash
npx --yes @vscode/vsce package
code --install-extension session-guardian-statusbar-0.1.0.vsix
```

Then reload the VS Code window. To remove: `code --uninstall-extension dabster-labs.session-guardian-statusbar`.

MIT · Dabster Labs
