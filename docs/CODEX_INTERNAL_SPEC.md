# Codex Internal Service Specification

Private architecture note for the new `codex-internal` service that powers block-level summarisation, LLM classification, podcast/image generation, and plan-gated access inside Frame Codex.

> **Status**: draft implementation blueprint  
> **Owner**: framersai/codex-internal (private repo)  
> **Last updated**: 2025-11-17

---

## 1. Goals

1. Mirror the public Frame Codex (weave → loom → strand) schema while augmenting each strand with:
   - Block-level extraction (summaries, embeddings, Socratic notes).
   - Automated taxonomy/classification + “what to do with this document” routing.
   - Derived assets (podcast audio, generated images, hosted generations).
2. Provide an authenticated API (`/api/codex-internal/*`) consumed by:
   - `apps/frame.dev` (marketing + viewer, when signed in).
   - `app.frame.dev` (dashboard experience, once shipped).
   - OpenStrand / downstream apps via service tokens.
3. Gate advanced features behind the new Codex plans:
   - `codex-free` ($0) → doc-level summaries only, limited storage.
   - `codex-pro` ($9.99) → block summaries, Socratic notes, best models, hosted generations.
4. Keep implementation private. Only the interface contracts, types, and client wrappers live in `voice-chat-assistant`.

---

## 2. High-Level Architecture

```
codex-internal (Linode, private repo)
├── API layer (Fastify/Express)
│   ├── Auth middleware (JWT from api.frame.dev)
│   ├── Plan/feature guard middleware
│   └── REST + SSE endpoints
├── Ingestion workers
│   ├── GitHub fetcher (GH_PAT)
│   ├── Parser (markdown, PDF, HTML)
│   └── Block segmenter (paragraphs, code, figures)
├── AI pipelines
│   ├── Block summaries (GPT-4o or Claude 3)
│   ├── Classification/tagging (OpenStrand heuristics + LLM)
│   ├── Socratic note generator
│   ├── Image generation (SDXL / DALL·E / Ideogram)
│   └── Podcast generator (script + TTS pipeline)
├── Storage
│   ├── Postgres + pgvector (strands, blocks, embeddings)
│   ├── Object storage (Linode Object Storage / S3) for assets
│   └── Redis / QStash (task queues + idempotency)
└── Observability
    ├── OpenTelemetry traces
    ├── Structured logging (pino)
    └── Usage accounting per plan
```

### Service boundaries

| Component            | Repo                           | Visibility  | Notes                                                              |
| -------------------- | ------------------------------ | ----------- | ------------------------------------------------------------------ |
| Marketing + viewer   | `voice-chat-assistant`         | Private     | Serves static `frame.dev` + `@framers/codex-viewer`.               |
| Public Codex content | `framersai/codex`              | Public      | Content-only repo, no proprietary code.                            |
| Codex Internal API   | `framersai/codex-internal`     | **Private** | Implements ingestion, summarisation, classification, etc.          |
| API Gateway          | `voice-chat-assistant/backend` | Private     | Routes `/api/codex-internal/*` → codex-internal via service token. |

---

## 3. Data Model

### 3.1 Core tables

```mermaid
erDiagram
  STRANDS ||--o{ BLOCKS : contains
  STRANDS ||--o{ STRAND_RELATIONSHIPS : relates
  BLOCKS ||--o{ BLOCK_NOTES : has
  STRANDS ||--o{ DERIVED_ASSETS : owns

  STRANDS {
    uuid id PK
    text slug
    text weave_slug
    text loom_slug
    jsonb metadata
    jsonb auto_taxonomy
    jsonb classification
    jsonb summary
    vector(1536) embedding
    timestamptz created_at
    timestamptz updated_at
  }

  BLOCKS {
    uuid id PK
    uuid strand_id FK
    int index
    text block_type
    text content_markdown
    text content_plain
    jsonb features -- headings, list depth, etc.
    jsonb summary
    vector(1536) embedding
    bool flagged_for_review
  }

  BLOCK_NOTES {
    uuid id PK
    uuid block_id FK
    text kind -- "socratic", "todo", "insight"
    text payload_markdown
    jsonb metadata
  }

  DERIVED_ASSETS {
    uuid id PK
    uuid strand_id FK
    text asset_type -- "podcast", "image", "transcript"
    text storage_key
    jsonb metadata -- duration, prompt, model, etc.
    timestamptz expires_at
  }
```

