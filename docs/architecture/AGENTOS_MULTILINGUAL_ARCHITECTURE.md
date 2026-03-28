# AgentOS Multilingual Architecture

## 1. Purpose & Scope
AgentOS must support end-to-end multilingual experiences for text and speech across detection, negotiation, prompt construction, model routing, memory persistence, retrieval augmentation (RAG), tool execution, guardrails, and audit trails. This document describes the proposed architecture extensions, data contracts, runtime flows, and migration path to evolve current partial support (UI i18n, Whisper auto-detect, OpenAI TTS auto-language) into a first-class multilingual system.

### In Scope
- User input (text + speech) language detection and confidence scoring
- Response language negotiation (persona preference, user preference, auto-detect fallback)
- Translation pipelines (pre-input normalization, post-output rendering, memory localization)
- Language-aware model routing & prompt assembly
- Multilingual STT/TTS provider abstraction, voice selection, caching
- Memory & RAG language tagging and cross-lingual retrieval
- Tool metadata localization + language capability declaration
- Guardrail multi-stage evaluation per language with sanitization variants
- Auditing, metrics, governance & cost controls per language

### Out of Scope (initial phases)
- Automatic code comments translation for programming languages inside code blocks (treated separately)
- Live inline real-time translation of streaming deltas (phase 2+)
- Advanced linguistic adaptation (formal vs informal register, dialect splitting)

## 2. Current State Summary
| Area | Current | Gap |
|------|---------|-----|
| UI | i18next (en, es) | Not linked to AgentOS core, no central language negotiation | 
| Text Input | Manual detection in `chat.routes.ts` | Not standardized, not exposed to AgentOS request types |
| STT | Whisper auto-detect (option to force language) | Language result not consistently injected into conversation context & memory |
| TTS | OpenAI auto-language from text | No language selection heuristic, voice fallback, or cost optimization per locale |
| Prompt Engine | Optional `language` field in context | Not populated consistently; token `{{LANGUAGE}}` uses raw code (sometimes programming vs natural language) |
| Model Router | Condition rule supports `language` | Caller rarely passes language; no fallback strategy |
| Memory & RAG | No per-entry language tagging | Cannot do cross-lingual retrieval or selective summarization |
| Tools | Metadata lacks language capabilities | Tools can't declare supported languages or localized descriptions |
| Guardrails | Single pass moderation | No per-language model selection or sanitization branching |
| Audit/Metadata | Lacks language lineage | Hard to debug translation issues or compliance |

## 3. Multilingual Requirements
1. Detect source language with confidence for every user turn (text and speech). Store `detectedLanguages: [{ code, confidence }...]`.
2. Negotiate a target response language using precedence: Explicit user override > Conversation pinned preference > Persona default > Detected input language > Application default.
3. Support dual pipeline: source language preserved in memory; optional normalized pivot language (e.g. English) for embedding & summarization to optimize vector space efficiency.
4. Provide translation stages (pluggable) using provider(s) or internal LLM utility: `preProcessing`, `postGeneration`, `memoryNormalization`, `ragAugmentation`.
5. Expose `languageConfig` on `AgentOSConfig` enabling: defaultLanguage, fallbackLanguages[], pivotLanguage, detectionProviders[], translationProviders[], enableCrossLingualRAG, streamingTranslationMode.
6. Guarantee streaming translation (Phase 2) via incremental buffering and delta alignment.
7. Guardrails evaluate original text AND translated pivot text; attach decisions per language variant.
8. Tools can specify `supportedLanguages`, `requiresPivot`, and can request internal translation for arguments/result.
9. RAG indexing pipeline tags entries: `{ originalLanguage, pivotLanguageContent?, languageVectorIds[] }`.
10. Auditing: Each `AgentOSResponseChunk` includes `metadata.language`: `{ source, target, pivot, confidence, translationStagesApplied[] }`.
11. Cost governance: Distinct counters for STT minutes, TTS characters, translation characters per language.
12. Backwards compatibility: If `languageConfig` omitted, system behaves as today (English default, existing detection code). No breaking changes.

