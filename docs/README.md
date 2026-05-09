# Documentation Index

This directory contains all Wunderland package documentation, organized into the following sections.

## Source layout (since 0.72.0)

`packages/wunderland/src/` is organized into 9 themed top-level directories:

| Directory | Purpose |
|---|---|
| `agents/` | How agents are defined and built (presets, builder, prompts, lifecycle) |
| `runtime/` | Turn loop, tool dispatch, agentos bridge (execution, identity, tools, compaction, inference, agentos-bridge) |
| `memory/` | Persistent memory layer over agentos cognitive memory (initialization, retrieval, auto-ingest, rag, storage) |
| `channels/` | How agents reach the world (chat, discord, voice, browser, api, pairing) |
| `autonomy/` | The autonomous behavior loop (jobs, social, scheduling, orchestration) |
| `security/` | 5-tier prompt-injection defense stack |
| `platform/` | Production infrastructure (observability, discovery, extensions, config) |
| `cli/` | Zero-config CLI (front door for `wunderland create "..."`) |
| `types/` | Cross-cutting type definitions |

The `index.ts` and `public/` directories define the public API. The `package.json` `exports` field exposes 3 subpaths: `.`, `./api`, `./discovery`. Everything else is internal. See [CHANGELOG.md](../CHANGELOG.md) `## 0.72.0` for the migration table from the previous layout.

## Sections

### [architecture/](architecture/)

System design documents, architecture diagrams, and API references. Covers the AgentOS core runtime, NestJS backend, GMI/Agent/Agency model, multi-agent collaboration, streaming vs queue execution, multilingual architecture, client storage and exports, platform feature matrix, and UX availability rules.

### [deployment/](deployment/)

Release processes, CI/CD automation, and infrastructure setup. Covers npm package releasing (semantic-release workflows), IPFS node provisioning, release automation, and AgentOS-specific release procedures.

### [extensions/](extensions/)

Extension system architecture, standards, and guides. Covers the final extension architecture design, auth extraction, marketplace integration, and extension refactoring plans.

### [features/](features/)

Feature descriptions and capability guides. Covers agent creation, design system, channel integrations, language detection, multilingual providers, LLM provider setup, local LLM (Ollama) setup, prompt profiles/presets, permissions, observability, plans/billing, TTS optimization, workflows, email intelligence, guardrails, reactive state system, jobs system, storage adapter design, OpenClaw parity, and the library API.

### [getting-started/](getting-started/)

Onboarding, contributing guidelines, documentation standards, and CLI/TUI guide.

### [security/](security/)

Security architecture and threat modeling. Covers isolation and sandboxing strategies, prompt injection defenses, and role-based access control (RBAC).

### [internal/](internal/)

Development diary, audits, TODOs, verification checklists, integration notes, release notes, and implementation summaries. Covers architecture audit, design system audit, social network audit, Wunderland integration audit, GMI integration TODO, evals harness demo, jobs implementation summary, Codex validation guide, landing page implementation notes, and v0.1.0 release notes.

### [legacy/](legacy/)

Outdated documents referencing superseded systems (Codex specs, OpenStrand progress, old SaaS starter, Supabase/Stripe setup, Rabbithole brand guide). Retained for historical reference.

### [moods/](moods/)

SVG mood visualizations from development sessions.
