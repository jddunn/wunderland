# AgentOS Architecture

## 12. AgentOS telemetry and export parity (optional)

- `packages/agentos/src/core/workflows/runtime/WorkflowRuntime.ts` emits `WORKFLOW_UPDATE` and `AGENCY_UPDATE` chunks so clients can stream per-seat and per-workflow progress.
- The reference frontend listens for `vca:workflow-update` and `vca:agency-update` custom DOM events and persists a rolling window of updates in `frontend/src/store/agentosEvents.store.ts`. Users can export these streams as JSON from the Settings page for audits and troubleshooting.
- Hosts may persist these events server-side for long-term analytics. If you self-host, consider retention and privacy policies appropriate for your environment.

## 13. RBAC and capability gating

- Organization roles are defined as `admin`, `builder`, and `viewer`.
  - `admin`: manage organization settings, seats, roles, and invites; publish marketplace listings on behalf of the org.
  - `builder`: contribute agents and content within the org but cannot modify roles or publish publicly unless elevated.
  - `viewer`: read-only access to org content where applicable.
- Enforcement lives in the organization service (`backend/src/features/organization/organization.service.ts`) and repository. Admin-only operations include inviting/removing members, changing roles, and raising visibility of marketplace items to `public` or `published` when owned by an organization.
- Marketplace RBAC: create/update routes check org membership and require `admin` to publish or set `public` visibility (`backend/src/features/marketplace/marketplace.routes.ts`).
- UI gating: the Vue client hides team management when organizations are not supported by the current storage adapter (e.g., offline SQLite/sql.js). The platform capability is detected via `/api/system/storage-status` and exposed through `frontend/src/store/platform.store.ts`.
- Capability detection and graceful degradation: persistence, multi-tenancy, and cloud-only features are surfaced or hidden based on the active adapter (PostgreSQL for cloud, SQLite/Capacitor/sql.js for desktop/mobile/browser). See `docs/PLATFORM_FEATURE_MATRIX.md` for details.

`@framers/agentos` is the modular runtime that powers the orchestration stack inside Frame.dev products. It encapsulates persona management, tool routing, streaming, conversation memory, retrieval augmentation, and error handling behind a single TypeScript package that can be embedded in any host application (web, desktop, mobile, or server-side).

This document describes how the package is organised, the flow of an interaction, and the extension points you can use when wiring AgentOS into a host environment.

---

## 1. High-level flow

```
Host App (Express, FastAPI, desktop, etc.)
    -> creates AgentOS instance with configuration
         -> GMIManager loads personas, working memory, policies
         -> ConversationManager loads history, attaches stream client
         -> ToolOrchestrator evaluates permissions, dispatches tool calls
         -> AIModelProviderManager routes requests to providers (OpenAI, Ollama, etc.)
         -> GuardrailDispatcher evaluates input/output via the configured guardrail service
         -> StreamingManager emits structured AgentOSResponse chunks
```

Each interaction is driven through `AgentOS.processRequest(...)`, which returns an async generator of `AgentOSResponse` chunks. The host consumes those chunks to stream UI updates, guardrail metadata, tool call requests, and final completions back to the end user.

---

## 2. Module map