### 3.2 Classification schema

```ts
interface StrandClassification {
  contentType: 'research-paper' | 'blog' | 'spec' | 'meeting-notes' | 'slides' | 'code' | 'other';
  confidence: number; // 0-1
  recommendedAction: 'summarise' | 'convert-to-strand' | 'podcast' | 'skip';
  sensitivity: 'public' | 'internal' | 'confidential';
  topics: string[];
  strandsToLink: string[]; // candidate related strands
}
```

Block-level summaries share the same schema but scoped to paragraphs, with additional cues like `readingLevel`, `highlightScore`, and `quoteAttribution`.

---

## 4. Pipelines

### 4.1 Ingestion

1. **Source discovery** — triggered by:
   - Manual upload via dashboard.
   - GitHub sync job (GH_PAT stored in private repo secrets).
   - API call from OpenStrand.
2. **Fetch & normalise** — convert to Markdown AST (Unified/Remark) with positional metadata.
3. **Segmentation** — break into blocks (heading+paragraph, list item, code chunk, table, figure) with heuristics tuned for existing Codex content.
4. **LLM augmentation** (batched where possible):
   - Generate block summaries (extractive; 1–2 sentences).
   - Suggest Socratic prompts per block (Pro plan only).
   - Classify entire strand (type + recommended actions + tags).
5. **Persistence** — upsert into Postgres + pgvector; push derived assets into object storage.
6. **Index refresh** — notify Algolia/OpenSearch (if used) + invalidate CDN caches.

All stages run as idempotent jobs keyed by `source_hash`. Retries happen via Redis Q with exponential backoff.

### 4.2 Podcast generation

1. **Script builder** — LLM summarises selected blocks into a narrative, keeping references.
2. **Voice selection** — per-plan defaults (Free plan uses standard TTS; Pro plan uses ElevenLabs premium voices).
3. **Synthesis** — generate chunks concurrently, stitch + normalise audio, export as `m4a` + waveform metadata.
4. **Hosting** — upload to object storage, return signed URL + asset record.

### 4.3 Image/sketch generation

- Accepts either:
  - SVG/PNG uploaded sketch.
  - Text-only prompt + optional reference strand.
- Uses ControlNet or sketch-to-image models (if available) or falls back to text-to-image.
- Returns asset record + CDN URL; metadata stores prompt, seed, model, plan used.

---

## 5. API Surface (served via api.frame.dev → codex-internal)

| Endpoint                               | Method | Description                                                              | Plan gating                            |
| -------------------------------------- | ------ | ------------------------------------------------------------------------ | -------------------------------------- |
| `/api/codex-internal/ingest`           | `POST` | Pull doc from GitHub/URL or accept file upload; queue ingestion job.     | Free+                                  |
| `/api/codex-internal/strands/:id`      | `GET`  | Return strand metadata, classification, block summaries, derived assets. | Free (doc summary) / Pro (block+notes) |
| `/api/codex-internal/blocks/:blockId`  | `GET`  | Fetch block detail + Socratic notes.                                     | Pro only                               |
| `/api/codex-internal/related`          | `POST` | Given blocks/strand, return related strands/looms.                       | Pro                                    |
| `/api/codex-internal/generate/image`   | `POST` | Generate image from sketch/prompt; returns asset.                        | Pro                                    |
| `/api/codex-internal/generate/podcast` | `POST` | Generate audio summary for strand(s).                                    | Pro                                    |
| `/api/codex-internal/export`           | `POST` | Export a loom/strand (Markdown + metadata).                              | Free+                                  |

