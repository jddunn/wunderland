# Wunderland CLI + TUI Guide

This guide covers the terminal UX: onboarding, keybindings, presets, and exports.

## Quickstart (first run)

1. Use the one-shot path if you want the fastest route to a runnable agent: `wunderland quickstart`
2. Open the dashboard (TUI): `wunderland`
   - First run shows a short onboarding tour (skip / never show again). Re-open anytime with `t`.
   - Reset tour auto-launch: `wunderland config set ui.tour.status unseen`
3. Run setup: `wunderland setup`
4. Verify your environment: `wunderland doctor`
5. Chat in the terminal: `wunderland chat`
6. Start the server: `wunderland start`

If you prefer scaffolding a project:

```bash
wunderland init my-agent --preset research-assistant
```

For short guides: `wunderland help` and `wunderland help <topic>`.

Useful help topics:

- `wunderland help getting-started`
- `wunderland help tui`
- `wunderland help llm`
- `wunderland help faq`

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

## Provider defaults

Set global defaults once when you want image generation, voice, speech recognition, or web search to prefer a specific provider:

```bash
wunderland extensions configure
```

For image generation specifically, inspect required keys and current readiness with:

```bash
wunderland extensions info image-generation
```

Supported image-generation defaults in the CLI are:

- `openai`
- `openrouter`
- `stability`
- `replicate`

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
