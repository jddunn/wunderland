# Prompt Profiles + Rolling Memory (AgentOS)

This repo supports:

- **Prompt profiles**: dynamic _system-instruction add-ons_ (concise / deep dive / planner / reviewer) selected per turn.
- **Rolling memory**: an optional _rolling summary_ that keeps long conversations usable (“infinite” memory via compaction).

## Terminology (important)

- **Prompt profiles** (this doc) are _system instruction presets_ selected at prompt-build time.
- **Metaprompts** (AgentOS feature) are _self-reflection loops_ that run after turns (e.g., sentiment-aware metaprompts).

## 1) Prompt profiles (dynamic “meta presets”)

### What it is

Each turn can select a preset that controls:

- Optional **meta add-ons** (small instruction blocks under `prompts/_meta/`)

The persona’s base system prompt still comes from the AgentOS persona definition. Prompt profiles are _additive_.

Selection is cached per conversation and re-evaluated:

- every `N` turns (`routing.reviewEveryNTurns`)
- and/or whenever rolling memory compaction runs (`routing.forceReviewOnCompaction`)

### Config file

Presets + routing live in:

- `config/metaprompt-presets.json`

Key fields:

- `routing.reviewEveryNTurns`: how often to re-route per conversation
- `routing.forceReviewOnCompaction`: re-route when rolling summary updates
- `routing.defaultPresetByMode`: defaults (supports pattern matching via `mode.includes(key)`)
- `presets[]`: `{ id, addonPromptKeys[] }` (other fields are allowed but ignored by AgentOS)
- `rules[]`: simple keyword/length matching with `priority`

### Add-on prompts

Meta add-ons are small `.md` files under:

- `prompts/_meta/*.md`

They’re appended into the final system prompt as extra instructions (and can be combined).

## 2) Rolling memory (conversation “infinite memory”)

### What it does

When enabled, AgentOS maintains a **rolling memory summary** for each conversation:

- Stored in the AgentOS `ConversationContext` metadata (key: `rollingSummaryState` by default)
- Tracks progress up to `summaryUptoTimestamp`

At prompt-build time we then:

- inject the rolling summary into the system prompt
- include only the remaining “tail” turns after `summaryUptoTimestamp` (older turns are excluded from the prompt)

This keeps the prompt small while preserving long-term continuity.

### Output format (by default)

Rolling memory compaction outputs **both**:

- `summary_markdown` (human-readable summary text)
- `memory_json` (structured JSON memory suitable for clients/agents)

Clients receive this via the AgentOS `METADATA_UPDATE` chunk (and `/api/chat` returns it as `metadata`).

### Assistant output formats (markdown + plain text)

AgentOS streams assistant text as Markdown by default (`text_delta` + `final_response.finalResponseText`).

For voice/TTS and logs, `final_response` also includes:

- `finalResponseTextPlain`: plain-text rendering of the final answer (Markdown stripped)

### Persistence for retrieval (recommended)

When rolling memory compaction runs (`didCompact: true`), the backend persists the latest snapshot for retrieval:

- **Knowledge base (SQL):** `agentos_knowledge_items` rows with `type: "rolling_memory"` (stores `memory_json` in metadata)
- **RAG store (SQL):** collection `agentos-rolling-memory`, category `conversation_memory` (stores `memory_json` in metadata)

This is wired via the AgentOS `rollingSummaryMemorySink` hook so other surfaces (RabbitHole/Wunderland/etc.) can reuse it.

### Retrieval into prompts (cross-conversation memory)

When a `longTermMemoryRetriever` is configured, AgentOS can **retrieve durable memories** (user/persona/org) from the long-term store and inject them into the next prompt (as additional `retrievedContext`).

Default cadence (tied to prompt-profile routing):

- re-retrieve every `routing.reviewEveryNTurns`
- and whenever compaction runs if `routing.forceReviewOnCompaction=true`

Retrieval respects `memoryControl.longTermMemory` scopes:

- `scopes.user`: inject user-scoped memories
- `scopes.persona`: inject per-user-per-persona memories
- `scopes.organization`: inject org-scoped memories (**requires `organizationId` on the request**)

