# Wunderland (OpenClaw Fork) Plan

Wunderland is a security-first, personality-driven fork of OpenClaw built on AgentOS.

Core idea:

- **Rabbit Hole** = control plane (dashboard, agent builder, configs, audit, registry browsing).
- **Runtime** = runs on the user’s VPS by default (one machine, many agents).
- **Enterprise** = managed runtime option with stronger isolation (contact sales).

## Product Principles

- **Indie-first:** self-hosted runtime is the default path.
- **Security is a feature:** prompt-injection defenses + tool safety are first-class.
- **Personality matters:** agents have stable behavioral “contracts” (HEXACO + presets).
- **Accessible by default:** keyboard-friendly UI, readable typography, reduced motion options.
- **Curated ecosystem:** extensions/skills come from official registries only.

## Architecture (MVP)

### Control Plane (Rabbit Hole)

- Agent creation from **voice/text description** → extracted config.
- Hosting mode per agent:
  - `self_hosted` (default): stored + configurable, not executed on shared runtime.
  - `managed` (enterprise): executed on managed runtime with restricted toolset.
- Config export for runtime (downloadable artifacts).
- Audit log of config changes and capability enablement.

### Runtime (Self-Hosted)

- One VPS runs many agents.
- Secrets live in VPS `.env` / secret manager, not in control plane.
- Recommended outbound-only channel modes:
  - Telegram long polling
  - Slack Socket Mode
  - Discord gateway

### Registries

- Skills: `agentos-skills-registry` (official).
- Extensions: `agentos-extensions-registry` (official).
- No arbitrary third-party packs in managed mode.

## Prompt Injection Strategy

Ship two layers:

1. **Library-level (per agent runtime):** guardrails, tool allowlists, step-up auth, tainting of tool output.
2. **Server-level (managed runtime + shared services):** egress proxy, centralized LLM gateway, DLP/redaction, audited operations.

See `docs/PROMPT_INJECTION_DEFENSES.md`.

## Isolation Strategy

- Self-hosted: workspace isolation + process isolation as a baseline, with clear “unrestricted” warnings.
- Enterprise managed: per-agent containers (default), microVM/VM as an upsell for regulated customers.

See `docs/ISOLATION_AND_SANDBOXING.md`.

## Deployment (AWS-First, Provider-Agnostic Design)

### Indie MVP

- “One command” installer:
  - provisions a runtime folder
  - writes `.env`
  - launches Docker Compose
- Optional: “Launch on AWS” CloudFormation template for a small EC2 instance with Docker.

### Enterprise

- Dedicated VPC/VPS runtime with private networking and stronger isolation.
- SSO/SAML + org controls.

## Accessibility Workstream (Quick Wins)

- Global “Reduced motion” toggle (prefers-reduced-motion).
- Improve focus rings and keyboard navigation in dashboard forms.
- Ensure all buttons/toggles have `aria-label`s and visible labels.
- Validate color contrast on key pages (agent builder, dashboard, runtime guide).

## Go-To-Market (Indie Hackers)

Positioning:

- “A secure agent runtime you can actually ship. Self-host by default.”
- “Prompt injection defenses and tool safety, built-in.”
- “Personality you can tune and rely on.”

Launch wedge:

- A “deploy your agent from a description” demo (voice → config → Docker Compose).
- Outbound-only channel story (no public ingress required).

Channels:

- Indie Hackers, Hacker News “Show HN”, Reddit (self-hosted, devops, automation)
- short demos on X/YouTube
- open-source GitHub template: “agent in 5 minutes” with hard security defaults

Pricing recommendation:

- Indie: control plane subscription (cheap), runtime self-hosted.
- Enterprise: managed runtime + isolation + SLAs (contact).
