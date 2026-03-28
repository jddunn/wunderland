# AgentOS Client: Local Storage, Export, and Import

This client stores your data locally in your browser using IndexedDB (via `@framers/sql-storage-adapter`). Nothing is written to the server unless you explicitly send requests to backend endpoints.

## SQL-backed persistence

- All Zustand slices that previously used `localStorage` (`sessionStore`, `secretStore`, and `themeStore`) now hydrate through `sqlStateStorage`, a tiny wrapper around the shared SQL adapter. This keeps large persona/agency payloads off the main thread and makes exports deterministic.
- The embedded AgentOS runtime reuses the same adapter for conversation context, workflow snapshots, and guardrail/seat telemetry. When you reload the tab the local runtime rehydrates conversations from the browser database before resuming streams.
- The adapter automatically picks IndexedDB in browsers (falls back to sql.js/memory). You do not need to provision anything; the database file lives entirely inside the browser sandbox.

## What is stored locally

- Personas (remote + local entries)
- Agencies (your local definitions)
- Sessions (timeline events per session)
- Secrets/API keys (encrypted at rest inside IndexedDB—exporting redacts them unless you opt in)
- Conversation/workflow telemetry emitted by the embedded AgentOS runtime

## Export options

- Per-session export: in the Session timeline header use “Export session”, “Export agency”, and “Export workflow”.
- Full export: Settings → Data → “Export all” (or the “Export all” button in the Session timeline). Produces a JSON bundle with personas, agencies, and sessions.

## Import

- Use Settings → Data → “Import…”.
- Accepted schema: `agentos-workbench-export-v1` (produced by this client). Personas, agencies, and sessions are merged into your local store.

## Clear storage

- Settings → Data → “Clear storage” wipes local IndexedDB. Export before clearing if needed.

## Notes

- Session state is local and persistent between reloads. You can delete individual sessions or clear all.
- The SQL database file is namespaced per browser profile. Clearing site data or using the “Clear storage” action wipes it.
- The server’s AgentOS APIs don’t receive your local library unless you export and move data manually.
- The export format is versioned; future clients can add migrations.

