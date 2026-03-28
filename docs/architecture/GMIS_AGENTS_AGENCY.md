# GMIs, Agents, and Agency

This document introduces the core mental model of AgentOS: Generalised Mind Instances (GMIs), application-facing Agents, and multi-GMI Agencies.

## Concepts

- GMIs: A GMI encapsulates persona prompts, memory policies, tool permissions, language preferences, and guardrail hooks into a reusable, versionable "mind". GMIs are portable across products and surfaces.
- Agents: Product-facing wrappers around GMIs, with UX affordances, branding, and deployment metadata. Agents map a GMI into a selectable experience in your app.
- Agencies: Coordinated sets of GMIs (and humans/tools) bound by a workflow. Agencies stream progress, enforce policies, and route tasks between participants.

## Why GMIs?

- Cohesive cognition: Keep persona, memory, tools, and policy in sync as a single unit.
- Policy-aware by design: Guardrails and entitlements are evaluated before orchestration, not as an afterthought.
- Reusable everywhere: The same GMI runs in cloud, desktop, mobile, or browser, adapting to locale and capability.
- Versioned & auditable: Export/import GMIs as JSON, capture lineage, rollback or diff their behaviour safely.

## Supported features and tools (today)

- Streaming orchestration with structured chunk types (text deltas, tool calls, artifacts, guardrail outcomes)
- Tool orchestration with capability tags, budgets, retries; packs register via extension manifests
- Guardrail dispatcher integrating host-provided IGuardrailService (allow/flag/sanitize/block)
- Conversation memory lifecycle (recency, summarisation, relevancy strategies)
- Workflow runtime emitting WORKFLOW_UPDATE and AGENCY_UPDATE telemetry
- Agency telemetry snapshots: per-seat metadata/history is stored in `WorkflowInstance.agencyState` so dashboards can replay progress even after reconnects
- Storage adapters via SQL Storage Adapter (PostgreSQL, better-sqlite3, Capacitor, sql.js)

See docs/ARCHITECTURE.md for the full module map.

## Roadmap highlights

- Multi-GMI Agencies: role-bindings, task graphs, human-in-the-loop approvals (developer preview)
- Hosted control plane: managed streams, observability, compliance, and billing integrations (roadmap)
- Pack ecosystem: curated guardrail/tool/workflow packs for common product use-cases

## Agency Streaming Endpoint

The backend now exposes `GET /api/agentos/agency/stream`, powered by the new `MultiGMIAgencyExecutor`. Provide `userId`, `conversationId`, `goal`, and a `roles` JSON array and the server will:

1. Spin up a temporary agency with one seat per role (persona).
2. Invoke AgentOS concurrently for each seat, streaming their chunks (text/tool activity) verbatim.
3. Emit synthetic `AGENCY_UPDATE` chunks as seats transition through `pending → running → completed/failed`.
4. Consolidate the seat outputs into a final `FINAL_RESPONSE` chunk that includes aggregate usage.

Use this endpoint from the workbench (or your own dashboards) to watch how multiple personas collaborate on a shared goal without writing orchestration glue.

## Licensing

- AgentOS core (`@framers/agentos`): Apache 2.0
- Reference marketplace and site components (including vca.chat integration): MIT

This split ensures you have strong patent grants and attribution for the engine while keeping the surrounding product surfaces permissive.

## HTTP endpoints (reference)

- POST /api/agentos/chat: Send a chat turn (messages, mode, optional workflow)
- GET  /api/agentos/stream: SSE stream for incremental updates (query: userId, conversationId, mode, messages, workflowRequest)
- GET  /api/agentos/personas: List personas (filters: capability, tier, search)
- GET  /api/agentos/workflows/definitions: List registered workflow definitions
- POST /api/agentos/workflows/start: Start a workflow instance

See docs/BACKEND_API.md for complete request/response shapes and examples.


