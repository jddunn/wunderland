# Changelog

## [Unreleased]

### Added
- feat(discovery): add `recallProfile` (`aggressive` default, `balanced`, `precision`) for capability discovery tuning.
- feat(runtime): enable per-turn tool schema narrowing based on discovery results in the library API, with safe fallback to full tool exposure.
- feat(runtime): add `session.sendText({ toolSelectionMode })` override (`discovered` | `all`).

### Changed
- docs: expanded README + `docs/LIBRARY_API.md` for adaptive tool exposure and discovery recall defaults.

