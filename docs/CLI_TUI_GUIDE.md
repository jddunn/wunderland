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
- `wunderland help workflows`
- `wunderland help tui`
- `wunderland help llm`
- `wunderland help faq`

If you are authoring orchestration definitions, keep them under `./workflows/`, `./missions/`, or `./orchestration/`, import builders from `wunderland/workflows`, and execute them through `createWunderland().runGraph(...)`.

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

## Workflow and Mission commands

Run, explain, and list orchestration definitions from the CLI.

### Workflows (deterministic DAGs)

```bash
# Execute a workflow YAML file
wunderland workflows run examples/workflow-research.yaml --input topic="AI agents"

# List all available prebuilt workflow templates
wunderland workflows list

# Explain a workflow: print step graph without executing
wunderland workflows explain examples/workflow-research.yaml

# Open the workflows help topic
wunderland help workflows
```

### Missions (intent-driven / planner)

```bash
# Execute a mission YAML file
wunderland mission run examples/mission-deep-research.yaml --input topic="quantum computing"

# Explain a mission: show the planner's step decomposition without executing
wunderland mission explain examples/mission-deep-research.yaml
```

### AgentGraph (TypeScript API)

For loops, conditional branches, and custom routing, use `AgentGraph` directly in TypeScript. YAML workflows are acyclic DAGs — any graph that requires cycles must be authored in code.

```bash
# Run a TypeScript graph example
npx tsx examples/graph-research-loop.ts
npx tsx examples/graph-judge-pipeline.ts
```

See `docs/AGENT_GRAPH.md` for the full AgentGraph API.

### Session streaming and checkpoints

```bash
# Run the streaming example
npx tsx examples/session-streaming.ts

# Run the checkpoint/resume example
npx tsx examples/checkpoint-resume.ts
```

These cover `session.stream()` (async iterator of typed events) and `session.checkpoint()` / `session.resume(cpId)` for mid-conversation rollback.

### Authoring conventions

Keep orchestration definitions in predictable directories so the CLI can auto-discover them:

| Directory | Purpose |
|-----------|---------|
| `./workflows/` | Deterministic workflow YAML files |
| `./missions/` | Goal-driven mission YAML files |
| `./orchestration/` | Shared routers, judges, and graph helpers |
| `./examples/` | Runnable examples (YAML + TypeScript) |
