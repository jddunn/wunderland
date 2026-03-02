# Changelog

## [Unreleased]

### Added
- feat(discovery): add `recallProfile` (`aggressive` default, `balanced`, `precision`) for capability discovery tuning.
- feat(runtime): enable per-turn tool schema narrowing based on discovery results in the library API, with safe fallback to full tool exposure.
- feat(runtime): add `session.sendText({ toolSelectionMode })` override (`discovered` | `all`).
- feat(runtime): add strict tool-name mode via `toolCalling.strictToolNames` and `WUNDERLAND_STRICT_TOOL_NAMES`.
- feat(runtime): add defensive API key resolution for static/lazy/async inputs to prevent malformed auth headers.

### Changed
- docs: expanded README + `docs/LIBRARY_API.md` for adaptive tool exposure and discovery recall defaults.
- fix(runtime): sanitize/dedupe outbound tool function names for OpenAI-compatible schemas and map calls back to loaded tools.
- fix(discovery): resolve and validate discovery embedding API keys before provider initialization; degrade gracefully on invalid inputs.
