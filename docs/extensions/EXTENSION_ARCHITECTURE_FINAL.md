# AgentOS Extension Architecture - Final Design

## The Correct Structure

```
@framers/agentos (core library)
├── NO auth/subscription logic
├── Extension infrastructure
└── Service interfaces (IAuthService, ISubscriptionService)

@framers/agentos-extensions (ONE package, ONE repo)
├── package.json (single npm package)
├── registry.json (registry of all extensions)
├── registry/
│   ├── curated/
│   │   ├── auth/                          ← Auth extension (NOT separate package!)
│   │   │   ├── manifest.json              ← Author, version, metadata
│   │   │   ├── README.md                  ← Extension-specific docs
│   │   │   ├── src/
│   │   │   │   ├── adapters/
│   │   │   │   │   ├── JWTAuthAdapter.ts
│   │   │   │   │   └── SubscriptionAdapter.ts
│   │   │   │   └── providers/
│   │   │   │       ├── ToolPermissionProvider.ts
│   │   │   │       └── PersonaTierProvider.ts
│   │   │   ├── tests/
│   │   │   └── examples/
│   │   ├── guardrails/                    ← No longer separate package!
│   │   │   ├── pii-redactor/
│   │   │   └── content-filter/
│   │   ├── tools/
│   │   │   ├── web-search/
│   │   │   └── code-execution/
│   │   └── workflows/
│   │       └── research-workflow/
│   └── community/                          ← Community PRs go here!
│       ├── your-extension/
│       └── another-extension/
└── Each extension has own manifest.json with author credits

@framersai/agentos-personas (separate repo, separate concerns)
├── package.json
├── registry.json
├── registry/
│   ├── curated/
│   │   ├── v-researcher/
│   │   ├── code-assistant/
│   │   └── creative-writer/
│   └── community/
│       └── your-persona/
└── Personas separate from tools/guardrails for marketplace
```

## Why This Design?

### ✅ One Repo, One Package

**Good:** `@framers/agentos-extensions` (single npm package)
- Community can PR into `registry/community/`
- Single version, single release
- Lazy load extensions as needed
- Each extension dir has manifest.json with author info

**Bad:** `@framersai/agentos-auth`, `@framersai/agentos-guardrails` (multiple packages)
- Hard to coordinate releases
- Community contributions fragmented
- Dependency hell
- Harder to discover extensions

### ✅ Auth as Extension, Not Extension Kind

**Correct:**
```typescript
// Auth is a SERVICE that can be provided by extensions
const authService = new JWTAuthAdapter({ ... });

await agentos.initialize({
  authService,  // ← Injected via config
  subscriptionService,
});
```

**Wrong:**
```typescript
// Don't make auth a separate extension kind!
const EXTENSION_KIND_AUTH = 'auth';  // ✗ NO!
```

**Why:** Auth is middleware/infrastructure, not a discrete capability like tools/guardrails.

### ✅ Extension Kinds Are Capabilities

- `tool` - Executable functions agents can call
- `guardrail` - Safety/policy checks
- `workflow` - Multi-step processes
- `persona` - Agent personalities

These are **capabilities** that extend what agents can do.  
Auth/subscription is **infrastructure** that gates access.

### ✅ Individual Extension Metadata

Each extension directory contains:

```json
// manifest.json
{
  "id": "com.yourname.your-extension",
  "name": "Your Extension",
  "version": "1.0.0",
  "author": {
    "name": "Your Name",
    "email": "you@example.com",
    "url": "https://your-site.com"
  },
  "description": "What your extension does",
  "provides": ["toolName1", "toolName2"],
  "keywords": ["ai", "search"],
  "verified": false
}
```

## Usage Patterns

### Core Library (No Auth)

```typescript
import { AgentOS } from '@framers/agentos';

const agentos = new AgentOS();
await agentos.initialize({
  // No auth - works perfectly fine!
});
```

### With Auth Extension

```typescript
import { AgentOS } from '@framers/agentos';
import { createAuthExtension } from '@framers/agentos-extensions/auth';

const { authService, subscriptionService } = createAuthExtension({
  jwtSecret: process.env.JWT_SECRET,
  defaultTier: 'free',
});

const agentos = new AgentOS();
await agentos.initialize({
  authService,
  subscriptionService,
});
```

### Custom Auth Provider

```typescript
import { AgentOS } from '@framers/agentos';
import type { IAuthService } from '@framers/agentos';

class MyEnterpriseSSO implements IAuthService {
  // Your custom auth logic
}

const agentos = new AgentOS();
await agentos.initialize({
  authService: new MyEnterpriseSSO(),
});
```

## Community Contributions

Contributors can add extensions via PR:

1. Create directory: `registry/community/your-extension/`
2. Add manifest.json with your credits
3. Implement extension
4. PR to `@framers/agentos-extensions`
5. After review, merged and published in next release

## Benefits

### For Core Library
- ✅ Pure orchestration logic
- ✅ No auth dependencies
- ✅ Easy to test
- ✅ Flexible deployment

### For Extension Authors
- ✅ One repo to contribute to
- ✅ Individual credits preserved
- ✅ Discoverability via registry
- ✅ Simple PR process

### For Users
- ✅ Single source for extensions
- ✅ Opt-in complexity
- ✅ Mix and match extensions
- ✅ Easy to swap providers

### For Enterprises
- ✅ Can use core without cloud dependencies
- ✅ Can substitute own auth
- ✅ Air-gapped deployments work
- ✅ Clear security boundaries

## Anti-Patterns to Avoid

### ❌ Don't create separate package per extension
```
@framersai/agentos-auth         ← NO!
@framersai/agentos-web-search   ← NO!
@framersai/agentos-pii-redactor ← NO!
```

### ❌ Don't make auth an extension kind
```typescript
export const EXTENSION_KIND_AUTH = 'auth';  ← NO!
```

### ❌ Don't mix personas with tools
```
@framers/agentos-extensions/
└── registry/curated/
    ├── tools/
    └── personas/  ← NO! Personas go in separate package
```

### ❌ Don't use unavailable npm scopes
```
@agentos/auth  ← Can't use, @agentos is taken!
```

## Next: Implementation

See `EXTENSION_SYSTEM_STATUS.md` for current progress and next steps.

---

**Approved:** 2024-11-14  
**Architecture Owner:** Frame.dev Engineering

