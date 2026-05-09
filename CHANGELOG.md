# Changelog

## [0.72.0] - 2026-05-09

### License

 . See [NOTICE](NOTICE) for details. The relicense is forward-only; recipients of MIT-licensed versions retain MIT rights to those versions in perpetuity.

### BREAKING CHANGES — public surface migration

The `package.json` `exports` field collapsed from 14 declared subpaths to 3. The `wunderland/advanced/*` re-export shelf was removed. Consumers should import named exports from the root `wunderland` package instead.

#### Migration table

| Old import | New import |
|---|---|
| `from 'wunderland/advanced'` | `from 'wunderland'` |
| `from 'wunderland/advanced/core'` | `from 'wunderland'` |
| `from 'wunderland/advanced/security'` | `from 'wunderland'` |
| `from 'wunderland/advanced/social'` | `from 'wunderland'` |
| `from 'wunderland/advanced/<anything>'` | `from 'wunderland'` |
| `from 'wunderland/workflows'` | `from 'wunderland'` |
| `from 'wunderland/api'` | `from 'wunderland/api'` (path preserved, dist target updated) |
| `from 'wunderland/discovery'` | `from 'wunderland/discovery'` (path preserved, dist target updated) |
| `from 'wunderland/tools'` | `from 'wunderland'` (subpath removed; named exports moved to root) |
| `from 'wunderland/config'` | `from 'wunderland'` (subpath removed) |
| `from 'wunderland/security'` | `from 'wunderland'` (subpath removed) |
| `from 'wunderland/runtime'` | `from 'wunderland'` (subpath removed) |
| `from 'wunderland/storage'` | `from 'wunderland'` (subpath removed) |
| `from 'wunderland/voice'` | `from 'wunderland'` (subpath removed) |
| `from 'wunderland/browser'` | `from 'wunderland'` (subpath removed) |
| `from 'wunderland/guardrails'` | `from 'wunderland'` (subpath removed) |
| `from 'wunderland/presets'` | `from 'wunderland'` (subpath removed) |

#### Internal layout

`packages/wunderland/src/` regrouped from 26 top-level directories into 9 themed groups: `agents/`, `runtime/`, `memory/`, `channels/`, `autonomy/`, `security/`, `platform/`, `cli/`, `types/`. Internal API is unaffected for consumers using the root `wunderland` package import.

### Other changes

