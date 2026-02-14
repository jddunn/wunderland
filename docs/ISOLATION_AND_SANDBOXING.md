# Isolation and “Sandboxing” (One VPS, Many Agents)

This repo supports running **many agents on one machine**. The core question is how much isolation you need, and what you can honestly claim.

## Definitions (Be Precise)

- **Workspace isolation:** each agent gets its own folder/workspace with path constraints. This reduces accidents, but is not a security boundary.
- **Process isolation:** separate OS processes, ideally with separate OS users, resource limits, and restricted permissions.
- **Container sandbox:** per-agent containers with Linux namespaces + cgroups + seccomp/AppArmor, plus constrained volumes and egress controls.
- **MicroVM/VM sandbox:** Firecracker/microVM or full VM per agent. Strongest isolation.

If agents share a process/user and only have “separate folders”, call it **workspace isolation**, not sandboxing.

## Recommended Isolation Ladder

### Level 0: Per-agent workspaces (lowest cost)

Use when:

- you trust the code and tools enabled,
- the agent is not “unrestricted”,
- the VPS is single-tenant (your own agents).

Controls:

- per-agent workspace directory (read/write limited)
- tool allowlists and step-up authorization
- strict timeouts and max bytes on tools

### Level 1: Per-agent OS users

Use when:

- multiple agents run on one host and you want a real permission boundary,
- you want filesystem separation without containers.

Controls:

- one Unix user per agent, separate home/work dirs
- `systemd` service per agent with `ProtectSystem=strict`, `NoNewPrivileges=yes`, `PrivateTmp=yes`, etc.
- optional `iptables` / `nftables` egress rules per user (advanced)

### Level 2: Per-agent containers (good default for managed)

Use when:

- multi-tenant managed runtime,
- any agent has filesystem/shell/browser tools enabled.

Controls:

- no host mounts by default
- only per-agent workspace mounted
- drop capabilities, run as non-root
- seccomp/AppArmor profiles
- egress through a proxy with allowlists

### Level 3: MicroVM/VM per agent (enterprise)

Use when:

- you want the strongest blast-radius limit,
- you host “unrestricted” agents for others.

Controls:

- Firecracker/microVM or dedicated VM
- per-VM network policies and secrets

## Platform Recommendation

### Indie (self-hosted runtime)

- Default to **workspace isolation + process isolation** (Level 0/1).
- Offer an “Unrestricted mode” that is opt-in, with clear warnings.
- Provide a “high-risk profile” suggestion: run those agents on a separate VPS.

### Managed (enterprise)

- Do not run “unrestricted” agents in a shared process.
- Default to **containers per agent** (Level 2).
- Offer microVM/VM isolation (Level 3) for regulated customers.

## What to Market

- If Level 0/1: say “isolated workspaces” and “guardrails”.
- If Level 2+: you can say “sandboxed” (and specify containers/microVMs).
