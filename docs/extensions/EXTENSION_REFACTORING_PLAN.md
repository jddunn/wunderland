# AgentOS Extension System Refactoring Plan

## Executive Summary

This document outlines the comprehensive refactoring of AgentOS to extract auth/subscription logic into an extension, consolidate guardrails, create a unified extension registry system, and prepare for a separate personas marketplace.

## Current State Analysis

###Auth/Subscription Integration Points

**Core AgentOS (`packages/agentos/`):**
- `src/services/user_auth/AuthService.ts` - Auth service interface/implementation
- `src/services/user_auth/SubscriptionService.ts` - Subscription tier management
- `src/services/user_auth/types.ts` - IAuthService, ISubscriptionService interfaces
- `src/core/tools/permissions/ToolPermissionManager.ts` - Checks subscription tiers for tool access
- `src/cognitive_substrate/GMIManager.ts` - Checks persona tier requirements
- `src/config/AgentOSConfig.ts` - Wires auth/subscription services

**Backend (`backend/`):**
- `middleware/auth.ts` - Express auth middleware
- `middleware/optionalAuth.ts` - Optional auth middleware
- `src/features/auth/` - Auth routes, services, Supabase integration
- `src/integrations/agentos/agentos.auth-service.ts` - AgentOS auth adapter

### Guardrails

**Current State:**
- `packages/agentos-guardrails/` - Separate package with registry
- `packages/agentos/src/core/guardrails/` - Core guardrail interfaces
- Guardrails are already supported in extension system via `ExtensionKind`

### Extension System

**Current Capabilities:**
- `packages/agentos/src/extensions/` - ExtensionManager, ExtensionLoader, ExtensionRegistry
- Supports: tools, guardrails, workflows, response-processors
- Can load from factories, npm packages, git repos
- `packages/agentos-extensions/` - Community registry

### Personas

**Current State:**
- `packages/agentos/src/cognitive_substrate/personas/` - Core persona system
- PersonaLoader interface supports pluggable sources
- No separate marketplace yet

---

## Target Architecture

### 1. Extension Registry System

```
@framers/agentos (core)
├── Extension infrastructure (stays)
├── NO auth/subscription logic
└── Capability-based design (injected via extensions)

@framers/agentos-extensions (ONE package, ONE repo)
├── registry.json                        # Registry of all extensions
├── registry/
│   ├── curated/
│   │   ├── auth/                       # Auth extension (NOT separate package)
│   │   │   ├── manifest.json
│   │   │   ├── README.md
│   │   │   ├── src/
│   │   │   ├── tests/
│   │   │   └── examples/
│   │   ├── guardrails/                 # Guardrails (migrated)
│   │   │   ├── pii-redactor/
│   │   │   └── content-filter/
│   │   ├── tools/
│   │   │   └── web-search/
│   │   └── workflows/
│   └── community/                       # Community PRs go here
└── Each extension has its own docs/credits/package.json

@framersai/agentos-personas (separate repo/package)
├── registry.json
├── registry/
│   ├── curated/
│   │   ├── v-researcher/
│   │   └── code-assistant/
│   └── community/
└── Each persona has its own manifest
```

**Key Design Principles:**
1. Auth is just another extension in the registry, NOT a separate npm package
2. One repo (`agentos-extensions`), one npm package (`@framers/agentos-extensions`)
3. Community can PR new extensions into `registry/community/`
4. Each extension dir has its own README, manifest.json, author credits
5. Lazy load extensions from the main package
6. Personas in separate repo for marketplace/curation separation


### 2. Registry Configuration

```typescript
interface RegistryConfig {
  sources: {
    extensions?: RegistrySource;
    personas?: RegistrySource;
    guardrails?: RegistrySource; // Legacy support
    tools?: RegistrySource;
  };
  defaults: {
    extensionsRegistry: string; // "@framersai/agentos-extensions"
    personasRegistry: string;   // "@framersai/agentos-personas"
  };
}

interface RegistrySource {
  type: 'npm' | 'github' | 'git' | 'file';
  location: string;
  branch?: string;
  cache?: boolean;
}
```

### 3. Extension Kinds

Expand supported extension kinds:

