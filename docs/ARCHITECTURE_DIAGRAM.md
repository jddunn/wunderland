# AgentOS Architecture Diagram

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Host Application                             │
│                    (Express, FastAPI, Desktop, etc.)                 │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     @framers/agentos (Core)                          │
│                                                                       │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │   AgentOS API    │  │  GMI Manager     │  │ Tool Orchestrator│  │
│  │  (Entry Point)   │  │  (Personas)      │  │   (Execution)    │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
│                                                                       │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Conversation    │  │   Streaming      │  │  LLM Providers   │  │
│  │    Manager       │  │    Manager       │  │   (OpenAI, etc.) │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │       Extension System (interfaces only)                     │    │
│  │  - IAuthService (optional)                                   │    │
│  │  - ISubscriptionService (optional)                           │    │
│  │  - IGuardrailService (optional)                              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  NO AUTH LOGIC IN CORE - All optional via injection                  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                ┌───────────────┴───────────────┐
                │                               │
                ▼                               ▼
┌───────────────────────────────┐   ┌──────────────────────────────┐
│ @framers/agentos-extensions   │   │ @framersai/agentos-personas  │
│                               │   │                              │
│  ONE package for ALL          │   │  Separate for marketplace    │
│                               │   │                              │
│  registry/                    │   │  registry/                   │
│  ├── curated/                 │   │  ├── curated/                │
│  │   ├── auth/               │   │  │   ├── v-researcher/       │
│  │   │   ├── JWT auth        │   │  │   └── code-assistant/     │
│  │   │   └── Subscriptions   │   │  └── community/              │
│  │   ├── tools/              │   │      └── [user personas]     │
│  │   │   └── web-search/     │   │                              │
│  │   ├── guardrails/         │   └── Personas only             │
│  │   │   └── pii-redactor/   │                                  │
│  │   └── workflows/          │                                  │
│  └── community/              │                                  │
│      └── [PRs here]          │                                  │
│                               │                                  │
│  Lazy loaded as needed        │                                  │
└───────────────────────────────┘   └──────────────────────────────┘
```

---

## Extension Loading Flow

```
1. AgentOS initializes
   │
   ├─> Extension system initialized
   │   │
   │   ├─> Load from @framers/agentos-extensions
   │   │   ├─> Tools (web-search, etc.)
   │   │   ├─> Guardrails (pii-redactor, etc.)
   │   │   └─> Workflows
   │   │
   │   └─> Load from @framersai/agentos-personas
   │       ├─> Curated personas
   │       └─> Community personas
   │
   ├─> [OPTIONAL] Auth extension
   │   │
   │   ├─> JWTAuthAdapter -> IAuthService
   │   ├─> SubscriptionAdapter -> ISubscriptionService
   │   ├─> ToolPermissionProvider -> Tool access control
   │   └─> PersonaTierProvider -> Persona gating
   │
   └─> Ready for requests
```

---

## Auth Integration Points

```
┌─────────────────────────────────────────────────┐
│         AgentOS Request Lifecycle                │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  1. Guardrail Input Check (optional)             │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  2. Persona Selection                            │
│     │                                            │
│     └──> PersonaTierProvider.checkAccess()      │
│          (if subscriptionService configured)    │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  3. Tool Execution                               │
│     │                                            │
│     └──> ToolPermissionProvider.checkAccess()   │
│          (if subscriptionService configured)    │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  4. LLM Processing                               │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  5. Guardrail Output Check (optional)            │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  6. Stream Response to Client                    │
└─────────────────────────────────────────────────┘

Auth is checked at steps 2 & 3 IF services configured.
Otherwise, full access by default.
```

---

## Multi-Registry System

```
┌──────────────────────────────────────────────┐
│         MultiRegistryLoader                   │
└──────┬───────────────────────────────────────┘
       │
       ├──> npm (@framers/agentos-extensions)
       │    └─> Tools, Guardrails, Workflows, Auth
       │
       ├──> npm (@framersai/agentos-personas)
       │    └─> Personas (curated + community)
       │
       ├──> GitHub (your-org/custom-extensions)
       │    └─> Custom extensions from GitHub
       │
       ├──> File (./local-extensions)
       │    └─> Local development extensions
       │
       └──> URL (https://your-registry.com)
            └─> Self-hosted registry
```

---

## Benefits Visualized

### Before (Monolithic)

```
┌────────────────────────────┐
│    @framers/agentos        │
│                            │
│  ├─ Core Logic            │
│  ├─ Auth (baked in) ❌    │
│  ├─ Subscriptions ❌       │
│  └─ Everything coupled     │
│                            │
│  Can't use without auth    │
│  Can't swap auth provider  │
│  Can't deploy air-gapped   │
└────────────────────────────┘
```

### After (Modular)

```
┌──────────────────────┐     ┌────────────────────────┐
│  @framers/agentos    │     │ agentos-extensions     │
│                      │     │  /registry/curated/    │
│  ├─ Core Logic ✅    │◄────┤      /auth/           │
│  ├─ Interfaces       │     │                        │
│  └─ NO auth code     │     │  Optional injection    │
│                      │     │  Swappable             │
│  Works standalone    │     │  Your choice           │
└──────────────────────┘     └────────────────────────┘
```

---

## File Locations

### Core Files Modified
```
packages/agentos/src/
├── extensions/
│   ├── types.ts                    ✅ +EXTENSION_KIND_PERSONA
│   ├── RegistryConfig.ts           ✅ NEW
│   ├── MultiRegistryLoader.ts      ✅ NEW
│   └── index.ts                    ✅ Updated exports
├── core/tools/permissions/
│   └── ToolPermissionManager.ts    ✅ Auth optional
└── cognitive_substrate/
    └── GMIManager.ts               ✅ Auth optional
```

### Auth Extension
```
packages/agentos-extensions/registry/curated/auth/
├── src/                            ✅ Complete
├── tests/                          ✅ 160+ tests
├── examples/                       ✅ 5 examples
└── manifest.json                   ✅ Registry entry
```

### Personas Package
```
packages/agentos-personas/
├── package.json                    ✅ Created
├── registry.json                   ✅ Created
└── docs/                           ✅ Created
```

---

## Quick Reference

### Extension Kinds
- `tool` - Executable functions
- `guardrail` - Safety checks
- `workflow` - Multi-step processes
- `persona` - Agent personalities

### Package Scopes
- `@framers/agentos` - Core
- `@framers/agentos-extensions` - Extensions (includes auth)
- `@framersai/agentos-personas` - Personas

### Auth Patterns
1. **No auth** - Default, works out of box
2. **Auth extension** - JWT + subscriptions
3. **Custom auth** - Your implementation

---

## Documentation Files

All docs in `docs/`:
- `README_REFACTOR.md` - This file (start here)
- `EXTENSION_ARCHITECTURE_FINAL.md` - Full architecture
- `AUTH_EXTRACTION_SUMMARY.md` - Technical details
- `REFACTOR_STATUS_FINAL.md` - Implementation status
- `DOCUMENTATION_STANDARDS.md` - Writing guidelines

---

**Status:** ✅ Complete  
**Read:** Start with this file, then EXTENSION_ARCHITECTURE_FINAL.md  
**Code:** See packages/agentos-extensions/registry/curated/auth/  
**Examples:** See auth/examples/ directory


