# Documentation Standards

## Writing Timeless Documentation

Documentation should describe the **current state** of the system, not when things changed or how they evolved.

### ❌ Avoid Temporal Language

**Bad:**
- "Auth is **now** optional"
- "We **recently** added extension support"
- "The **new** auth system"
- "**Updated** architecture"
- "**Latest** features"

**Good:**
- "Auth is optional"
- "The extension system supports..."
- "The auth extension provides..."
- "Architecture overview"
- "Current features"

### ❌ Avoid Version Dating

**Bad:**
- "As of v1.0, auth is optional"
- "In the new version..."
- "Previously, auth was required"

**Good:**
- "Auth is optional"
- Document the current state only
- Put version history in CHANGELOG.md

### ✅ Use Present Tense

Describe systems as they **are**, not as they **were** or **will be**.

**Bad:**
- "Auth **was** moved to an extension"
- "We **will** support multiple registries"

**Good:**
- "Auth lives in the extensions registry"
- "Multiple registry sources are supported"

### ✅ Document Behavior, Not Change

**Bad:**
```
Auth is now optional. Previously it was required in core.
```

**Good:**
```
Auth is optional. Supply `authService` to enable authentication,
or omit it to allow unrestricted access.
```

### ✅ Put History in CHANGELOG

Version history and changes belong in `CHANGELOG.md`, not in architecture docs.

**CHANGELOG.md:**
```markdown
## [1.0.0] - 2024-11-14
### Changed
- Extracted auth into optional extension
- Made auth/subscription services optional in core
```

**ARCHITECTURE.md:**
```markdown
## Authentication

Auth is optional. To enable, use the auth extension...
```

---

## File-Specific Guidelines

### README.md
- Describe what the project **is**
- How to install and use it **currently**
- No version history

### ARCHITECTURE.md  
- Current system design
- How components work together
- Extension points
- No "new features" sections

### API.md
- Current API surface
- Parameters and return types
- Examples of usage
- No deprecation notes (use inline `@deprecated`)

### CHANGELOG.md
- **Only place** for version history
- What changed when
- Migration notes for breaking changes

### Examples
- Show current best practices
- No comments like "new way" vs "old way"
- Just show the recommended approach

---

## Emoji Usage

Use sparingly and purposefully:

**Good uses:**
- ✅ Success/checkmark for correct examples
- ❌ X mark for incorrect examples  
- 💡 Light bulb for tips
- ⚠️ Warning for important notes

**Avoid:**
- ✨ Sparkles (implies "new and shiny")
- 🆕 New badge
- 🎉 Party (implies recent achievement)

---

## Review Checklist

Before committing docs, check for:

- [ ] No "now", "new", "recently", "latest", "updated"
- [ ] Present tense throughout
- [ ] No version references outside CHANGELOG
- [ ] No "before/after" comparisons
- [ ] Examples show current best practices
- [ ] Emojis used sparingly and purposefully

---

## Example: Good vs Bad

### ❌ Bad Documentation

```markdown
# Authentication

AgentOS now supports optional authentication! We recently refactored
the auth system to be more flexible. In the new architecture, auth is
no longer required in core.

Previously, you had to provide auth services:
```typescript
// Old way (don't use)
await agentos.initialize({ authService: required });
```

Now you can omit it:
```typescript  
// New way!
await agentos.initialize({});
```
```

### ✅ Good Documentation

```markdown
# Authentication

Authentication is optional in AgentOS. The system works with or without
auth services.

**Without auth (unrestricted access):**
```typescript
await agentos.initialize({});
```

**With auth extension:**
```typescript
import { createAuthExtension } from '@framers/agentos-extensions/auth';

const { authService } = createAuthExtension({ ... });
await agentos.initialize({ authService });
```

**Custom auth provider:**
```typescript
class MyAuth implements IAuthService { ... }
await agentos.initialize({ authService: new MyAuth() });
```
```

---

**Remember:** Documentation describes the current state. CHANGELOG tracks changes over time.