```typescript
export const EXTENSION_KIND_TOOL = 'tool';
export const EXTENSION_KIND_GUARDRAIL = 'guardrail';
export const EXTENSION_KIND_WORKFLOW = 'workflow';
export const EXTENSION_KIND_RESPONSE_PROCESSOR = 'response-processor';
export const EXTENSION_KIND_AUTH = 'auth';           // NEW
export const EXTENSION_KIND_MIDDLEWARE = 'middleware'; // NEW
export const EXTENSION_KIND_PERSONA = 'persona';      // NEW
```

---

## Implementation Plan

### Phase 1: Design & Interfaces (2-3 days)

#### 1.1 Design Auth Extension Interface
```typescript
// packages/agentos/src/extensions/types.ts
export interface AuthMiddlewarePayload {
  authenticate(context: AuthContext): Promise<AuthResult>;
  checkPermission(context: PermissionContext): Promise<PermissionResult>;
}

export interface SubscriptionMiddlewarePayload {
  getUserTier(userId: string): Promise<ISubscriptionTier | null>;
  checkFeatureAccess(userId: string, feature: string): Promise<boolean>;
}

export type AuthDescriptor = ExtensionDescriptor<AuthMiddlewarePayload> & {
  kind: typeof EXTENSION_KIND_AUTH;
};
```

#### 1.2 Design Persona Registry Interface
```typescript
export interface PersonaRegistryConfig {
  sources: PersonaSource[];
  cacheDuration?: number;
  allowCommunity?: boolean;
}

export interface PersonaSource {
  type: 'github' | 'npm' | 'file';
  location: string;
  verified?: boolean;
}
```

#### 1.3 Design Multi-Registry Loader
```typescript
export interface MultiRegistryConfig {
  registries: {
    [key: string]: RegistrySource;
  };
  resolver?: (kind: ExtensionKind) => string; // Which registry for which kind
}
```

### Phase 2: Extract Auth into Extension (3-5 days)

#### 2.1 Create `@framersai/agentos-auth` Package
```
packages/agentos-auth/
├── package.json
├── README.md
├── src/
│   ├── index.ts                       # Main export
│   ├── AuthExtension.ts               # Auth middleware extension
│   ├── SubscriptionExtension.ts       # Subscription middleware
│   ├── adapters/
│   │   ├── JWTAuthAdapter.ts
│   │   ├── SupabaseAuthAdapter.ts
│   │   └── index.ts
│   ├── permissions/
│   │   ├── ToolPermissionProvider.ts
│   │   └── PersonaTierProvider.ts
│   └── types.ts
├── tests/
│   ├── auth-extension.test.ts
│   ├── subscription-extension.test.ts
│   └── integration.test.ts
├── docs/
│   ├── README.md
│   ├── API.md
│   └── MIGRATION_GUIDE.md
└── examples/
    ├── basic-auth.ts
    ├── supabase-integration.ts
    └── custom-auth-provider.ts
```

#### 2.2 Extract Auth Logic
- Move `packages/agentos/src/services/user_auth/` → `@framersai/agentos-auth/src/`
- Keep interfaces in core AgentOS as contracts
- Implement auth as extension middleware

#### 2.3 Update Core AgentOS
- Remove auth service implementations
- Keep interfaces for dependency injection
- Add auth extension loader hooks
- Make tool permission/persona tier checks pluggable

### Phase 3: Consolidate Guardrails (2-3 days)

#### 3.1 Migrate Guardrails to Extensions Registry
```bash
# Move guardrails into extensions
packages/agentos-guardrails/registry/curated/
  → packages/agentos-extensions/registry/curated/guardrails/
```

#### 3.2 Update Extension Registry
- Add guardrails category to `agentos-extensions/registry.json`
- Migrate all guardrail templates
- Update documentation

#### 3.3 Remove Guardrails Package
- Delete `packages/agentos-guardrails/`
- Update all imports
- Update workspace configuration

### Phase 4: Unified Extension Loader (3-4 days)