- README hero rewritten around the autonomous-agents-anywhere identity
- "Built on OpenClaw" framing corrected to "Built on AgentOS"; OpenClaw stays as competitive parity tracking
- `Wunderland on Sol` content moved to [`apps/wunderland-sol/`](https://github.com/manicinc/wunderland-sol)
- Three empty stub packages (`wilds-family-{arcade,platformer,survival}`) removed from monorepo

## [0.41.0] - 2026-03-28

### Changed
- refactor: extract `AgentBootstrap` (`src/bootstrap/`) as single source of truth for agent initialization, shared by CLI chat, public API, and HTTP API
- refactor: split `cli/commands/chat.ts` god object into `ChatREPL.ts` (interactive loop) and `ChatStreamRenderer.ts` (stream rendering)
- refactor: split `runtime/tool-calling.ts` into `ToolApprovalHandler.ts` (approval flow) and `ToolStreamProcessor.ts` (stream processing)
- refactor: extract `api/routes/` (chat, agents, health, social, config) from `api/server.ts`
- refactor: extract `cli/commands/start/routes/` (chat, agents, health, social, config, html-pages, helpers) from `cli/commands/start/http-server.ts`
- refactor: group auth commands into `cli/commands/auth/` (login, logout, auth-status)
- refactor: group AI commands into `cli/commands/ai/` (image, video, audio, vision, structured)
- refactor: group agent commands into `cli/commands/agent/` (agents, ps, stop, logs, monitor, serve)
- refactor: move `cli/security/env-secrets.ts` to `security/env-secrets.ts`
- refactor: delete back-compat shims (`cli/openai/tool-calling.ts`, `cli/config/workspace.ts`, `cli/security/runtime-policy.ts`)
- refactor: delete dead `cli/observability/otel.ts` shim
- refactor: delete duplicate `CronScheduler.spec.ts`
- refactor: delete vestigial `types/discord-js-optional.d.ts` stub
- docs: update architecture docs, README, and feature docs to reflect restructuring

## [0.40.0] - 2026-03-14

### Added
- feat(cli): voice setup in QuickStart mode — auto-detects OpenAI key, offers 4 provider paths (openai-auto, openai-new, elevenlabs, local)
- feat(cli): new `llm` help topic covering 5 providers, switching, OAuth, env vars
- feat(cli): new `faq` help topic with 9 common Q&As
- feat(cli): rewritten `voice` help topic with full provider coverage (TTS, STT, VAD)
- feat(cli): `voiceVoice`, `sttProvider`, `sttModel` config fields
- feat(cli): alias resolution for help topics (ollama/openai/anthropic → llm, faqs/questions → faq)
- feat: voice runtime with speech catalog and CLI voice commands
- feat: complete Ollama implementation with hardware auto-detection
- feat(cli): infinite context window integration in chat loop
- feat: persistent dedup cache with title similarity for curated picks
- feat: include skills, deep-research, and more in default extensions
- feat: local memory tool and updated extension loader
- feat: add `read_document` to safe navigation tools
- feat(cli): overdrive mode, accept-all, tier-aware auth to reduce permission over-prompting
- feat(cli): `--format json` for doctor and status commands
- feat(cli): first-run detection, quickstart, and unified new command
- feat(cli): standalone tool keys wizard (search, media, voice, devtools)
- feat(cli): real-time API key validation with retry in setup wizard
- feat(cli): extensions search subcommand with category filter + categorized listing
- feat(cli): skills search + recommend subcommands with categorized listing
- feat(cli): `signupUrl`/`validationUrl` for LLM providers + `TOOL_KEY_PROVIDERS` constant
- feat(cli): plugins command improvements, system prompt updates
- feat: cognitive memory config and runtime updates
- feat: full agency automation — per-agent storage, tool activation, memory pipeline
- feat: personalized welcome messages with role-based suggestions
- feat(tool-calling): add `deep_research` to fallback map
- feat(discovery): `recallProfile` (`aggressive` default, `balanced`, `precision`) for discovery tuning
- feat(runtime): per-turn tool schema narrowing based on discovery results
- feat(runtime): `session.sendText({ toolSelectionMode })` override (`discovered` | `all`)
- feat(runtime): strict tool-name mode via `toolCalling.strictToolNames`
- feat(runtime): defensive API key resolution for static/lazy/async inputs

### Fixed
- fix: correct vector store query result types and remove invalid generic calls
- fix(cli): prevent partial agent folder on CTRL+C and warn on env key fallback
- fix: propagate folder-access grants to CLI executor ShellService
- fix: harden system prompt confidentiality against extraction attacks
- fix: prevent TUI ghosting when navigating back from views
- fix: add TUI agents view to prevent crash on "List agents"
- fix: prevent cross-conversation message history corruption
- fix(cli): reduce permission prompt noise — session cache + read-only fast-path
- fix(cli): reduce tool-calling verbosity — gate logs behind debug mode
- fix(runtime): inject suggestedFallbacks on empty search results + prompt guidance
- fix: hoist toolExtensions declaration above lazyTools scope
- fix: resolve TypeScript build errors in storage module
- fix: use guildMemberAdd with role polling for welcome messages
- fix(runtime): sanitize/dedupe outbound tool function names for OpenAI-compatible schemas
- fix(discovery): validate discovery embedding API keys before initialization

### Changed
- docs: comprehensive tutorials, guides, use cases, and CLI reference for docs.wunderland.sh
- docs: 5-provider LLM documentation overhaul
- docs: system prompt confidentiality section in presets guide
- docs: expanded README and LIBRARY_API.md for adaptive tool exposure

## [0.38.0] - 2025-12-XX

Previous release. See git history for details.