| Directory              | Purpose                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/`                 | Public entry points (`AgentOS`, `AgentOSOrchestrator`) and response/input types.                                                                                                                                              |
| `cognitive_substrate/` | Generalised Mind Instance (GMI) definitions: personas, working memory, GMI manager.                                                                                                                                           |
| `config/`              | Declarative configuration objects (tool orchestrator, memory lifecycle, embedding manager, etc.).                                                                                                                             |
| `core/`                | Core runtime building blocks: agents, conversation, streaming, tools, AI providers, audio utilities.                                                                                                                          |
| `core/guardrails/`     | Guardrail service contract and dispatcher helpers for input/output policy enforcement.                                                                                                                                        |
| `core/safety/`         | Operational safety primitives: `CircuitBreaker`, `CostGuard`, `StuckDetector`, `ActionDeduplicator`, `ToolExecutionGuard`. See [`packages/agentos/docs/SAFETY_PRIMITIVES.md`](../packages/agentos/docs/SAFETY_PRIMITIVES.md). |
| `logging/`             | Logger interfaces and default logger factory (pino-backed).                                                                                                                                                                   |
| `core/observability/`  | OpenTelemetry spans/metrics helpers + trace metadata helpers (opt-in).                                                                                                                                                        |
| `memory_lifecycle/`    | Policies and manager for summarising, archiving, or pruning long-term memory.                                                                                                                                                 |
| `rag/`                 | Retrieval augmentation interfaces and implementations (embedding manager, vector store, augmentor).                                                                                                                           |
| `services/`            | Adapters for host-specific services (auth, subscription, user storage).                                                                                                                                                       |
| `stubs/`               | Lightweight stubs (e.g. Prisma) for hosts that do not ship the real dependency.                                                                                                                                               |
| `utils/`               | Shared helpers (errors, UUIDs, functional utilities).                                                                                                                                                                         |
| `docs/`                | Additional package-level design notes and prompts.                                                                                                                                                                            |

All public exports are defined in `src/index.ts` and surfaced via `dist/` after running `pnpm --filter @framers/agentos build`.

---

## Local-first workbench runtime

- The `apps/agentos-workbench` package can embed AgentOS directly in the browser. When `VITE_AGENTOS_RUNTIME_MODE=local`, it:
  - Boots `@framers/agentos` with the same GMI manager, conversation manager, workflow runtime, and tool orchestrator used on the server, but swaps in an in-memory persona loader backed by the bundled JSON catalog.
  - Registers local workflow descriptors (`localWorkflowLibrary.ts`) so the Session Inspector and Workflow Overview receive real `WORKFLOW_UPDATE`/`AGENCY_UPDATE` telemetry even without a backend.
  - Shares the SQL adapter (IndexedDB ? sql.js ? memory) between Zustand slices (`sessionStore`, `secretStore`, `themeStore`) and AgentOS� `ConversationManager`, which means session timelines, guardrail traces, and seat history survive page reloads.
  - Surfaces missing API keys via the shared `extension-secrets.json` catalog before dispatching a turn; workflows/agencies declare their `metadata.requiredSecrets` so the UI can short-circuit when credentials are absent.
- Remote mode continues to proxy through `/api/agentos` (or whatever `VITE_AGENTOS_BASE_URL` specifies). Switching between modes is a `.env` toggle�no application code changes required.

---

## 3. Core concepts

### 3.1 API facade & orchestration

- **AgentOS class (`api/AgentOS.ts`)**: entry point for hosts. Handles lifecycle (`initialize`, `shutdown`), queueing requests, and delegating to the orchestrator.
- **AgentOSOrchestrator (`api/AgentOSOrchestrator.ts`)**: coordinates GMIs, conversation context, tool execution, streaming, and error handling per request.
- **AgentOSTypes**: strongly typed input (`AgentOSInput`, `GMITurnInput`, etc.) and output chunks.

### 3.2 Cognitive substrate

- **GMIManager**: creates and manages Generalised Mind Instances. Loads persona definitions, configures working memory, and enforces inactivity cleanup.
- **Personas** (`cognitive_substrate/personas`): declarative persona configs with prompt elements, tool requirements, and labels. Hosts can register new personas or override defaults.
- **Working memory implementations**: in-memory and pluggable adapters compatible with the conversation manager and memory lifecycle.

### 3.3 Conversation & memory

- **ConversationManager**: maintains conversation contexts, persists messages, and supports summarisation triggers. Works with the streaming manager to deliver incremental updates.
- **Memory lifecycle manager** (`memory_lifecycle/`): policy engine for pruning or summarising long-term memory. Supports trigger conditions (age, size, schedule) and actions (`archive`, `delete`, `summarize_and_retain`, etc.).
- **RAG stack** (`rag/`): embedding manager, vector store abstractions, and retrieval augmentor used to plug in host-provided knowledge bases.
- **MemoryStoreAdapter (generic SQL-backed persistence)**: the backend now uses a unified `MemoryStoreAdapter` (`backend/src/core/memory/MemoryStoreAdapter.ts`) powered by `@framers/sql-storage-adapter`. It auto-detects the best available driver (`better-sqlite3` first for Node performance, then `sql.js` as a pure JS fallback) and conditionally enables persistence via the `ENABLE_SQLITE_MEMORY` env flag. This replaces the old `SqliteMemoryAdapter` naming�logs and exports now use a backend-agnostic label, and future drivers (Capacitor, Supabase/Postgres) can slot in without further refactors.
- **Storage adapter bridge** _(workspace integration)_: the voice-chat backend still supplies a Prisma-compatible facade (`backend/src/integrations/agentos/agentos.sql-client.ts`) for other AgentOS modules needing relational access. Conversation persistence for chat flows prefers the MemoryStoreAdapter; the bridge remains for schema-managed tables and external integrations.
- **Knowledge base providers**: the workspace now prefers the SQL-backed knowledge service (`SqlKnowledgeBaseService`) and gracefully falls back to the legacy JSON file loader when the database is unavailable.

### 3.4 Tool orchestration

- **ToolOrchestrator** (`core/tools`): registers tools, evaluates permission policies, and executes tool calls. Works with `ToolPermissionManager` to enforce plan- or persona-based restrictions.
- **Tool executor**: default implementation that calls host-provided tool handlers; replace or extend for custom tool backends.

### 3.5 AI model routing

- **AIModelProviderManager** (`core/llm/providers`): registry of LLM providers (OpenAI, OpenRouter, Ollama, etc.) with per-provider error classes.
- **Prompt engine** (`core/llm/PromptEngine.ts`): assembles prompt components, manages token budgets, caches prompts, and integrates with optional utility AI implementations for summarisation or classification.
- **Utility AI (`core/ai_utilities`)**: optional helpers (LLM-backed, statistical) for tasks like summarisation or keyword extraction.

### 3.6 Streaming

- **StreamingManager**: manages stream registrations and emits chunks to clients (SSE, WebSocket, or in-memory bridge).
- **AgentOSResponseChunkType**: set of structured events (`SYSTEM_PROGRESS`, `TEXT_DELTA`, `TOOL_CALL_REQUEST`, `TOOL_RESULT_EMISSION`, `FINAL_RESPONSE`, `ERROR`, `UI_COMMAND`, etc.). Hosts consume these to update UI or trigger tool UIs.

### 3.7 Guardrails & policy enforcement

- **IGuardrailService (`core/guardrails/IGuardrailService.ts`)**: contract hosts implement to evaluate user input and streamed output with actions (`ALLOW`, `FLAG`, `SANITIZE`, `BLOCK`).
- **Guardrail dispatcher (`core/guardrails/guardrailDispatcher.ts`)**: now composes multiple stages. Input evaluators sanitize/block prior to orchestration; output stages inspect final chunks, with metadata recorded as arrays under `AgentOSResponse.metadata.guardrail` so downstream systems can audit the full stack of decisions.
- **ExtensionManager packs**: descriptors for guardrails can be layered. Config-supplied services are still supported, but manifests (`AgentOSConfig.extensionManifest` / `extensionOverrides`) can add or remove policy engines without touching code.
- **Guardrail context & metadata**: `GuardrailContext` carries user/session/persona identifiers and guardrail results are attached to `AgentOSResponse.metadata.guardrail` for audits or UI state.
- `AgentOSConfig.guardrailService` remains optional; the Vitest harness covers sanitize/block flows end-to-end, and extensions can stack additional stages as needed.

### 3.8 Services & adapters

- **Auth/Subscription services** (`services/user_auth`): interfaces AgentOS uses to query user identity and entitlements. Host integrations map present-day systems (Supabase, global JWT, internal billing) to these interfaces.
- **Prisma stub (`stubs/prismaClient.ts`)**: minimal implementation so TypeScript compiles even if the host does not ship the full Prisma runtime.
- **Error helpers** (`utils/errors.ts`): `GMIError`, `AgentOSServiceError`, and conversion utilities to keep error handling consistent across the stack.

---

## 4. Request lifecycle in detail

1. **Initialisation**  
   The host constructs `AgentOSConfig` (see `config/`), providing managers, adapters, and optional overrides (default provider IDs, persistence flags, streaming config, etc.). Calling `await agentos.initialize(config)` wires up the orchestrator, GMI manager, conversation/storage adapters, tool registry, and streaming manager.

2. **Processing input**  
   `agentos.processRequest(input)` returns an async generator. Each iteration yields an `AgentOSResponse` chunk. The generator resolves once `isFinal === true`.
   Requests may include `workflowRequest` to hand control to the workflow engine; when set, AgentOS starts the specified workflow and streams `WORKFLOW_UPDATE` chunks alongside the conversational response.

3. **Tool calls**  
   When the orchestrator encounters a tool request, it emits a `TOOL_CALL_REQUEST` chunk containing the tool name, arguments, and call ID. The host runs or surfaces the tool, then calls `agentos.handleToolResult(...)` to supply the result back into the turn.

4. **Streaming text**  
   Streaming providers (OpenAI, Ollama, etc.) feed deltas to the `StreamingManager`, which emits `TEXT_DELTA` chunks until the completion is finalised (`FINAL_RESPONSE`). Hosts aggregate or pipe these to clients.

5. **Memory updates**  
   After each turn the conversation manager records messages in the configured store. Memory lifecycle policies may summarise or prune entries asynchronously (triggered through the policy schedule or host invocation).

6. **Shutdown**  
   Optional `agentos.shutdown()` releases resources (stream clients, timers, working memory caches).

---

## 4. Marketplace integration

The monorepo bundles a first-party marketplace that curates AgentOS personas across the landing site and authenticated clients:

- **Data store** � Marketplace metadata lives in the shared SQL adapter (`agentos_marketplace_agents`) and links directly to persona IDs.
- **Service layer** � `backend/src/features/marketplace/marketplace.service.ts` exposes read-only endpoints (`GET /marketplace/agents`, `GET /marketplace/agents/:id`) and seeds default entries on startup.
- **Consumers** � The Vue Agent Hub, the marketing marketplace preview, and future partners fetch marketplace data and merge it with local persona definitions, falling back to static seeds if the API is unreachable.

See [`docs/MARKETPLACE.md`](./MARKETPLACE.md) for schema details and integration guidance.

---

## 5. Configuration surfaces

Key configuration types live under `src/config/`. They can be composed together when initialising AgentOS:

```ts
import {
  AgentOS,
  type AgentOSConfig,
  InMemoryWorkflowStore,
} from '@framersai/agentos';