Authentication:

- Frontend passes the same JWT issued by `/api/auth`.
- Gateway verifies plan + feature flags before proxying to codex-internal with a short-lived service token (`X-Codex-Service-Token`).

---

## 6. Plans & Feature Flags

Add two plan IDs to `packages/shared/src/planCatalog.ts`:

| Plan ID      | Price | Features                                                                                                                      |
| ------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| `codex-free` | $0    | Doc-level summaries, limited hosted storage (500 MB), no podcast/image generation.                                            |
| `codex-pro`  | $9.99 | Block-level summaries, Socratic notes, LLM classification, podcast & image generation, higher quotas (10 GB) and best models. |

Feature flags exported to the frontend:

```ts
interface CodexFeatureFlags {
  blockSummaries: boolean;
  socraticNotes: boolean;
  classification: boolean;
  podcastGeneration: boolean;
  imageGeneration: boolean;
  storageLimitGb: number;
  hostedGenerationsPerMonth: number;
}
```

These flags map to middleware checks in codex-internal (e.g., `requireFeature('podcastGeneration')`).

---

## 7. Deployment & Secrets

| Secret                                                                   | Scope                    | Notes                                                       |
| ------------------------------------------------------------------------ | ------------------------ | ----------------------------------------------------------- |
| `CODEX_INTERNAL_JWT_SECRET`                                              | codex-internal           | Signs service tokens for gateway ↔ service calls.          |
| `CODEX_INTERNAL_GH_PAT`                                                  | codex-internal           | Fetches private repositories for ingestion.                 |
| `CODEX_INTERNAL_DB_URL`                                                  | codex-internal           | Postgres (pgvector enabled).                                |
| `CODEX_INTERNAL_STORAGE_BUCKET`                                          | codex-internal           | Linode Object Storage bucket for assets.                    |
| `LEMONSQUEEZY_CODEX_PRO_PRODUCT_ID`, `LEMONSQUEEZY_CODEX_PRO_VARIANT_ID` | backend                  | Hosted checkout mapping for Codex Pro.                      |
| `STRIPE_CODEX_PRO_PRODUCT_ID`, `STRIPE_CODEX_PRO_PRICE_ID`               | backend                  | Stripe fallback for Codex Pro.                              |
| `CODEX_INTERNAL_SERVICE_TOKEN`                                           | backend + codex-internal | Shared secret for gateway to call codex-internal (rotated). |

Deployment steps:

1. Provision Linode VM / Kubernetes namespace `codex-internal`.
2. Deploy Postgres 16 + pgvector extension (or Supabase dedicated project).
3. Deploy API + workers (Docker) with horizontal autoscale on ingestion queue length.
4. Configure Cloudflare / Traefik route `api.frame.dev/codex-internal/*` → service.
5. Set up observability (Grafana Cloud or self-hosted).

---

## 8. Roadmap Checklist

- [ ] Create `framersai/codex-internal` (private) with the structure above.
- [ ] Extend `planCatalog` with `codex-free` & `codex-pro`.
- [ ] Build plan-specific pricing UI in `apps/frame.dev`.
- [ ] Implement `/api/codex-internal/*` proxy routes in `backend/server.ts`.
- [ ] Write client SDK (`packages/shared/src/codexInternalClient.ts`) for frontend consumption.
- [ ] Implement ingestion + pipeline workers (private repo).
- [ ] Ship podcast/image generation MVP.
- [ ] Add usage metering + billing hooks (webhooks update storage quotas).

---

Questions / decisions still open:

1. Final choice of podcast TTS provider (ElevenLabs vs PlayHT) → blocked on licensing review.
2. Sketch-to-image model selection (ControlNet vs ComfyUI workflow) → evaluate GPU cost.
3. Export format for block metadata (embedding vectors may need gzip/Brotli when streaming to UI).

Ping @johnn when ready to wire the new service to production.
