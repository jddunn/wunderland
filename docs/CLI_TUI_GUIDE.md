# Wunderland CLI + TUI Guide

This guide covers the terminal UX: onboarding, keybindings, presets, and exports.

## Quickstart (first run)

1. Open the dashboard (TUI): `wunderland`
   - First run shows a short onboarding tour (skip / never show again). Re-open anytime with `t`.
   - Reset tour auto-launch: `wunderland config set ui.tour.status unseen`
2. Run setup: `wunderland setup`
3. Verify your environment: `wunderland doctor`
4. Chat in the terminal: `wunderland chat`
5. Start the server: `wunderland start`

If you prefer scaffolding a project:

```bash
wunderland init my-agent --preset research-assistant
```

For short guides: `wunderland help` and `wunderland help <topic>`.

## TUI dashboard

- `↑/↓` navigate, `⏎` select
- `/` search (command palette-style filtering), `esc` exits search
- `?` help overlay (stays in the TUI)
- `t` opens the onboarding tour (always available)
- `r` refresh, `q` quit

## Drilldown views

### Models / Skills / Extensions

- `↑/↓` (or `j/k`) navigate
- `/` search within the list
- `⏎` opens a details modal
- `?` opens a help modal
- `esc` closes modals / exits search / goes back

### RAG

- Type a query, then `⏎` to search
- `↑/↓` navigates results
- `⏎` opens result details
- `esc` edits the query again

### Status / Voice / Doctor

- `?` help
- `r` refresh (where available)
- `esc` back

## Presets

- Browse presets: `wunderland list-presets`
- Scaffold with a preset: `wunderland init my-agent --preset research-assistant`
- Override security tier: `wunderland init my-agent --security-tier strict`

## Export PNG screenshots

Export non-interactive output as a styled PNG:

```bash
wunderland doctor --export-png doctor.png
wunderland --help --export-png help.png
```

Notes:
- Interactive commands like `chat` are not exportable.
- Export forces truecolor ANSI for pixel-accurate screenshots.

## Troubleshooting

- TUI doesn’t open: run in a real TTY, or force with `--tui`. Pipes/CI default to print-and-exit.
- No color: default is `--theme plain` (or `--no-color` / `NO_COLOR=1`).
- ASCII-only UI: `--ascii` (auto-fallback also triggers in limited terminals).

## Themes and accessibility

- Default UI: `--theme plain` (no color)
- Cyberpunk UI: `--theme cyberpunk`
- Force ASCII-only glyphs: `--ascii`
- Persist preferences:
  - `wunderland config set ui.theme cyberpunk`
  - `wunderland config set ui.ascii true`
  - `wunderland config set ui.tour.status unseen`
  - `wunderland config set ui.tour.status never`