const config: AgentOSConfig = {
  orchestratorConfig: { maxToolCallIterations: 4, enableConversationalPersistence: true },
  gmiManagerConfig: {
    personaLoaderConfig: { personaSource: './personas', loaderType: 'file_system' },
    defaultWorkingMemoryType: 'in_memory',
  },
  conversationManagerConfig: { defaultConversationContextConfig: { maxHistoryLengthMessages: 80 } },
  toolOrchestratorConfig: { orchestratorId: 'default', maxConcurrentToolCalls: 5 },
  toolPermissionManagerConfig: { strictCapabilityChecking: false },
  streamingManagerConfig: { maxConcurrentStreams: 100 },
  modelProviderManagerConfig: { providers: [/* ... */] },
  memoryLifecycleConfig: {/* optional policy set */},
  workflowEngineConfig: { maxConcurrentWorkflows: 32 },
  workflowStore: new InMemoryWorkflowStore(),

  // Auth is optional - AgentOS works without it
  authService: /* optional - from @framers/agentos-extensions/auth or custom */,
  subscriptionService: /* optional - from @framers/agentos-extensions/auth or custom */,
  guardrailService: /* optional IGuardrailService implementation */,
};

const agentos = new AgentOS();
await agentos.initialize(config);

// Or use AgentOS without any auth (100% functional!):
await agentos.initialize({
  gmiManagerConfig: { /* ... */ },
  // No authService or subscriptionService needed!
});
```

Hosts can override any subset; missing services fall back to sensible defaults (e.g., `LLMUtilityAI` is instantiated automatically if none is provided). Guardrails remain opt-in?omit `guardrailService` to skip policy checks or provide an implementation to enable sanitize/block flows.

---

## 6. Extending AgentOS

- **Adding a persona**: drop a persona definition JSON/TS file under `cognitive_substrate/personas`, or register it dynamically via `GMIManager.registerPersona`. Supply prompt templates + contextual elements; optionally define persona-specific toolsets and memory policies.
- **Adding a tool**: create a tool implementation (`core/tools/ITool`) and register it through the `ToolOrchestrator`. Define permission requirements and tool metadata so the orchestrator can surface it to clients.
- **Integrating a new LLM provider**: implement `IProvider` under `core/llm/providers/implementations`, add configuration entry to `AIModelProviderManagerConfig`.
- **Custom vector store / embedding service**: implement `IVectorStore` / `IEmbeddingManager` in `rag/implementations` and register via the config.
- **Custom memory lifecycle actions**: extend `MemoryLifecycleManager` policies with custom action handlers (e.g., export to long-term storage, call external webhook).
- **Guardrails**: implement `IGuardrailService` to enforce moderation and policy logic before orchestration executes and as final chunks stream back to the host. Reuse the dispatcher helpers to sanitize or block content and persist audit metadata.
- **Auth/billing (optional)**: Authentication and subscription management are **completely optional**. AgentOS works without any auth services. To add auth, use the `@framers/agentos-extensions/auth` extension or provide your own `IAuthService` and `ISubscriptionService` implementations. Without auth, all tools and personas are accessible by default. See [Auth Extension Examples](../packages/agentos-extensions/registry/curated/auth/examples/).

---

## 7. Integration reference

- **Backend adapters in the workspace**: see `backend/src/integrations/agentos/*` for Supabase/global auth adapters, subscription enforcement, persona registry, and streaming/chat controllers.
- **Frontend surfaces**: `apps/agentos.sh` provides the marketing/docs site, and `apps/agentos-workbench` demonstrates a local developer cockpit consuming the streaming API.
- **Plan/billing context**: `shared/planCatalog.ts` and `docs/PLANS_AND_BILLING.md` describe how subscription tiers map to persona/tool availability.
- **User-managed agents service**: `backend/src/features/agents/**` exposes CRUD + quota enforcement for `user_agents` and `user_agent_creation_log`. The Vue client uses `frontend/src/views/agents/AgentDashboard.vue`, `AgentHub.vue`, and the plan snapshot store to show remaining slots (`GET /api/plan/snapshot`) before allowing creation. Quotas, knowledge-upload caps, and premium capabilities are all sourced from the shared plan catalog feature flags (`custom-agents`, `agency-lite`, `advanced-models`).

---

## 8. Build, test, and docs

- Build: `pnpm --filter @framers/agentos build`
- Tests: `pnpm --filter @framers/agentos test` (Vitest)
- Typedoc: `pnpm --filter @framers/agentos run docs` (output in `packages/agentos/docs/api`)

Generated TypeDoc mirrors the exported surface and is the authoritative reference for method signatures and configuration objects.

---

## 9. Security & operational notes

- AgentOS does not ship persistence adapters by default�hosts must ensure conversation history, embeddings, and memory stores are secured according to their environment.
- Auth and subscription services are host-provided; ensure you surface only the minimal user identifiers required and protect secrets such as service role keys.
- Guardrail services execute inside the host trust boundary?log policy outcomes responsibly, avoid exposing sanitized payloads, and ensure blocked/sanitized text cannot be reconstructed by downstream clients.
- When running with streaming providers or tool execution, handle backpressure and cancellation (`agentos.cancelStream(streamId)`) to avoid leaking resources.

---

AgentOS is designed to be embedded in multiple surfaces�server-side APIs, desktop apps, or even mobile runtimes with JS engines. Use this document together with the TypeDoc output and integration examples to adapt the runtime to your product�s needs.

## 10. Extension roadmap & multi-agent workflows

- **Default packs**: upcoming `@framers/agentos-pack-defaults` bundles common tools (web search, fetch, calc) and guardrail integrations so hosts can opt-in without bespoke wiring.
- **Affective cognition**: mood state tracking (global/user/session) will land in core so empathy packs can rewrite prompts and responses safely.
- **Actions & automations**: planned workflow APIs will let multiple GMIs coordinate on tasks with role-based permissions, goals, and progress tracking?tying into the extension manager for scheduling and policy enforcement.

## 11. Workflow engine overview

- **Workflow descriptors** now register through the shared extension manager using the new `workflow` kind. Descriptors declare goal schemas, task graphs, role bindings, guardrail policy tags, and metadata so hosts can ship automation packs without touching core.
- **Workflow engine & store**: the upcoming runtime module (`core/workflows`) loads definitions, manages instances, and persists progress through the pluggable `IWorkflowStore` contract. An in-memory store ships by default, with optional adapters (e.g., Prisma) for durable persistence.
- **Streaming updates**: workflow progress emits `WORKFLOW_UPDATE` chunks carrying `WorkflowProgressUpdate` payloads, preserving guardrail metadata so hosts can audit multi-stage decisions.
- **Conversation optionality**: workflows may reference conversation IDs but remain independent. Workflows can be triggered by chat turns, scheduled jobs, or other services. See `docs/WORKFLOWS.md` for authoring guidelines, configuration examples, and storage notes.
  \n## Agency telemetry & marketplace pipeline (optional)\n\n- packages/agentos/src/core/workflows/runtime/WorkflowRuntime.ts now emits both WORKFLOW_UPDATE and AGENCY_UPDATE chunks so clients can stream per-seat progress.\n- ackend/src/features/agents/agencyUsage.service.ts records launches in gency_usage_log, enforces weekly plan limits, and keeps entries for approximately 18 months in the hosted reference app; you can shorten or disable this if you self-host.\n- ackend/src/features/agents/agentBundles.service.ts + gentBundles.routes.ts handle bundle import/export, queue persona submissions in gentos_persona_submissions, and refresh the runtime once approved.\n\n