## 4. High-Level Component Map
```
[User Input]
  ├─ Speech Capture (Browser/Whisper)
  │    └─ STT Provider (language auto-detect) → Detected Source
  ├─ Text Input (raw) → Language Detection Service → Detected Source
  └─ Explicit Language Override (UI control)
        ↓
Language Negotiator
  ├─ Persona Defaults
  ├─ Conversation Preference
  ├─ App Config Defaults
  └─ Fallback Chain → Target Language
        ↓
Prompt Engine
  ├─ Inject language tokens (naturalLanguage vs programmingLanguage separation)
  ├─ Criteria filtering (language match)
  └─ Model Router (language constraint)
        ↓
LLM Response (Target Language)
  ├─ Streaming Manager (delta)
  └─ Optional Post-generation Translation → User Display Language
        ↓
Memory Lifecycle
  ├─ Store original text with language tag
  ├─ Normalize to pivot language (optional)
  └─ Update embeddings (language-aware)
        ↓
RAG Augmentor
  ├─ Query translation → pivot
  ├─ Vector search per language index
  ├─ Result translation back to target
        ↓
Guardrail Dispatcher
  ├─ Evaluate source + pivot + target
  └─ Aggregate policy decisions per language
        ↓
Tool Orchestrator
  ├─ Language capability check
  ├─ Auto-translate args/results as needed
        ↓
Audit/Telemetry (language lineage & costs)
```

## 5. New/Extended Interfaces
### 5.1 `AgentOSConfig.languageConfig`
```ts
export interface AgentOSLanguageConfig {
  defaultLanguage: string;              // e.g. 'en'
  supportedLanguages: string[];         // ['en', 'es', 'de', 'fr', ...]
  fallbackLanguages?: string[];         // Order used if target unsupported
  pivotLanguage?: string;               // For embedding normalization (e.g. 'en')
  autoDetect: boolean;                  // Enable detection on each turn
  detectionProviders: Array<ILanguageDetectionProviderConfig>;
  translationProviders: Array<ITranslationProviderConfig>;
  enableCrossLingualRAG?: boolean;      // If true, enable pivot translation for queries
  enableStreamingTranslation?: boolean; // Phase 2
  maxTranslationLatencyMs?: number;     // Soft budget for streaming post-generation translation
  preferSourceLanguageResponses?: boolean; // If true, respond in user's detected language by default
}
```

### 5.2 `ILanguageDetectionProvider`
```ts
export interface ILanguageDetectionProvider {
  id: string;
  isInitialized: boolean;
  initialize(): Promise<void>;
  /** Returns array sorted by confidence desc */
  detect(text: string): Promise<Array<{ code: string; confidence: number }>>;
  detectFromAudio?(audio: Buffer): Promise<Array<{ code: string; confidence: number }>>; // optional
}
```

### 5.3 `ITranslationProvider`
```ts
export interface ITranslationProvider {
  id: string;
  isInitialized: boolean;
  initialize(): Promise<void>;
  translate(input: string, source: string, target: string, options?: {
    domain?: 'general' | 'code' | 'prompt' | 'rag';
    preserveFormatting?: boolean;
    streamingCallback?: (delta: string) => void; // for streaming translation (phase 2)
  }): Promise<{ output: string; providerMetadata?: Record<string, any> }>;
}
```

### 5.4 Language Service (new runtime component)
```ts
export interface ILanguageService {
  negotiateLanguage(params: {
    explicitUserLanguage?: string;
    detectedLanguages?: Array<{ code: string; confidence: number }>;
    conversationPreferred?: string;
    personaDefault?: string;
  }): { targetLanguage: string; sourceLanguage: string; confidence: number; pivotLanguage?: string; negotiationPath: string[] };

  maybeTranslateBeforeLLM(content: string, source: string, target: string): Promise<string>; // for normalization
  maybeTranslateAfterLLM(content: string, source: string, userDisplayLanguage: string): Promise<string>;
  translateForRagQuery(query: string, source: string, pivot: string): Promise<string>;
  translateRagResults(results: Array<{ content: string; language: string }>, target: string): Promise<Array<{ content: string; sourceLanguage: string }>>;
}
```

