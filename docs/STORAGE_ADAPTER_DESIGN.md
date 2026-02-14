# Storage Adapter Abstraction

## Goals

- Provide a single storage API that works across Node (better-sqlite3), browser/pure JS (sql.js/wa-sqlite), and native Capacitor targets without forking business logic.
- Allow a prioritized resolution chain (Postgres -> native -> Capacitor -> pure JS) with graceful capability detection and logging when we fall back.
- Keep the abstraction reusable for other TypeScript packages by publishing it as `@voicechat/storage-adapter`.
- Document platform-specific requirements (toolchains, environment variables) so the team can unblock local builds quickly.

## Target Capabilities

| Capability | Description | Postgres | Native (`better-sqlite3`) | Capacitor | Pure JS (sql.js/wa-sqlite) |
| --- | --- | --- | --- | --- | --- |
| `sync` | Synchronous query execution | No | Yes | No | No |
| `transactions` | Batched operations with rollback | Yes | Yes | Yes | Yes (emulated) |
| `wal` | Write-ahead logging support | Yes | Yes | Yes | No |
| `locks` | OS file locking | Yes | Yes | Yes | No |
| `persistence` | Durable storage on restart | Yes | Yes | Yes | Optional (when persisted manually) |

The adapter exposes `capabilities: Set<StorageCapability>` so callers can feature-check and adjust behaviour (e.g., disable WAL PRAGMA when unsupported).

## Interfaces

```ts
export interface StorageAdapter {
  readonly kind: 'better-sqlite3' | 'capacitor' | 'sqljs' | string;
  readonly capabilities: ReadonlySet<StorageCapability>;

  open(options?: StorageOpenOptions): Promise<void>;
  close(): Promise<void>;

  run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult>;
  get<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T | null>;
  all<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T[]>;
  exec(script: string): Promise<void>;

  transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T>;
}
```

`StorageParameters` supports positional arrays and named objects. Each adapter normalises the parameter format before executing the underlying call.

## Resolution Strategy

`resolveStorageAdapter()` inspects:

1. `process.env.STORAGE_ADAPTER` explicit override (`better-sqlite3`, `capacitor`, `sqljs`, `supabase`, etc.).
2. `process.env.CAPACITOR_PLATFORM` / `Capacitor.isNativePlatform()` (when embedded in mobile shell).
3. Runtime availability of `better-sqlite3` (wrapped in `try/catch`).
4. Fallback to `SqlJsAdapter`.

If an adapter fails to initialise (`open()` rejects), the resolver logs a warning and tries the next candidate. The final fallback is the in-memory sql.js adapter; if that also fails, an error is thrown so the app can handle it (e.g., exit with instructions).

## Migration Plan

1. **Introduce package**: `packages/storage-adapter` with modular adapters, types, resolver, and detailed README.
2. **Convert backend DB helpers** (`appDatabase`, feature repositories, `SqliteMemoryAdapter`) to depend on the asynchronous `StorageAdapter`. Each query will become `await storage.get(...)`, etc.
3. **Capability-aware bootstrapping**: Add a helper in `appDatabase` to enable WAL/PRAGMA only when supported, otherwise skip gracefully.
4. **Environment wiring**: Add `.env` guidance (`STORAGE_ADAPTER`, `SQLJS_PERSIST_PATH`, etc.) plus platform configuration docs referencing build tool requirements for better-sqlite3.
5. **Testing**: Provide contract tests in the new package to ensure adapters pass a shared suite (basic CRUD, transactions, capability flags). Update backend unit tests to use the abstraction.

## Current Consumers

- **Application database (`backend/src/core/database/appDatabase.ts`)** – exposes `getAppDatabase()` to the rest of the backend, enabling agents, auth, billing, and marketplace features to share a single connection. The bootstrap routine now ensures the AgentOS conversation tables (`agentos_conversations`, `agentos_conversation_messages`) and marketplace catalog (`agentos_marketplace_agents`) exist.
- **AgentOS conversation persistence** – `backend/src/integrations/agentos/agentos.sql-client.ts` implements a Prisma-compatible facade that maps AgentOS persistence to the storage adapter without pulling in the full Prisma runtime.
- **Knowledge base service** – `SqlKnowledgeBaseService` stores/retrieves knowledge snippets via the adapter and gracefully falls back to the legacy JSON file service when the database is unavailable.
- **Marketplace API** – `backend/src/features/marketplace/marketplace.service.ts` reads curated persona metadata from the adapter so frontend clients consume a single source of truth.

## Future Extensions

- Add `SupabasePostgresAdapter` for cloud deployments with managed persistence.
- Support streaming/iterators if we introduce long-running analytics queries.
- Emit structured telemetry (`StorageAdapterEvent`) to central logging for easier debugging of fallback behaviour.