Clients receive lightweight diagnostics via the AgentOS `METADATA_UPDATE` chunk (`longTermMemoryRetrieval`).

### Long-term memory scopes + per-conversation opt-out

Rolling memory has two distinct concerns:

- **Compaction** (keeps prompts small) — controlled by `config/metaprompt-presets.json` → `memoryCompaction`
- **Persistence** (writes durable long-term memory) — controlled per conversation

AgentOS accepts (optional) first-class memory controls on each request:

- `AgentOSInput.organizationId`
- `AgentOSInput.memoryControl.longTermMemory`

Defaults (when omitted):

- Long-term persistence is **enabled** for `conversation` scope only
- `user`, `persona`, and `organization` scopes are **disabled**
- Organization scope also requires explicit opt-in via `shareWithOrganization: true`

Voice Chat Assistant backend defaults (when authenticated / org-scoped):

- If authenticated, the backend defaults `scopes.user=true` and `scopes.persona=true` unless explicitly set.
- If `organizationId` is present, the backend defaults `scopes.organization=true` for **retrieval** unless explicitly set.
- Publishing org-scoped memory is **admin-only** and enforced at write time by the rolling memory sink (even if a conversation policy previously enabled `shareWithOrganization`).
- Org admins can control org-wide memory defaults/kill-switches via `PATCH /api/organizations/:organizationId/settings`.

**Scopes written by the rolling memory sink (when compaction runs):**

- `conversation`: snapshot + atomic items
  - KB: `type: "rolling_memory"` + `type: "rolling_memory_item"`
  - RAG: collection `agentos-rolling-memory`
- `user`: atomic items (deduped by user + item hash)
  - RAG: collection `agentos-user-memory`
- `persona`: atomic items (deduped by user + persona + item hash)
  - RAG: collection `agentos-persona-memory`
- `organization`: atomic items (deduped by org + item hash), only when:
  - `organizationId` is present, **and**
  - `scopes.organization: true`, **and**
  - `shareWithOrganization: true`
  - (Safety default) only persists `facts`, `people`, `projects`, `decisions`
  - RAG: collection `agentos-org-memory`

**Opt-out:** Set `memoryControl.longTermMemory.enabled=false` on the first turn. AgentOS stores the effective policy in `ConversationContext` metadata (`longTermMemoryPolicy`) so it persists across turns. (Org context is not persisted; callers must assert `organizationId` each request.)

Example (enable user + org scope):

```json
{
  "organizationId": "org_123",
  "memoryControl": {
    "longTermMemory": {
      "enabled": true,
      "scopes": { "conversation": true, "user": true, "organization": true },
      "shareWithOrganization": true
    }
  }
}
```

### Configuration (recommended)

Compaction is **on by default** (to keep long conversations within the context window). Configure per-agent defaults in:

- `config/metaprompt-presets.json` → `memoryCompaction`

Key fields:

- `memoryCompaction.profiles`: named compaction profiles (e.g., `off`, `standard`)
- `memoryCompaction.defaultProfile`: fallback profile when no mode mapping matches
- `memoryCompaction.defaultProfileByMode`: map `mode` / agentId to a profile name

Notes:

- Requires AgentOS conversational persistence enabled (`AGENTOS_ENABLE_PERSISTENCE=true`) to persist rolling memory across restarts.
- To disable globally, set `memoryCompaction.defaultProfile` to `off` (or map specific modes/personas in `defaultProfileByMode`).

### Cost / latency budget (defaults)

The default `standard` profile is intentionally conservative:

- **Cadence:** at most one compaction pass per conversation per `cooldownMs` (default: 60s).
- **Work per pass:** summarizes up to `maxTurnsToSummarizePerPass` (default: 48) while keeping a tail of `tailTurnsToKeep` (default: 12).
- **Output cap:** `maxSummaryTokens` (default: 900) across both `summary_markdown` and `memory_json`.
- **Model choice:** use a cheap “utility” model (default config uses `openai/gpt-4o-mini`) to keep incremental cost low.

### Environment overrides (optional)

Legacy `/api/chat` (non‑AgentOS) compaction supports `MEMORY_COMPACTION_*` env overrides as deploy-time kill switches.
AgentOS rolling memory should be configured via `config/metaprompt-presets.json` (or future org/user settings).

