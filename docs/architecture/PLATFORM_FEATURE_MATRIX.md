# Platform Feature Matrix

This document describes how features degrade or elevate across our supported runtimes, grounded in the SQL Storage Adapter’s capability model and AgentOS integration.

## Runtimes

- Cloud (PostgreSQL)
- Desktop (Electron, better-sqlite3)
- Mobile (Capacitor SQLite)
- Browser/Edge (sql.js fallback)

## Adapter Resolution Summary

- Explicit: `STORAGE_ADAPTER=postgres|better-sqlite3|capacitor|sqljs`
- Cloud: prefer `postgres` when `DATABASE_URL` is present
- Desktop: prefer `better-sqlite3`, fallback to `sqljs`
- Mobile: prefer `capacitor`, fallback to `sqljs`

## Feature Matrix

| Feature | Cloud (Postgres) | Electron (better-sqlite3) | Mobile (Capacitor) | Browser (sql.js) |
| --- | --- | --- | --- | --- |
| Persistence | ✅ durable | ✅ local file | ✅ on-device | ⚠️ manual (export/import) |
| Concurrency | ✅ pooled | ❌ single-writer | ❌ single-connection | ❌ single-threaded |
| Transactions | ✅ | ✅ | ✅ | ✅ |
| WAL/Locks | ❌ | ✅ | ✅ | ❌ |
| JSON/Arrays | ✅ native | ❌ | ❌ | ❌ |
| Prepared statements | ✅ | ✅ | ❌ | ❌ |
| Streaming large results | 🚧 | 🚧 | ❌ | ❌ |
| Cloud backups | ✅ S3/R2 | ✅ optional | ✅ optional | ⚠️ export only |
| Multi-tenant orgs | ✅ | ❌ | ❌ | ❌ |
| Marketplace (server) | ✅ | ⚠️ read-only (local) | ⚠️ read-only (local) | ⚠️ disabled |
| Billing (Lemon) | ✅ | ❌ | ❌ | ❌ |

Notes:
- sql.js requires explicit export/import to persist; no file locking or native extensions.
- Mobile adapter supports WAL and background tasks but is bounded by platform lifecycle rules.

## UX/Feature Gating Rules

- Organizations & invites: show only when adapter.kind === `postgres`.
- Billing/subscriptions: show only in cloud mode with billing configured; otherwise display hint-only.
- Marketplace: allow browsing everywhere; restrict publishing/owner org actions to cloud.
- Backup UX:
  - Cloud: status + on-demand backup/restore allowed.
  - Desktop/Mobile: local backup/export; show cloud backup if credentials configured.
  - Browser: export/import only.

## Detection

Backend exposes `/api/system/storage-status`:
- `{ kind: 'postgres'|'better-sqlite3'|'capacitor'|'sqljs', capabilities: string[], persistence: boolean }`
- Frontend consumes to gate UI.

## AgentOS Guidance

- Default to `createDatabase()` in AgentOS services; prefer cloud `postgres` in SaaS.
- Enable capability-aware code paths (e.g., JSON operators only on Postgres).