#### 4.1 Multi-Registry Support
```typescript
// packages/agentos/src/extensions/MultiRegistryLoader.ts
export class MultiRegistryLoader {
  private registries: Map<string, RegistryClient>;
  
  async loadFromRegistry(
    registryName: string,
    extensionId: string
  ): Promise<ExtensionPack | null>;
  
  async loadFromGitHub(
    repo: string,
    path: string,
    branch?: string
  ): Promise<ExtensionPack | null>;
  
  async resolveRegistry(kind: ExtensionKind): string;
}
```

#### 4.2 Persona Registry System
```typescript
// packages/agentos/src/extensions/PersonaRegistry.ts
export class PersonaRegistry {
  private sources: PersonaSource[];
  
  async loadPersonas(): Promise<IPersonaDefinition[]>;
  async loadPersona(id: string): Promise<IPersonaDefinition | null>;
  async refreshFromSource(source: PersonaSource): Promise<void>;
}
```

#### 4.3 Update ExtensionLoader
- Add support for multiple registries
- Add GitHub direct loading
- Add caching layer
- Add verification system

### Phase 5: Create Personas Package Structure (2-3 days)

#### 5.1 Create Package Structure
```
packages/agentos-personas/
├── package.json
├── README.md
├── registry.json
├── registry/
│   ├── curated/
│   │   ├── v_researcher/
│   │   ├── code_assistant/
│   │   └── ...
│   └── community/
│       └── ...
├── templates/
│   └── persona-template/
├── docs/
│   ├── CREATING_PERSONAS.md
│   ├── MARKETPLACE.md
│   └── API.md
└── scripts/
    ├── create-persona.js
    └── update-registry.js
```

#### 5.2 Migrate Existing Personas
- Copy personas from `packages/agentos/src/cognitive_substrate/personas/definitions/`
- Update persona loader to support registry
- Add marketplace metadata

### Phase 6: Testing & Documentation (3-5 days)

#### 6.1 Test Coverage

**Auth Extension:**
- Unit tests for all auth adapters
- Integration tests with AgentOS
- E2E tests with backend
- Migration tests (old → new)

**Extension System:**
- Multi-registry loading
- GitHub source loading
- Cache invalidation
- Verification

**Personas:**
- Registry loading
- Marketplace integration
- Persona validation

#### 6.2 Documentation

**Update Existing Docs:**
- `docs/ARCHITECTURE.md` - Remove auth from core, add extension patterns
- `docs/EXTENSIONS_VERIFICATION.md` - Add auth extension verification
- `packages/agentos/README.md` - Update to reflect capability-based design

**Create New Docs:**
- `packages/agentos-auth/docs/API.md`
- `packages/agentos-auth/docs/MIGRATION_GUIDE.md`
- `packages/agentos-extensions/docs/GUARDRAILS.md`
- `packages/agentos-personas/docs/MARKETPLACE.md`
- `docs/MULTI_REGISTRY_GUIDE.md`

#### 6.3 Examples

**Auth Extension Examples:**
- Basic JWT authentication
- Supabase integration
- Custom auth provider
- Tool permission integration
- Persona tier gating

**Extension System Examples:**
- Loading from multiple registries
- GitHub source loading
- Creating custom extensions
- Combining extensions

**Persona Registry Examples:**
- Loading from marketplace
- Creating custom personas
- Publishing personas
- Persona marketplace integration

### Phase 7: Migration & Cleanup (2-3 days)

#### 7.1 Update All Imports
- Backend auth routes
- Frontend auth hooks
- Client applications
- Tests

#### 7.2 Update Configuration
- Environment variables
- Config files
- Docker setup
- CI/CD pipelines

#### 7.3 Remove Legacy Code
- Old auth service implementations
- Guardrails package
- Duplicate code
- Deprecated interfaces

---

## Architecture Benefits

### Pros of This Approach

1. **Separation of Concerns**
   - Core library is pure orchestration logic
   - Auth is opt-in via extension
   - Each concern has clear boundaries

2. **Flexibility**
   - Enterprises can substitute their own auth
   - Self-hosted deployments can omit auth entirely
   - Multiple auth strategies can coexist

3. **Testing**
   - Core logic testable without auth infrastructure
   - Auth extension has isolated test suite
   - Integration tests verify combination

4. **Deployment Options**
   - Air-gapped: use core without auth extension
   - Cloud: include auth extension
   - Hybrid: custom auth extension