### 5.5 Extended `AgentOSInput`
```ts
export interface AgentOSInput {
  userId: string;
  text?: string;
  audioStreamId?: string;
  languageHint?: string; // user override or UI selection
  detectedLanguages?: Array<{ code: string; confidence: number }>; // client or server side detection
  targetLanguage?: string; // optional pre-negotiated
  // ... existing fields
}
```

### 5.6 Extended `AgentOSResponse.metadata.language`
```ts
interface AgentOSResponseLanguageMetadata {
  source: string;            // e.g. 'es'
  target: string;            // e.g. 'fr'
  pivot?: string;            // e.g. 'en'
  confidence: number;        // from detection
  negotiationPath: string[]; // trace of decision chain
  translationStagesApplied: Array<'pre' | 'post' | 'rag_query' | 'rag_result' | 'tool_arg' | 'tool_result'>;
}
```

## 6. Runtime Flow (Detailed)
### 6.1 Input Processing
1. Receive `AgentOSInput`.
2. If `languageConfig.autoDetect` and `detectedLanguages` not provided → call `LanguageService.detect()`.
3. Invoke `LanguageService.negotiateLanguage()` with persona & conversation context.
4. If pivot normalization required and `sourceLanguage !== pivotLanguage` → translate for prompt construction.
5. Attach language metadata to `PromptExecutionContext`.

### 6.2 Prompt Engine
- Filters contextual prompt elements via `.evaluateCriteria()` using negotiated target language.
- Distinguishes `naturalLanguage` vs `codeLanguage` tokens (introduce new token `{{CODE_LANGUAGE}}`).
- Adds language negotiation summary to system preamble when `debugLanguageNegotiation` flag enabled.

### 6.3 Model Routing
- Pass `params.language = targetLanguage` to `ModelRouter.selectModel()`.
- Extend rule conditions for `supportsLanguages: string[]`; fallback if mismatch.

### 6.4 Streaming & Post-Generation
- If `enableStreamingTranslation` false → full response translation after final text.
- Else buffer incoming deltas, apply incremental translation with alignment algorithm:
  - Maintain sliding window of last N characters
  - Translate stable segments only when punctuation / line breaks appear
  - Emit translated deltas as `TEXT_DELTA_TRANSLATED` (new chunk type) alongside original if UI opts-in.

### 6.5 Memory Lifecycle
- Store original turn: `{ content, language }`.
- If pivot differs → store normalized content separately: `{ pivotContent, pivotLanguage }`.
- Summarization policies apply to pivot text for token efficiency; store localized summary variants lazily on demand.

### 6.6 RAG
- Query translation to pivot → embedding → search across unified pivot space and optional per-language indices.
- Results translated back to target language before augmentation.
- Track translation provenance per chunk.

### 6.7 Tools
- Execution wrapper checks tool `supportedLanguages`. If mismatch and auto-translation enabled:
  1. Translate arguments to tool default language
  2. Invoke tool
  3. Translate result back to target language
  4. Annotate metadata stages

### 6.8 Guardrails
- Evaluate source text with locale-specific policy pack.
- If pivot used → evaluate pivot for global compliance (English moderation models typically strongest).
- Evaluate translated target output before emission—sanitize localized text if necessary.
- Attach array of decisions: `[{ language, stage, action, provider }...]`.

### 6.9 Auditing & Telemetry
- Increment per-language counters: `speechMinutes[lang]`, `charactersSynthesized[lang]`, `translationCharacters[lang]`.
- Emit negotiation & translation metrics to `StreamingManager` debug channel when enabled.

## 7. Data Model Changes
| Entity | New Fields |
|--------|------------|
| ConversationTurn | `language`, `pivotLanguage`, `pivotContent?` |
| MemoryEntry | `language`, `pivotContent?` |
| EmbeddingRecord | `originalLanguage`, `pivotLanguage`, `vectorIds[]` |
| AgentOSResponse.metadata.language | Full negotiation + stages |
| ToolCallRecord | `inputLanguage`, `outputLanguage`, `translationApplied:boolean` |

