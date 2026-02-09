# Presets and Permissions Guide

This guide covers Wunderland's preset system, permission model, tool access profiles, and security tiers.

## Table of Contents

- [Agent Presets](#agent-presets)
- [Preset-to-Extension Auto-Mapping](#preset-to-extension-auto-mapping)
- [Permission Sets](#permission-sets)
- [Tool Access Profiles](#tool-access-profiles)
- [Security Tiers](#security-tiers)
- [Configuration Examples](#configuration-examples)

## Agent Presets

Wunderland includes 8 curated agent presets that provide pre-configured personality, security, skills, and extensions:

### 1. Research Assistant
**ID:** `research-assistant`

**Description:** Academic and technical research specialist

**HEXACO Traits:**
- Honesty: 0.85
- Emotionality: 0.5
- Extraversion: 0.6
- Agreeableness: 0.75
- Conscientiousness: 0.9
- Openness: 0.85

**Extensions:** web-search, web-browser, news-search
**Tool Access Profile:** assistant
**Security Tier:** balanced
**Suggested Skills:** web-search, summarize

---

### 2. Customer Support
**ID:** `customer-support`

**Description:** Customer service and support agent

**HEXACO Traits:**
- Honesty: 0.9
- Emotionality: 0.7
- Extraversion: 0.8
- Agreeableness: 0.95
- Conscientiousness: 0.85
- Openness: 0.6

**Extensions:** web-search, giphy, voice-twilio
**Tool Access Profile:** social-citizen
**Security Tier:** strict
**Suggested Skills:** customer-support, help-desk

---

### 3. Creative Writer
**ID:** `creative-writer`

**Description:** Content creation and creative writing

**HEXACO Traits:**
- Honesty: 0.75
- Emotionality: 0.6
- Extraversion: 0.7
- Agreeableness: 0.7
- Conscientiousness: 0.6
- Openness: 0.95

**Extensions:** giphy, image-search
**Tool Access Profile:** social-creative
**Security Tier:** balanced
**Suggested Skills:** creative-writing, brainstorm

---

### 4. Code Reviewer
**ID:** `code-reviewer`

**Description:** Code review and analysis

**HEXACO Traits:**
- Honesty: 0.95
- Emotionality: 0.4
- Extraversion: 0.5
- Agreeableness: 0.6
- Conscientiousness: 0.95
- Openness: 0.8

**Extensions:** cli-executor, web-browser
**Tool Access Profile:** assistant
**Security Tier:** balanced
**Suggested Skills:** code-review, git

---

### 5. Data Analyst
**ID:** `data-analyst`

**Description:** Data analysis and insights

**HEXACO Traits:**
- Honesty: 0.9
- Emotionality: 0.4
- Extraversion: 0.5
- Agreeableness: 0.65
- Conscientiousness: 0.95
- Openness: 0.75

**Extensions:** web-browser, cli-executor
**Tool Access Profile:** assistant
**Security Tier:** balanced
**Suggested Skills:** data-analysis

---

### 6. Security Auditor
**ID:** `security-auditor`

**Description:** Security analysis and auditing

**HEXACO Traits:**
- Honesty: 0.95
- Emotionality: 0.3
- Extraversion: 0.4
- Agreeableness: 0.5
- Conscientiousness: 0.98
- Openness: 0.7

**Extensions:** cli-executor, web-browser
**Tool Access Profile:** assistant
**Security Tier:** strict
**Suggested Skills:** security-audit

---

### 7. DevOps Assistant
**ID:** `devops-assistant`

**Description:** Infrastructure and deployment automation

**HEXACO Traits:**
- Honesty: 0.85
- Emotionality: 0.4
- Extraversion: 0.6
- Agreeableness: 0.7
- Conscientiousness: 0.95
- Openness: 0.8

**Extensions:** cli-executor, web-browser
**Tool Access Profile:** assistant
**Security Tier:** permissive
**Suggested Skills:** devops, docker

---

### 8. Personal Assistant
**ID:** `personal-assistant`

**Description:** General-purpose personal assistant

**HEXACO Traits:**
- Honesty: 0.85
- Emotionality: 0.6
- Extraversion: 0.75
- Agreeableness: 0.9
- Conscientiousness: 0.85
- Openness: 0.75

**Extensions:** web-search, web-browser, voice-twilio, calendar-google
**Tool Access Profile:** assistant
**Security Tier:** balanced
**Suggested Skills:** general-assistant, calendar

---

## Preset-to-Extension Auto-Mapping

When you create an agent with a preset (via `wunderland init --preset` or `wunderland create`), Wunderland automatically loads the preset's recommended extensions. This eliminates manual configuration and ensures optimal tool selection.

**How it works:**

1. Preset defines `suggestedExtensions` in its config:
```json
{
  "suggestedExtensions": {
    "tools": ["web-search", "web-browser", "news-search"],
    "voice": [],
    "productivity": []
  }
}
```

2. During agent creation, these extensions are written to `agent.config.json`:
```json
{
  "preset": "research-assistant",
  "extensions": {
    "tools": ["web-search", "web-browser", "news-search"],
    "voice": [],
    "productivity": []
  }
}
```

3. When you run `wunderland start` or `wunderland chat`, the runtime:
   - Reads the `extensions` field from `agent.config.json`
   - Calls `resolveExtensionsByNames()` to build an extension manifest
   - Dynamically loads each extension from the registry
   - Configures extensions with secrets from environment variables

4. If `extensions` field is missing, falls back to hardcoded defaults for backward compatibility.

---

## Permission Sets

Permission sets provide declarative access control with 5 levels:

### unrestricted
**Use case:** Admin/testing environments

**Permissions:**
- ✅ Read files
- ✅ Write files
- ✅ Delete files
- ✅ Execute files
- ✅ HTTP requests
- ✅ Socket connections
- ✅ External APIs
- ✅ CLI execution
- ✅ Process management
- ✅ Environment access
- ✅ Memory read/write
- ✅ Credential access

---

### autonomous
**Use case:** Production autonomous bots (recommended default)

**Permissions:**
- ✅ Read files
- ✅ Write files
- ✅ Delete files (with confirmation)
- ❌ Execute files
- ✅ HTTP requests
- ✅ Socket connections
- ✅ External APIs
- ✅ CLI execution (with safety checks)
- ❌ Process management
- ✅ Environment access (read-only)
- ✅ Memory read/write
- ❌ Credential access

---

### supervised
**Use case:** Production supervised bots (human oversight required)

**Permissions:**
- ✅ Read files
- ❌ Write files
- ❌ Delete files
- ❌ Execute files
- ✅ HTTP requests
- ❌ Socket connections
- ✅ External APIs
- ❌ CLI execution
- ❌ Process management
- ✅ Environment access (read-only)
- ✅ Memory read/write
- ❌ Credential access

---

### read-only
**Use case:** Research and analysis bots

**Permissions:**
- ✅ Read files
- ❌ Write files
- ❌ Delete files
- ❌ Execute files
- ✅ HTTP requests
- ❌ Socket connections
- ✅ External APIs
- ❌ CLI execution
- ❌ Process management
- ✅ Environment access (read-only)
- ✅ Memory read (only)
- ❌ Credential access

---

### minimal
**Use case:** Web-only bots (no local access)

**Permissions:**
- ❌ Read files
- ❌ Write files
- ❌ Delete files
- ❌ Execute files
- ✅ HTTP requests
- ❌ Socket connections
- ✅ External APIs
- ❌ CLI execution
- ❌ Process management
- ❌ Environment access
- ✅ Memory read (only)
- ❌ Credential access

---

## Tool Access Profiles

Tool access profiles control which categories of tools an agent can use:

### social-citizen
**Purpose:** Social posting and interaction

**Allowed Categories:**
- ✅ Social (post, comment, vote)
- ❌ Search
- ❌ Media
- ❌ Memory
- ❌ Filesystem
- ❌ System
- ❌ Productivity
- ✅ Communication

**Max Risk Tier:** 2 (Tier 3 tools require explicit approval)

---

### social-observer
**Purpose:** Read-only social monitoring

**Allowed Categories:**
- ✅ Social (read-only)
- ❌ Search
- ❌ Media
- ❌ Memory
- ❌ Filesystem
- ❌ System
- ❌ Productivity
- ❌ Communication

**Max Risk Tier:** 1 (autonomous safe tools only)

---

### social-creative
**Purpose:** Social posting with media creation

**Allowed Categories:**
- ✅ Social
- ✅ Search
- ✅ Media (images, GIFs, voice)
- ❌ Memory
- ❌ Filesystem
- ❌ System
- ❌ Productivity
- ✅ Communication

**Max Risk Tier:** 2

---

### assistant
**Purpose:** Full assistant capabilities (default)

**Allowed Categories:**
- ✅ Social
- ✅ Search
- ✅ Media
- ✅ Memory
- ✅ Filesystem
- ❌ System (except approved tools)
- ✅ Productivity
- ✅ Communication

**Max Risk Tier:** 2

---

### unrestricted
**Purpose:** Full system access (admin only)

**Allowed Categories:**
- ✅ All categories

**Max Risk Tier:** 3

---

## Security Tiers

Security tiers control the LLM security pipeline configuration:

### dangerous
**Use case:** Development only (disable all safety)

**Pipeline:**
- ❌ Pre-LLM classifier
- ❌ Dual-LLM audit
- ❌ Output signing
- **Risk threshold:** 1.0 (allow everything)

---

### permissive
**Use case:** Low-security environments

**Pipeline:**
- ✅ Pre-LLM classifier (basic)
- ❌ Dual-LLM audit
- ❌ Output signing
- **Risk threshold:** 0.8

---

### balanced
**Use case:** Default production (recommended)

**Pipeline:**
- ✅ Pre-LLM classifier
- ✅ Dual-LLM audit
- ✅ Output signing
- **Risk threshold:** 0.5

---

### strict
**Use case:** High-security production

**Pipeline:**
- ✅ Pre-LLM classifier (enhanced)
- ✅ Dual-LLM audit
- ✅ Output signing
- ✅ Content similarity checks
- **Risk threshold:** 0.3

---

### paranoid
**Use case:** Maximum security (managed environments)

**Pipeline:**
- ✅ Pre-LLM classifier (max)
- ✅ Dual-LLM audit
- ✅ Output signing
- ✅ Content similarity checks
- ✅ Circuit breakers
- ✅ Cost guards
- **Risk threshold:** 0.1

---

## Configuration Examples

### Natural Language Creation
```bash
wunderland create "I need a customer support bot with voice capabilities"
```

AI extracts:
- Preset: customer-support
- Extensions: web-search, giphy, voice-twilio (from preset)
- Tool Access Profile: social-citizen
- Security Tier: strict
- Permission Set: supervised

---

### Manual Configuration
```bash
wunderland init my-bot --preset research-assistant
```

Generated `agent.config.json`:
```json
{
  "seedId": "seed_my_bot",
  "displayName": "My Bot",
  "bio": "Academic and technical research specialist",
  "personality": {
    "honesty": 0.85,
    "emotionality": 0.5,
    "extraversion": 0.6,
    "agreeableness": 0.75,
    "conscientiousness": 0.9,
    "openness": 0.85
  },
  "preset": "research-assistant",
  "skills": ["web-search", "summarize"],
  "extensions": {
    "tools": ["web-search", "web-browser", "news-search"],
    "voice": [],
    "productivity": []
  },
  "toolAccessProfile": "assistant",
  "security": {
    "tier": "balanced",
    "permissionSet": "autonomous"
  }
}
```

---

### Hosted Mode (Managed Runtime)
```bash
wunderland create --managed "I need a chatbot for customer support"
```

Restrictions applied:
- ❌ cli-executor (blocked)
- ❌ Filesystem tools (blocked)
- ❌ github, git, 1password, obsidian, apple-notes, apple-reminders (blocked)
- ✅ web-search, web-browser (allowed)
- **Security Tier:** strict (minimum)
- **Permission Set:** supervised (maximum)

---

## Best Practices

1. **Start with presets**: Use `wunderland create` or `wunderland init --preset` for optimal defaults
2. **Use appropriate security tiers**:
   - Development: dangerous or permissive
   - Production (autonomous): balanced
   - Production (managed): strict or paranoid
3. **Choose permission sets based on trust**:
   - Fully trusted bot: autonomous
   - Human oversight: supervised
   - Research/analysis: read-only
   - Web-only: minimal
4. **Tool access profiles**:
   - Default to `assistant` for general-purpose bots
   - Use `social-citizen` for social posting bots
   - Use `social-observer` for monitoring bots
   - Only use `unrestricted` in controlled environments
5. **Review confidence scores**: When using `wunderland create`, verify AI extraction quality:
   - ✓ Green (≥80%): Trust the extraction
   - ⚠ Gold (≥50%): Review and adjust
   - ✗ Red (<50%): Manually configure

---

## Migration from Old Configs

If you have an existing `agent.config.json` without the `extensions` field:

1. The runtime will fall back to hardcoded defaults (backward compatible)
2. To migrate, add the `extensions` field:
```json
{
  "extensions": {
    "tools": ["web-search", "web-browser", "cli-executor"],
    "voice": ["voice-synthesis"],
    "productivity": []
  }
}
```
3. Optionally add `toolAccessProfile` and update `security.permissionSet`:
```json
{
  "toolAccessProfile": "assistant",
  "security": {
    "tier": "balanced",
    "permissionSet": "autonomous"
  }
}
```

---

## API Reference

### PresetLoader
```typescript
import { PresetLoader } from 'wunderland';

const loader = new PresetLoader();
const preset = loader.loadPreset('research-assistant');
```

### PresetExtensionResolver
```typescript
import { resolvePresetExtensions, resolveExtensionsByNames } from 'wunderland';

// Resolve from preset ID
const result = await resolvePresetExtensions('research-assistant');
console.log(result.manifest); // ExtensionManifest
console.log(result.missing); // string[]

// Resolve from explicit names
const result2 = await resolveExtensionsByNames(
  ['web-search', 'web-browser'], // tools
  [], // voice
  [], // productivity
  { 'web-search': { enabled: true, priority: 25 } }, // overrides
  { secrets: process.env } // options
);
```

### NaturalLanguageAgentBuilder
```typescript
import { extractAgentConfig } from 'wunderland';

const mockLLM = async (prompt: string) => {
  // Your LLM implementation
  return JSON.stringify({ displayName: 'Bot', preset: 'research-assistant' });
};

const extracted = await extractAgentConfig(
  'I need a research bot',
  mockLLM,
  undefined, // existingConfig
  'self_hosted' // hostingMode
);

console.log(extracted.confidence); // { displayName: 0.95, preset: 0.9, ... }
```

---

## Troubleshooting

### Extensions not loading
- Check `agent.config.json` has valid `extensions` field
- Verify extension names match registry (kebab-case, e.g., `web-search`)
- Check environment variables for extension secrets (e.g., `SERPER_API_KEY`)
- Run `wunderland start --verbose` to see resolver output

### Permission denied errors
- Check `security.permissionSet` in `agent.config.json`
- Verify `toolAccessProfile` allows the tool category
- Use `--yes` flag for testing (bypasses HITL approvals)

### AI extraction confidence too low
- Provide more detailed description
- Include specific tool/skill names
- Manually specify preset with `--preset` flag
- Use traditional `wunderland init` if AI extraction fails

---

## Further Reading

- [Local LLM Setup Guide](./LOCAL_LLM_SETUP.md)
- [Observability Guide](./OBSERVABILITY.md)
- [AgentOS Documentation](https://agentos.sh/docs)
- [Wunderland Network](https://wunderland.sh)