5. **Community Growth**
   - Easier to contribute tools/guardrails
   - Lower barrier to entry (no auth complexity)
   - Clear extension model

6. **Maintenance**
   - Auth updates don't require core library updates
   - Extension versioning independent
   - Clearer upgrade paths

### Cons & Mitigations

1. **Initial Complexity**
   - Con: More packages to manage
   - Mitigation: Clear documentation, examples
   - Mitigation: Monorepo keeps development unified

2. **Breaking Change**
   - Con: Existing integrations must migrate
   - Mitigation: Compatibility layer during transition
   - Mitigation: Comprehensive migration guide
   - Mitigation: Deprecation warnings, not immediate removal

3. **Setup Overhead**
   - Con: "Batteries included" experience requires extension
   - Mitigation: Quick-start examples with auth included
   - Mitigation: CLI tool to scaffold complete setup
   - Mitigation: Default configs in documentation

4. **Performance**
   - Con: Additional layer of indirection
   - Mitigation: Minimal overhead (function calls only)
   - Mitigation: Benchmark to ensure negligible impact

---

## Migration Strategy

### For Existing Users

1. **Opt-in Phase** (4-8 weeks)
   - Auth remains in core with deprecation warnings
   - New auth extension available
   - Documentation shows both approaches
   - Migration guide published

2. **Transition Phase** (4-8 weeks)
   - Core auth marked deprecated
   - Extension becomes recommended approach
   - Compatibility shims provided
   - Active support for migration

3. **Removal Phase** (next major version)
   - Core auth removed
   - Extension required for auth features
   - Clear upgrade path documented

### Backward Compatibility

```typescript
// Compatibility shim in core
export class LegacyAuthService implements IAuthService {
  constructor(private extensionManager: ExtensionManager) {
    console.warn(
      'Built-in auth is deprecated. Please migrate to @framersai/agentos-auth extension. ' +
      'See: https://agentos.sh/docs/migration/auth-extension'
    );
  }
  
  async authenticate(...args) {
    const authExt = this.extensionManager.getExtension('auth');
    if (authExt) {
      return authExt.payload.authenticate(...args);
    }
    throw new Error('No auth extension loaded');
  }
}
```

---

## Success Criteria

### Functional Requirements
- ✅ Core AgentOS has no auth/subscription logic
- ✅ Auth extension provides same functionality as before
- ✅ All guardrails migrated to extensions registry
- ✅ Multi-registry system supports GitHub sources
- ✅ Personas can load from separate registry
- ✅ All existing tests pass with new architecture

### Quality Requirements
- ✅ 80%+ test coverage for auth extension
- ✅ Comprehensive documentation for all changes
- ✅ Migration guides with working examples
- ✅ Performance impact < 5ms per request

### Developer Experience
- ✅ Clear extension creation templates
- ✅ Simple configuration for common cases
- ✅ Detailed guides for advanced scenarios
- ✅ Active examples for all extension types

---

## Timeline

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| 1. Design & Interfaces | 2-3 days | None |
| 2. Extract Auth | 3-5 days | Phase 1 |
| 3. Consolidate Guardrails | 2-3 days | Phase 1 |
| 4. Unified Loader | 3-4 days | Phase 1 |
| 5. Personas Package | 2-3 days | Phase 4 |
| 6. Testing & Docs | 3-5 days | Phase 2-5 |
| 7. Migration & Cleanup | 2-3 days | Phase 6 |

**Total: 17-26 days** (3.5-5 weeks with parallelization)

---

## Next Steps

1. Review and approve this plan
2. Create feature branch: `feat/extension-system-refactor`
3. Begin Phase 1: Design & Interfaces
4. Set up parallel tracks for Phase 2-4
5. Regular sync meetings to track progress

---

## Open Questions

1. Should we maintain backward compat in v0.x or require major version bump?
2. Should auth extension be in monorepo or separate repo from day 1?
3. Do we need enterprise-specific auth adapters (SAML, LDAP, etc.)?
4. Should personas registry be public GitHub repo or private initially?
5. Do we need a CLI tool for scaffolding extensions/personas?

---

**Document Status:** Draft
**Last Updated:** 2024-11-14
**Owner:** Frame.dev Engineering Team