- `MEMORY_COMPACTION_ENABLED=true|false`
- `MEMORY_COMPACTION_PROMPT_KEY=memory_compactor_v2_json`
- `MEMORY_COMPACTION_MODEL_ID=openai/gpt-4o-mini` (or your utility model)
- `MEMORY_COMPACTION_COOLDOWN_MS=60000`
- `MEMORY_COMPACTION_TAIL_TURNS=12`
- `MEMORY_COMPACTION_MIN_TURNS=12`
- `MEMORY_COMPACTION_MAX_TURNS_PER_PASS=48`
- `MEMORY_COMPACTION_MAX_SUMMARY_TOKENS=900`

## 3) Where it’s wired

- **AgentOS (first-class):**
  - `packages/agentos/src/api/AgentOSOrchestrator.ts` runs prompt-profile routing + rolling memory compaction **before** each LLM call.
  - `packages/agentos/src/cognitive_substrate/GMI.ts` injects the prompt-profile instructions + rolling summary into the system prompt.
  - `packages/agentos/src/core/llm/PromptEngine.ts` supports `MessageRole.SUMMARY` for summarized older context.
- **Backend integration:**
  - `backend/src/integrations/agentos/agentos.integration.ts` loads `config/metaprompt-presets.json` and passes it into AgentOS orchestrator config.
  - `/api/chat` routes through AgentOS when `AGENTOS_ENABLED=true` and returns `metadata` (prompt profile + rolling memory).

## 4) Sentiment-Aware Metaprompts (AgentOS)

### What it is

The GMI (Generalized Mind Instance) can analyze user sentiment in real-time and trigger specialized metaprompts that dynamically adjust agent behavior. This is an **opt-in** feature controlled per-persona.

**Key difference from metaprompt presets above:** Metaprompt presets (section 1) control _which system prompt_ the agent uses. Sentiment-aware metaprompts (this section) are _self-reflection loops_ that run _after_ processing a turn, adjusting GMI state (mood, skill level, complexity) for the _next_ turn.

### How it works

```
User Input → Sentiment Analysis → Event Detection → Metaprompt Trigger → State Update
```

1. **Sentiment Analysis**: Runs on every user message (when enabled). Uses either lexicon-based (fast, ~10-50ms) or LLM-based (accurate, ~500-1000ms) analysis.
2. **Event Detection**: Detects patterns like frustration, confusion, satisfaction based on sentiment scores and keywords.
3. **Metaprompt Trigger**: Matching events trigger specialized metaprompts that call the LLM to decide adjustments.
4. **State Update**: GMI mood, user skill level, and task complexity are updated based on LLM recommendations.

### Enabling sentiment tracking

Add `sentimentTracking` to your persona definition:

```json
{
  "id": "my_tutor_persona",
  "name": "Adaptive Tutor",
  "version": "1.0.0",
  "baseSystemPrompt": "You are an adaptive coding tutor...",

  "sentimentTracking": {
    "enabled": true,
    "method": "lexicon_based",
    "presets": ["frustration_recovery", "confusion_clarification"]
  }
}
```

### Configuration reference

| Field                        | Type       | Default           | Description                                                                                 |
| ---------------------------- | ---------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `enabled`                    | `boolean`  | `false`           | Master switch. Must be `true` to enable.                                                    |
| `method`                     | `string`   | `'lexicon_based'` | `'lexicon_based'` (fast, free), `'llm'` (accurate, costs tokens), or `'trained_classifier'` |
| `modelId`                    | `string`   | persona default   | Model for LLM-based analysis                                                                |
| `providerId`                 | `string`   | persona default   | Provider for LLM-based analysis                                                             |
| `historyWindow`              | `number`   | `10`              | Number of recent turns to track                                                             |
| `frustrationThreshold`       | `number`   | `-0.3`            | Score below this = frustrated (range: -1 to 1)                                              |
| `satisfactionThreshold`      | `number`   | `0.3`             | Score above this = satisfied                                                                |
| `consecutiveTurnsForTrigger` | `number`   | `2`               | Consecutive turns needed before event fires                                                 |
| `presets`                    | `string[]` | `[]`              | Which preset metaprompts to enable (see below)                                              |