## 8. Configuration Examples
### 8.0 Supported Language Set (Current Workspace)
From existing locale folders the target set includes base and regional variants:
```
Base: en, es, fr, de, it, ja, ko, pt, zh
Regional Variants: en-US, es-ES, fr-FR, de-DE, it-IT, ja-JP, ko-KR, pt-BR, zh-CN
```
Recommendation: Treat base codes as canonical for negotiation; maintain mapping table:
`{ 'en-US': 'en', 'es-ES': 'es', ... }` so detection returning regional codes collapses to base for pivot normalization while preserving original code in metadata.

```ts
const config: AgentOSConfig = {
  // ... existing configs
  languageConfig: {
    defaultLanguage: 'en',
    supportedLanguages: ['en','es','fr','de','ja'],
    fallbackLanguages: ['en'],
    pivotLanguage: 'en',
    autoDetect: true,
    detectionProviders: [ { id: 'fast_cld3' }, { id: 'llm_probability' } ],
  translationProviders: [ { id: 'openai_chat', params: { model: 'gpt-4o-mini' } }, { id: 'deepl' } ],
    enableCrossLingualRAG: true,
    enableStreamingTranslation: false,
    maxTranslationLatencyMs: 1500,
    preferSourceLanguageResponses: true,
  },
};

// After initialization you can inspect negotiation metadata on streamed chunks:
// chunk.metadata.language => { sourceLanguage, targetLanguage, pivotLanguage?, confidence, negotiationPath }

// Implementation references:
// - Service: packages/agentos/src/core/language/LanguageService.ts
// - Interfaces: packages/agentos/src/core/language/interfaces.ts
// - Providers: packages/agentos/src/core/language/providers/*.ts (openai_chat, deepl, whisper_stub, noop)
// - Config hook: AgentOSConfig.languageConfig in packages/agentos/src/api/AgentOS.ts
// - Streaming injection: pushChunkToStream in AgentOSOrchestrator adds metadata.language
// - Input extensions: AgentOSInput.languageHint / detectedLanguages / targetLanguage
// - Provider registry docs: docs/MULTILINGUAL_PROVIDERS.md
```

## 9. Example Turn Metadata
```json
"metadata": {
  "language": {
    "source": "es",
    "target": "es",
    "pivot": "en",
    "confidence": 0.94,
    "negotiationPath": ["user_detected:es","persona_default:en","preferSourceLanguageResponses:true"],
    "translationStagesApplied": ["pre","rag_query","rag_result"]
  },
  "guardrail": [
    { "stage": "input", "language": "es", "action": "ALLOW" },
    { "stage": "pivot", "language": "en", "action": "ALLOW" },
    { "stage": "output", "language": "es", "action": "ALLOW" }
  ]
}
```

## 10. Phased Implementation Plan
| Phase | Goals | Key Deliverables |
|-------|-------|------------------|
| 1 | Core detection + negotiation + metadata | LanguageService skeleton, config schema, negotiation path in responses |
| 2 | Pivot normalization + memory tagging + RAG translation | Updated persistence layer, embedding pipeline, translation provider integration |
| 3 | Tool auto-translation + guardrail multi-language evaluation | Tool wrapper enhancements, guardrail dispatcher extension |
| 4 | Streaming translation + delta alignment | New chunk type, incremental translator, UI updates |
| 5 | Advanced cross-lingual summarization + localized caching | Summarizer multi-language, selective summary regeneration |
| 6 | Analytics dashboards & SLA enforcement per language | Metrics API, cost governance filters |

## 11. Testing Strategy
- Unit: Negotiation logic (precedence order), detection provider adapters, translation fallback.
- Integration: End-to-end turn with speech → STT → detection → negotiation → prompt → response → memory.
- Cross-lingual RAG: Query in `es` retrieving English docs; verify translation chain & augmentation quality.
- Tool translation: Force tool supporting only English; input in French; assert correct round-trip translation.
- Guardrails: Inject policy that blocks a term in pivot but not in source; verify final output sanitized.
- Performance: Measure added latency for translation; ensure < configured `maxTranslationLatencyMs`.
- Streaming (Phase 4): Differential test ensuring delta boundaries maintain semantic coherence.

