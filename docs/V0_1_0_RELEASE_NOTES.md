# AgentOS v0.1.0 Release Notes

## 🎉 Emergent Multi-Agent Behavior is Here!

**Release Date**: January 2025  
**Status**: Production Ready  
**Codename**: "Emergent Intelligence"

---

## 🚀 Major Features

### 1. Emergent Agency System

AgentOS can now **dynamically decompose complex goals**, **spawn adaptive roles**, and **coordinate multiple agents** in real-time.

**Key Capabilities:**
- ✅ Goal decomposition into subtasks with dependency tracking
- ✅ Adaptive role spawning based on task requirements
- ✅ Parallel execution with automatic error recovery
- ✅ Inter-agent coordination through shared context
- ✅ Structured output formatting (Markdown, JSON, CSV, Text)
- ✅ Full state persistence and replay

**Documentation**: [EMERGENT_AGENCY_SYSTEM.md](./EMERGENT_AGENCY_SYSTEM.md)

---

### 2. Tool Execution Bridge

Unified tool execution pipeline with schema validation:

- ✅ Backend `/api/agentos/tools/execute` → AgentOS ToolOrchestrator
- ✅ Input validation via AJV against JSON schemas
- ✅ Output validation for type safety
- ✅ Registry-based tool discovery from `@framers/agentos-extensions`

**Example:**
```typescript
POST /api/agentos/tools/execute
{
  "toolId": "webSearch",
  "input": { "query": "quantum computing 2024" },
  "userId": "user123"
}
```

---

### 3. Verified Extensions Program

Administrative framework for curating high-quality extensions:

- ✅ Verification policy documented in [EXTENSIONS_VERIFICATION.md](./EXTENSIONS_VERIFICATION.md)
- ✅ Standards for tests, docs, security practices
- ✅ Verified badge displayed in Extension Manager UI
- ✅ Metadata tracked in registry (`verified`, `verifiedAt`, `verificationChecklistVersion`)

---

### 4. Comprehensive Documentation

- ✅ OpenAPI spec served at `https://agentos.sh/docs/api`
- ✅ Linked in site header for easy discovery
- ✅ All READMEs updated with consistent branding
- ✅ Verified Program blurbs in extensions/guardrails docs

---

## 📦 Package Updates

### Core Packages

| Package | Status | Published |
|---------|--------|-----------|
| `@framers/agentos` | ✅ Ready | Pending |
| `@framers/agentos-extensions` | ✅ Ready | Pending |
| `@framers/agentos-guardrails` | ✅ Ready | Pending |
| `@framers/sql-storage-adapter` | ✅ Ready | Pending |

### Applications

| App | Status | Deployment |
|-----|--------|------------|
| `agentos-client` (Workbench) | ✅ Ready | Self-hosted |
| `agentos.sh` (Marketing) | ✅ Ready | https://agentos.sh |
| `backend` | ✅ Ready | Self-hosted |

---

## 🧪 Testing Coverage

### Backend Tests

```bash
pnpm --filter voice-chat-assistant-backend test
```

**Coverage:**
- ✅ App database initialization and fallback
- ✅ Extensions registry loading and tool derivation
- ✅ Guardrails registry loading
- ✅ Agency execution persistence
- ✅ Seat progress tracking with retries
- ✅ Emergent metadata storage

**Total**: 11/11 tests passing

### Frontend Tests

```bash
pnpm --filter @framersai/agentos-client e2e
```

**Playwright setup**: ✅ Configured (baseline smoke test ready)

---

## 🎨 UI Enhancements

### AgentOS Client Workbench

**New Components:**
- ✅ `AgencyHistoryView`: Browse past executions with emergent insights
- ✅ `ExtensionManager`: Display verified badge and link to standards
- ✅ `GuardrailManager`: Fetch from backend registry (no more mocks)

**Improvements:**
- ✅ Fixed all TypeScript errors (100+ type issues resolved)
- ✅ Created missing UI primitives (Card, Button, Input, Badge, Tabs, Progress)
- ✅ Proper IndexedDB and SQL.js storage integration

---

## 🔧 Developer Experience

### Workspace Configuration

- ✅ All internal dependencies use `workspace:*` links
- ✅ No publishing required for local development
- ✅ `pnpm install` works out of the box

### Build & Run

```bash
# Install dependencies
pnpm install --no-frozen-lockfile

# Run backend
pnpm --filter voice-chat-assistant-backend dev

# Run workbench
pnpm --filter @framersai/agentos-client dev

# Run website
pnpm --filter @framersai/agentos.sh dev

# Run all tests
pnpm test
```

---

## 📝 Documentation Updates