### Available presets

| Preset name                  | Event trigger              | What it does                                         |
| ---------------------------- | -------------------------- | ---------------------------------------------------- |
| `frustration_recovery`       | `user_frustrated`          | Switches to empathetic mood, simplifies explanations |
| `confusion_clarification`    | `user_confused`            | Rephrases, provides examples, adjusts complexity     |
| `satisfaction_reinforcement` | `user_satisfied`           | Increases challenge, maintains engagement            |
| `error_recovery`             | `error_threshold_exceeded` | Analyzes error patterns, adjusts approach            |
| `engagement_boost`           | `low_engagement`           | Injects creativity, asks engaging questions          |
| `all`                        | (all of above)             | Enables all 5 presets                                |

### Quick-start profiles

The `config/metaprompt-presets.json` file includes ready-to-use profiles under `sentimentTracking.profiles`:

| Profile    | Method  | Presets                                | Best for                                |
| ---------- | ------- | -------------------------------------- | --------------------------------------- |
| `off`      | —       | None                                   | Default, no overhead                    |
| `basic`    | lexicon | frustration + confusion                | Most use cases                          |
| `standard` | lexicon | All 5                                  | Full emotion awareness                  |
| `advanced` | llm     | All 5                                  | When accuracy matters (costs tokens)    |
| `tutor`    | lexicon | frustration + confusion + satisfaction | Educational contexts (lower thresholds) |

### Turn-interval self-reflection (existing)

The existing `gmi_self_trait_adjustment` metaprompt with `turn_interval` trigger **always works regardless of sentimentTracking**. If you only want periodic self-reflection without sentiment analysis:

```json
{
  "metaPrompts": [
    {
      "id": "gmi_self_trait_adjustment",
      "promptTemplate": "Reflect on the conversation: {{evidence}}",
      "trigger": { "type": "turn_interval", "intervalTurns": 5 }
    }
  ]
}
```

This runs every 5 turns, no sentiment analysis needed.

### Architecture

```
packages/agentos/src/cognitive_substrate/
├── GMI.ts                          # Core: sentiment analysis, event detection, handlers
├── GMIEvent.ts                     # Event types and interfaces
├── personas/
│   ├── IPersonaDefinition.ts       # SentimentTrackingConfig interface
│   ├── metaprompt_presets.ts       # 5 preset metaprompt configurations
│   └── PersonaLoader.ts           # Opt-in preset merging
└── tests/
    └── GMI.sentiment.test.ts       # Comprehensive test suite
```

### Event types

| Event                      | Detection rule                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `user_frustrated`          | Score < threshold AND intensity > 0.6, OR consecutive negative turns                       |
| `user_confused`            | Confusion keywords ("don't understand", "unclear", etc.) OR neutral + many negative tokens |
| `user_satisfied`           | Score > threshold AND intensity > 0.5, OR consecutive positive turns                       |
| `error_threshold_exceeded` | 2+ errors in last 10 reasoning trace entries                                               |
| `low_engagement`           | 4+ consecutive neutral turns AND avg response < 50 chars                                   |

### Custom metaprompts

You can create custom metaprompts with any trigger type:

```json
{
  "metaPrompts": [
    {
      "id": "my_custom_reflection",
      "description": "Custom reflection triggered by frustration",
      "promptTemplate": "The user seems frustrated. Current mood: {{current_mood}}. Suggest adjustments.",
      "trigger": { "type": "event_based", "eventName": "user_frustrated" },
      "temperature": 0.3,
      "maxOutputTokens": 256
    }
  ]
}
```

Template variables available: `{{current_mood}}`, `{{user_skill}}`, `{{task_complexity}}`, `{{current_sentiment}}`, `{{recent_conversation}}`, `{{recent_errors}}`, `{{evidence}}`, `{{sentiment_score}}`, `{{consecutive_frustration}}`, `{{consecutive_confusion}}`, `{{consecutive_satisfaction}}`, `{{confusion_keywords}}`, `{{consecutive_neutral}}`.