## 12. Edge Cases & Handling
| Case | Strategy |
|------|----------|
| Low confidence detection (<0.5) | Fall back to defaultLanguage; mark metadata flag `lowConfidence:true` |
| Unsupported target | Use fallbackLanguages chain, append negotiation path reason |
| Translation provider failure | Retry with secondary provider; if all fail, emit original language with warning chunk `LANGUAGE_DEGRADED` |
| Mixed-language user message | Use highest-confidence primary; optionally store secondary codes in metadata |
| Tool argument with code + prose | Split by fenced code blocks; translate prose only (domain='code') |
| Streaming translation drift | Buffer until stable punctuation or 120 chars window; flush stable segments |
| Guardrail block in pivot only | Re-translate sanitized pivot back to target; mark `sanitizedFromPivot:true` |

## 13. Observability & Metrics
- Counters: `translation_chars_total{provider,source,target}`, `stt_minutes_total{lang}`, `tts_chars_total{lang}`, `language_negotiations_total{pathHash}`.
- Histograms: `translation_latency_ms`, `language_negotiation_duration_ms`.
- Error Rates: `translation_failures_total{provider}`, `detection_low_confidence_total`.
- Sampling: Include negotiation path + cost in structured logs at debug level.

## 14. Security & Compliance
- Avoid storing original & translated sensitive text redundantly unless required; configurable redaction policies.
- Ensure translation providers receive only necessary segments (strip PII if guardrails require).
- Provide `languageComplianceTags` on personas for region-specific moderation (e.g., EU locale restrictions).

## 15. Migration & Backward Compatibility
- Introduce `languageConfig`; absence → legacy mode.
- Stepwise flag gating: `ENABLE_LANGUAGE_NEGOTIATION`, `ENABLE_PIVOT_NORMALIZATION`, etc.
- Data backfill job for existing memory entries: detect language, optionally generate pivot content lazily.
- Maintain old `{{LANGUAGE}}` token; add new `{{CODE_LANGUAGE}}` token to disambiguate.

## 16. Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Latency inflation | Caching translations, batching, fallback to source if > threshold |
| Cost escalation | Per-language budgets, early streaming cutoff, reuse pivot summaries |
| Translation accuracy harming RAG | Confidence thresholds; allow retrieval on original language index when high quality needed |
| Guardrail false positives cross-lingual | Dual evaluation with consensus strategy; escalate uncertain cases to human review flag |
| Tool semantic errors after translation | Domain-aware translation (avoid code blocks), require tool opt-in for auto translation |

## 17. Future Extensions
- Dialect clustering & personalization (e.g., `pt-BR` vs `pt-PT`).
- Sentiment/mood adaptation per locale.
- Pluggable grammar correction stage pre RAG indexing.
- Federated language model selection (local vs remote providers based on latency SLA).

## 18. Glossary
- Source Language: Language of user input.
- Target Language: Language chosen for AgentOS response.
- Pivot Language: Normalization language for embeddings/summaries.
- Negotiation Path: Ordered rationale for final target selection.
- Cross-lingual RAG: Retrieval flow translating query & results across languages.

## 19. Acceptance Criteria (Summary)
1. Response metadata includes complete language lineage fields.
2. Cross-lingual retrieval returns relevant documents regardless of input language.
3. Guardrails evaluate at least source + pivot languages.
4. Tools operate correctly with auto-translated arguments when needed.
5. Latency overhead for non-streaming translation < 1.5s median.
6. Fallback chain recorded when target unsupported.
7. Disabling `languageConfig` restores legacy behavior with no errors.

---
This specification provides a full blueprint for implementing robust multilingual capabilities in AgentOS while preserving backwards compatibility and enabling staged rollout.
