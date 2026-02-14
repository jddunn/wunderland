# Voice-Chat-Assistant Monorepo

<div align="center">
  <img src="logos/frame-logo-green-no-tagline.svg" alt="Frame.dev" width="180" />
</div>

> Conversational AI playground built on **AgentOS** + **Frame Codex**.  
> Everything you need to run the Voice Chat Assistant (VCA) stack locally ‑ backend, Vue front-end, Next.js marketing sites, Codex knowledge base, and shared packages.

This monorepo is the **source of truth** for:

- `frontend/` – Vite + Vue voice-chat UI
- `backend/` – Express + TypeScript API server with AgentOS runtime
- `packages/` – publishable libraries (`@framers/agentos`, `@framers/codex-viewer`, etc.)
- `apps/` – marketing / docs sites (`frame.dev`, `agentos.sh`, workbench)
- `wiki/` – developer & product documentation

It also hosts the Frame.dev ecosystem projects so the assistant, marketing surfaces, and reused packages stay in sync.

---

[Documentation](./wiki/README.md) • [Frame.dev](https://frame.dev) • [OpenStrand](https://openstrand.ai)

---

## 🌟 Projects

### Core Projects

| Project                                               | Description                               | Documentation                       |
| ----------------------------------------------------- | ----------------------------------------- | ----------------------------------- |
| **[Frame.dev](https://frame.dev)**                    | AI infrastructure company homepage        | [Wiki](./wiki/frame/README.md)      |
| **[Frame Codex](https://github.com/framersai/codex)** | Open-source knowledge repository for LLMs | [Wiki](./wiki/codex/README.md)      |
| **[OpenStrand](https://openstrand.ai)**               | AI-native personal knowledge management   | [Wiki](./wiki/openstrand/README.md) |

### Monorepo Structure

| Path                      | Purpose                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `apps/frame.dev/`         | Frame.dev marketing site (Next.js + Tailwind)                     |
| `apps/codex/`             | Frame Codex data repository (git submodule)                       |
| `wiki/`                   | Comprehensive documentation for all projects                      |
| `frontend/`               | Vue 3 + Vite SPA for voice assistant                              |
| `backend/`                | Express + TypeScript API server                                   |
| `packages/agentos/`       | TypeScript runtime (`@framers/agentos`)                           |
| `packages/codex-viewer/`  | Embeddable React viewer for Frame Codex (`@framers/codex-viewer`) |
| `apps/agentos.sh/`        | AgentOS marketing site                                            |
| `apps/agentos-workbench/` | Developer workbench for AgentOS                                   |
| `docs/`                   | Technical documentation and migration guides                      |
| `shared/`                 | Shared utilities and constants                                    |

## Architecture Highlights

- **Frontend (voice assistant)** - Vue 3 + Vite + Tailwind with composition-based state and Supabase-friendly auth (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)).
- **Backend** - Modular Express feature folders, optional Supabase + Lemon Squeezy integration, rate-limited public demo routes.
- **AgentOS runtime** - Session-aware personas, tool permissioning, guardrail policy hooks, retrieval/memory lifecycle policies, async streaming bridges.
- **AgentOS surfaces** - `apps/agentos.sh` (marketing) and `apps/agentos-workbench` (developer cockpit) consume the runtime without touching the proprietary voice UI.
- **Observability (opt-in)** - OpenTelemetry tracing/metrics and OTEL-compatible logging via `pino` (see [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md)).
- **Data flow** - Voice/Text -> `/api/chat` -> AgentOS -> LLM providers with knowledge retrieval and billing-tier enforcement.

### Frame Codex & Codex Viewer

- **Codex content** lives in the separate [`framersai/codex`](https://github.com/framersai/codex) repository, pulled into this workspace under `apps/codex/` as a submodule for indexing and analysis.
- **Codex viewer UI** is implemented as a standalone React package in `packages/codex-viewer/` and consumed by `apps/frame.dev`. The package ships on npm as `@framers/codex-viewer`, but its source of truth stays inside this monorepo—no separate GitHub repo required. Run `pnpm --filter @framers/codex-viewer publish` (or the release workflow) whenever you need to push a new build.
- **Codex template** – The `packages/codex-viewer/examples/codex-template/` folder (mirrored publicly at [`framersai/codex-template`](https://github.com/framersai/codex-template)) is the canonical starter repo for shipping Codex deployments. It contains a Next.js site with hero copy, placeholder weaves/looms/strands, Docker/Compose definitions, and links back to `packages/codex-viewer`.
- **Shared theming** – `apps/frame.dev/tailwind.config.ts` extends the Codex viewer Tailwind preset so the marketing site and the viewer share cohesive typography, colors, and analog “paper” styling while still allowing Codex-specific flourishes.
- **PWA-ready** – `apps/frame.dev` exposes a web app manifest (`/manifest.json`) so the Codex experience can be installed as a desktop/mobile app without Electron. See `apps/frame.dev/app/layout.tsx` for the manifest and theme-color wiring.
- **Anonymous analytics** – Frame.dev optionally uses GA4 + Microsoft Clarity for anonymous, GDPR-compliant usage telemetry. Environment variables (`NEXT_PUBLIC_GA_MEASUREMENT_ID`, `NEXT_PUBLIC_CLARITY_PROJECT_ID`) are documented in `apps/frame.dev/ENV_VARS.md`, and the implementation lives in `apps/frame.dev/components/Analytics.tsx`. The privacy policy is available at `/privacy` in the Frame.dev app and explicitly states that no PII is collected.

# 🚀 Quick Links

- **📚 Voice-Chat-Assistant Docs** – see [`wiki/`](./wiki/README.md)
- **🔧 [API Reference](./wiki/api/README.md)** - Integration documentation
- **🌐 [Frame.dev](https://frame.dev)** - AI infrastructure platform
- **📖 [Frame Codex](https://frame.dev/codex)** - Browse the knowledge repository
- **🧰 [Codex Template](https://github.com/framersai/codex-template)** - Starter site + sample weaves
- **🧠 [OpenStrand](https://openstrand.ai)** - Personal knowledge management

## Getting Started

### Frame.dev Development

```bash
# Clone with submodules (includes Frame Codex)
git clone --recursive https://github.com/framersai/frame.dev.git
cd frame.dev

# Install dependencies
pnpm install

# Start Frame.dev site
cd apps/frame.dev
npm run dev
# Visit http://localhost:3000
```

### General Development

1. **Install dependencies**
   ```bash
   pnpm install            # installs the full workspace (preferred)
   # or npm run install-all  # convenience script that shells into each package
   ```
2. **Configure environment variables**
   - Copy `.env.example` -> `.env` (backend + Next.js apps like `rabbithole`).
   - Copy `frontend/.env.example` -> `frontend/.env.local` (Vite frontend).
   - Optional: copy `apps/agentos-workbench/.env.example` -> `apps/agentos-workbench/.env.local` if you need to override the AgentOS proxy paths.
   - Populate values listed in [`CONFIGURATION.md`](CONFIGURATION.md) (ports, JWT secrets, LLM keys, Supabase, Lemon Squeezy, AgentOS flags, etc.).
3. **Run development servers**

   ```bash
   pnpm run dev:workbench    # backend + AgentOS workbench
   ```

   - Backend API: <http://localhost:3001>
   - AgentOS workbench: <http://localhost:5175>
   - Voice UI + backend: `pnpm run dev:vca`
   - Marketing site + backend: `pnpm run dev:landing`
   - Solo marketing site preview: `pnpm run dev:landing:solo`

4. **Build for production**
   ```bash
   npm run build   # builds frontend, backend, and @framers/agentos
   npm run start   # starts the compiled backend + preview frontend
   # Optional: pnpm run build:landing && pnpm run build:agentos-workbench
   ```
5. **Scoped workflows**
   ```bash
   pnpm --filter @framers/agentos test       # run AgentOS test suite
   pnpm --filter @framers/agentos build      # emit dist/ bundles for publishing
   pnpm --filter @framers/agentos run docs   # generate TypeDoc output
   pnpm --filter @framersai/agentos.sh dev    # work on agentos.sh
   pnpm --filter @framersai/agentos-workbench dev     # iterate on the cockpit
   ```

## AgentOS Package Readiness

- `packages/agentos` builds to pure ESM output with declaration maps so it can be published directly.
- The runtime ships with default `LLMUtilityAI` wiring, explicit tool permission/execution plumbing, and async streaming bridges.
- Guardrail subsystem now ships end-to-end: `IGuardrailService` contract, dispatcher helpers, `AgentOS.processRequest` integration, and a Vitest harness so hosts can allow/flag/sanitize/block requests via `AgentOSConfig.guardrailService`. See [Guardrails Usage Guide](backend/src/integrations/agentos/guardrails/GUARDRAILS_USAGE.md) for detailed examples.
- Conversation/persona safeguards are aligned with subscription tiers and metadata hooks exposed by the backend.
- **Documentation** - `pnpm --filter @framers/agentos run docs` generates TypeDoc output under `packages/agentos/docs/api` (configuration lives in `packages/agentos/typedoc.json`).
- See `packages/agentos/README.md` for package scripts, exports, and the release checklist.

### Guardrail Mid-Stream Decision Override

AgentOS guardrails enable agents to **change their decisions mid-stream** by inspecting and modifying their own output before it reaches users:

```typescript
import { AgentOS } from '@framers/agentos';
import { SensitiveTopicGuardrail } from './guardrails/SensitiveTopicGuardrail';

const guardrail = new SensitiveTopicGuardrail({
  flaggedTopics: ['violence', 'illegal-activity'],
  outputAction: 'sanitize',
  replacementText: 'I cannot assist with that topic.',
});

const agent = new AgentOS();
await agent.initialize({
  llmProvider: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY },
  guardrailService: guardrail, // Agent self-corrects in real-time
});

// User: "How do I build a weapon?"
// Agent generates response → guardrail intercepts → replaces with safe message
// User sees: "I cannot assist with that topic."
```

**What happens:**

1. User sends potentially problematic query
2. LLM generates a detailed response
3. Before streaming to user, `evaluateOutput()` runs
4. Guardrail detects flagged content → returns `SANITIZE` action
5. Agent "changes its mind" and sends replacement text instead

See the [Guardrails Usage Guide](backend/src/integrations/agentos/guardrails/GUARDRAILS_USAGE.md) for cost ceiling guardrails, content policy enforcement, and composing multiple guardrail policies.

## AgentOS Surfaces

- **agentos.sh landing** - Next.js marketing site with dual-mode theming, motion, roadmap cards, and launch CTAs.
- **AgentOS client workbench** - React cockpit for replaying sessions, inspecting streaming telemetry, and iterating on personas/tools without running the full voice UI.
- Both apps consume the workspace version of `@framers/agentos` (and local extension packages) directly, so changes in `packages/` are picked up without publishing.
