# AgentOS Marketplace Integration

This document explains how marketplace listings flow from AgentOS personas through the SQL storage layer to the marketing and client surfaces that render marketplace inventory. Use it as a reference when wiring new agents, extending analytics, or exposing marketplace data to additional runtimes.

---

## 1. Data sources

> The marketplace module is optional. Self-hosted operators can disable the tables and routes below if they do not expose a public catalogue.

- **Marketplace records** - Seeded and persisted in the shared SQLite/Postgres store via the marketplace service (ackend/src/features/marketplace/marketplace.service.ts). Each record includes persona linkage, pricing metadata, visibility (public, unlisted, org, invite), lifecycle status (draft, pending, published, 
etired), ownership metadata, and optional metrics (downloads, rating, revenue).
- **AgentOS personas** - Declared under packages/agentos/src/cognitive_substrate/personas/** and exposed via the persona registry helper (ackend/src/integrations/agentos/agentos.persona-registry.ts). Approved dynamic submissions from gentos_persona_submissions are merged at runtime so every marketplace listing references a valid persona.
- **Agent runtime** – The AgentOS SQL client (`backend/src/integrations/agentos/agentos.sql-client.ts`) ensures conversation state and persona overlays share the same database. Marketplace write operations should reuse this adapter so tenant data stays in one datastore.

---

## 2. Backend surfaces

1. **Schema bootstrapping** – The marketplace service calls `ensureSchema` on first access. This creates `agentos_marketplace_agents` and relevant indexes. If you change the schema, adjust both the `CREATE TABLE` statement and the `hydrateRecord` transformer so API payloads stay in sync.
2. **Seeding logic** – `seedIfNecessary` bridges persona definitions to marketplace rows during local development. When shipping to production, replace or extend this method with an admin workflow so new agents can be published without shipping code.
3. **API routes** - `backend/src/features/marketplace/marketplace.routes.ts` exposes:
   - `GET /api/marketplace/agents` - returns the filtered list for marketing pages. Visibility defaults to `public`, but callers can request additional visibilities or statuses.
   - `GET /api/marketplace/agents/:id` - resolves single entries by marketplace or persona id.
   - `POST /api/marketplace/agents` - creates a draft or pending listing. Requires authentication; `owner_user_id` defaults to the caller.
   - `PATCH /api/marketplace/agents/:id` - updates visibility, pricing, or lifecycle status. Publishing a listing stamps `approved_at` and triggers dynamic persona reloads.
   Protect write routes with auth and rate limiting; invitations and organisation visibility rely on `owner_user_id` / `organization_id` to scope access.

---
## 2.1 Visibility & distribution

| Visibility | Who sees it? | Typical use | Notes |
|------------|--------------|-------------|-------|
| `public` | Everyone hitting `/api/marketplace/agents` | Hero listings, marketing campaigns | Returned by default. |
| `unlisted` | Anyone with the direct link | Partner pilots, soft launches | Include a signed link or workflow card. |
| `org` | Members of `organization_id` | Internal tool shelves | Attach invite flows to add members before publishing. |
| `invite` | Holders of `invite_token` | Paid or time-boxed beta access | Tokens are single-use unless you generate your own. |

Only `published` listings appear on the public grid. `pending` entries surface in reviewer dashboards, while `draft` or `retired` entries remain hidden. Update status via the `PATCH` endpoint or the admin console once the review is complete.

---

## 3. Frontend consumers

### 3.1 Marketing site (`apps/agentos.sh`)

- `components/marketplace/marketplace-preview.tsx` fetches API summaries and renders hero CTA, stat chips, and agent tiles. It falls back to `FALLBACK_AGENTS` when the API is offline so the grid never renders empty.
- CSS tokens for chips, CTA buttons, avatars, and skeleton cards live in `app/globals.css`. When introducing new class names, update both the component JSX and the stylesheet to keep hover/focus states aligned.
- The marketing docs page links to TypeDoc/REST outputs under `/docs-generated/**`. Remember to run `pnpm dev:full` (or `pnpm --filter @framers/agentos run docs`) so generated assets exist.

### 3.2 Voice client (`frontend/`)

- `src/store/marketplace.store.ts` provides a Pinia store that caches marketplace listings for the in-app agent hub.
- `src/components/agents/AgentHub.vue` and `AgentCard.vue` consume the store, rendering shimmer skeletons until `fetchAgents()` resolves. When extending card metadata (e.g., pricing tiers, session counts) ensure both the store typings and card props update together.

---

## 4. Audio, RAG, and SQL hooks

- **SQL adapter** – `createAgentOSSqlClient()` injects the storage adapter into the AgentOS config so conversation transcripts, tool invocations, and marketplace interactions share retention policy. Any custom audio or RAG state you add should respect the same adapter helper to avoid diverging persistence.
- **Audio pipeline** – Voice capture and playback flows through the Vue front-end (see `frontend/src/components/voice/` and related services) before hitting `/api/chat`. AgentOS responses stream down via SSE/WebSocket chunks; marketplace personas can opt-in to specialised voices by setting `defaultVoicePersona` in the agent registry.
- **RAG stores** – Retrieval helpers (`packages/agentos/src/rag/**`) expect a storage adapter that matches the SQL client semantics. When wiring new knowledge stores for marketplace agents, register them in the AgentOS config and surface the capability in both marketing copy and the agent detail modals.

---

## 5. Operational checklist

1. **Run docs + landing dev** – `pnpm dev:full` keeps Next.js, TypeDoc, and marketplace API responses in sync (see updated `docs:watch` script for automatic copy).
2. **Verify endpoints** – `GET /api/marketplace/agents` should return seeded entries; confirm that `/docs-generated/api/index.html` renders without a 404.
3. **Sync personas** – When adding a new marketplace agent, ensure the corresponding persona exists and exports from `listAgentOSPersonas()`.
4. **Update copy** – Landing CTAs and Vue agent hub labels should mention monetisation tier, signals, and any audio/RAG capabilities introduced in backend adapters.
5. **Review submissions** - `GET /api/agents/bundles/submissions` lists pending persona bundles. Approve via `PATCH /api/agents/bundles/submissions/:id` to materialise prompts.
6. **Verify usage logs** - `agency_usage_log` enforces weekly launch quotas and retains entries for ~18 months. Clear or archive records during compliance reviews.

Document changes alongside code whenever marketplace behaviour shifts (new pricing models, workflow triggers, etc.) so the integration stays discoverable across teams.

## 6. Bundle import/export

1. `POST /api/agents/bundles/import` - Accepts a signed bundle payload, stores it in `agentos_persona_submissions` with status `pending`, and records submitter metadata.
2. `GET /api/agents/bundles/:agentId/export` - Packages the agent configuration, approved persona prompt, and optional marketplace listing into a portable bundle.
3. `GET /api/agents/bundles/submissions` - Lists submissions for reviewers.
4. `PATCH /api/agents/bundles/submissions/:id` - Approves (`approved`) or rejects (`rejected`) a bundle. Approval writes the prompt to `prompts/_dynamic` and reloads the persona registry.

Exports should be shared over secure channels; bundles may contain proprietary prompts or pricing details. Store imports in version control or encrypted storage if they form part of your release pipeline.

---



