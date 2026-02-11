# OpenClaw Parity Notes

This document tracks the parts of OpenClaw that Wunderland intentionally matches (or exceeds) for **security posture**, **tool calling**, and **extensibility**.

OpenClaw and Wunderland are different products:

- **OpenClaw** is a long-running personal assistant with a Gateway control plane, many channel adapters, and a mature local approvals/allowlist workflow.
- **Wunderland** is an AgentOS-based SDK + CLI for building agents ("Wunderbots") with strong defaults around personality + guardrails.

This parity list focuses on the overlap areas that matter for safe agent execution.

## Prompt Injection Defenses

### Untrusted tool output boundaries (parity)

- Implemented in the Wunderland CLI tool-calling loop.
- Tool outputs are wrapped as untrusted content by default, with marker sanitization to prevent nested-marker injection.

Config:

- `agent.config.json`: `security.wrapToolOutputs` (default `true`, except `dangerous` tier)

Markers:

- `<<<TOOL_OUTPUT_UNTRUSTED>>>` ... `<<<END_TOOL_OUTPUT_UNTRUSTED>>>`

Reference:

- `packages/wunderland/src/cli/openai/tool-calling.ts`

## Human In The Loop (HITL) + Approvals

### Step-up authorization tiers (parity)

Wunderland uses a 3-tier model similar in spirit to OpenClaw:

- Tier 1: auto
- Tier 2: async-review queue
- Tier 3: synchronous approval

Reference:

- `packages/wunderland/src/authorization/StepUpAuthorizationManager.ts`

### CLI execution modes (Wunderland-specific)

Wunderland adds an explicit `executionMode` that controls when approvals are requested:

- `autonomous`: auto-approve all tool calls
- `human-dangerous`: approve Tier 3 only
- `human-all`: approve every tool call

Notes:

- `wunderland chat` is interactive and can prompt for approvals.
- `wunderland start` exposes HITL over HTTP (`/hitl`, `/hitl/stream`, approvals endpoints). Tier 3 tool calls pause until an operator approves/rejects, unless you opt into `--yes` / `--dangerously-skip-permissions` (fully autonomous).
- Optional: `hitl.turnApprovalMode` adds per-round checkpoints ("human after each turn") for multi-step tool loops.

Reference:

- `packages/wunderland/src/cli/security/runtime-policy.ts`
- `packages/wunderland/src/cli/commands/chat.ts`
- `packages/wunderland/src/cli/commands/start.ts`

## Filesystem + Command Guardrails

### Folder permissions + SafeGuardrails (parity)

- Filesystem-affecting tools are checked against folder permission rules (glob patterns).
- Shell execution is also checked using conservative path extraction.
- Violations are audit-logged and can trigger notifications.

Reference:

- `packages/wunderland/src/security/SafeGuardrails.ts`
- `packages/wunderland/src/security/FolderPermissions.ts`

## Extensions + Skills (AgentOS parity)

### Extension packs (parity)

Wunderland loads AgentOS extensions from the curated registry and supports modern manifests that provide `packs[].factory()`.

- Registry: `@framers/agentos-extensions-registry`
- CLI commands: `wunderland extensions list|info|enable|disable`

Reference:

- `packages/wunderland/src/cli/commands/extensions.ts`
- `packages/wunderland/src/cli/commands/start.ts`
- `packages/wunderland/src/cli/commands/chat.ts`

### Secret resolution (Wunderland CLI convenience)

- Extensions request secrets by id (example: `twilio.accountSid`).
- The CLI resolves secrets from `agent.config.json` (`secrets.{id}`) or environment variables.
- Secret ids map to env vars via normalization (example: `twilio.accountSid` -> `TWILIO_ACCOUNT_SID`).

Reference:

- `packages/wunderland/src/cli/security/env-secrets.ts`

### Skill registry (parity)

- Wunderland re-exports the AgentOS `SkillRegistry`.
- CLI skill management is available via `wunderland skills`.

Reference:

- `packages/wunderland/src/skills/index.ts`
- `packages/wunderland/src/cli/commands/skills.ts`

## Known Gaps vs OpenClaw (Intentional)

These are OpenClaw features that are not currently goals for Wunderland parity in the CLI runtime:

- Gateway daemon/control plane, sessions/presence UI, and channel-specific pairing workflows.
- Per-command exec allowlist file + socket-based approvals (OpenClaw `exec-approvals.json`).

Wunderland leans on:

- Permission sets + tool access profiles + SafeGuardrails for capability control.
- Explicit `executionMode` for approvals policy.
- AgentOS extensions registry for channels/tools integrations.