### New Documents

- [EMERGENT_AGENCY_SYSTEM.md](./EMERGENT_AGENCY_SYSTEM.md) - Full emergent behavior guide
- [EXTENSIONS_VERIFICATION.md](./EXTENSIONS_VERIFICATION.md) - Admin verification process

### Updated Documents

- [BACKEND_API.md](./BACKEND_API.md) - New agency and tool endpoints
- All package READMEs - Unified branding and Frame.dev footer

---

## 🐛 Bug Fixes

### TypeScript Errors Resolved

- ✅ Fixed 100+ type errors in `agentos-client`
- ✅ Corrected `moduleResolution` to `Node`
- ✅ Fixed subpath imports for `@framers/agentos`
- ✅ Proper type assertions for storage adapters
- ✅ Event type handling in `ParallelAgencyView`

### API Fixes

- ✅ Replaced mock extension/guardrail endpoints with registry-backed services
- ✅ Fixed `ListPersonaFilters` type definition
- ✅ Corrected agency request payload types

---

## ⚡ Performance

### Benchmarks

**Agency Execution** (2 roles, emergent mode):
- Decomposition: ~2-4s
- Parallel GMI spawn: ~1-2s
- Execution: ~10-30s (task-dependent)
- Total: ~13-36s

**Cost** (gpt-4o-mini):
- Decomposition: ~$0.001-0.002
- Per-seat execution: ~$0.003-0.008
- Total 2-seat agency: ~$0.007-0.018

---

## 🔐 Security

### Verified Extensions

- Web Search extension verified ✓
- PII Redactor guardrail verified ✓
- All templates follow security checklist

### API Protection

- Rate limiting on all public endpoints
- Foreign key constraints on database
- Input validation via AJV schemas
- CORS configured for dev/prod

---

## 📚 Migration Guide

### From Pre-v0.1.0

**Breaking Changes:**
- None (first official release)

**New Environment Variables:**
- `AGENTOS_ENABLED=true` - Enable AgentOS integration
- `AGENTOS_ENABLE_GUARDRAILS=true` - Enable guardrail system

---

## 🛣️ Roadmap to v0.2.0

### Planned Features

1. **Real-time Inter-Agent Messaging**
   - Agents can send messages to each other
   - Shared knowledge updates visible to all seats

2. **Workflow Visual Editor**
   - Drag-and-drop agency composition
   - Live dependency graph

3. **Advanced Cost Controls**
   - Per-agency budget limits
   - Cost prediction before execution

4. **Secrets Management UI**
   - Secure API key storage
   - Per-user rate limiting with apiKeys pass-through

5. **CI/CD Pipeline**
   - Automated testing on all PRs
   - Conventional commits enforcement
   - Coverage reports

---

## 👥 Contributors

- **Johnny Dunn** (@jddunn) - Core architecture and implementation
- **AgentOS Team** - Documentation and testing

---

## 🙏 Acknowledgments

Special thanks to:
- Frame.dev for AgentOS hosting and infrastructure
- Early testers for feedback and bug reports
- Open source community for extension contributions

---

## 📞 Support

- **Documentation**: https://docs.agentos.sh
- **API Reference**: https://docs.agentos.sh/api
- **GitHub Issues**: https://github.com/framersai/agentos/issues
- **Discord**: Coming soon

---

## ✅ v0.1.0 Checklist

### Core Features
- [x] Emergent agency system with dynamic task decomposition
- [x] Adaptive role spawning and assignment
- [x] Parallel GMI execution with retry logic
- [x] State persistence to database
- [x] Structured output formatting (MD, JSON, CSV, text)
- [x] Cost tracking and aggregation
- [x] Real-time SSE streaming

### Developer Experience
- [x] Tool execution bridge with schema validation
- [x] Extensions registry backed by JSON
- [x] Guardrails registry backed by JSON
- [x] Verified extensions program
- [x] Comprehensive documentation
- [x] Integration tests passing
- [x] TypeScript errors resolved
- [x] pnpm workspace configured

### UI/UX
- [x] Agency History View in workbench
- [x] Verified badge in Extension Manager
- [x] Guardrail Manager fetches from backend
- [x] OpenAPI link in website header
- [x] Consistent README branding

### Infrastructure
- [x] Database schema for agency state
- [x] API endpoints for history queries
- [x] Error recovery and retry logic
- [x] Foreign key constraints
- [x] Proper TypeScript types throughout

---

**🎊 AgentOS v0.1.0 is ready for production use!**

For full implementation details, see [EMERGENT_AGENCY_SYSTEM.md](./EMERGENT_AGENCY_SYSTEM.md).

