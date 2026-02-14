# Multilingual Provider Registry

This document describes the pluggable language detection and translation providers available in the AgentOS runtime and how to configure them via `AgentOSConfig.languageConfig`.

## 1. Overview
AgentOS uses a provider registry pattern: you declare providers by ID in `languageConfig.detectionProviderConfigs` and `languageConfig.translationProviderConfigs`. The `LanguageService` maps IDs to concrete classes and instantiates them with supplied params and/or environment variables.

## 2. Detection Providers
| ID | Class | Description | Required Params | Notes |
|----|-------|-------------|-----------------|-------|
| `basic_heuristic` | `BasicHeuristicDetectionProvider` | Lightweight regex/Unicode heuristic detector for prototyping. | none | Always added automatically when `autoDetect` is true. |
| `whisper_stub` | `WhisperDetectionProvider` | Placeholder stub referencing Whisper audio detection. | `apiKey?` | Currently returns empty results for text; extend with audio pipeline integration. |

Future planned IDs: `fast_cld3`, `fasttext_langid`, `opennmt_langid`.

### Example
```ts
languageConfig: {
  autoDetect: true,
  detectionProviderConfigs: [ { id: 'whisper_stub', params: { apiKey: process.env.OPENAI_API_KEY } } ],
  // ...
}
```

## 3. Translation Providers
| ID | Class | Description | Required Params | Fallback Behavior |
|----|-------|-------------|-----------------|-------------------|
| `openai_chat` | `OpenAITranslationProvider` | Uses OpenAI Chat Completion to perform translation via prompt engineering. | `apiKey` | Falls back to no-op if request fails. |
| `deepl` | `DeepLTranslationProvider` | Calls DeepL REST API for high-quality general translation. | `apiKey` | Falls back to original text if error. |
| `noop_translation` | `NoOpTranslationProvider` | Returns input unchanged (internal fallback). | none | Always available for graceful degradation. |

### Example Configuration
```ts
languageConfig: {
  defaultLanguage: 'en',
  supportedLanguages: ['en','es','fr','de','it'],
  fallbackLanguages: ['en'],
  pivotLanguage: 'en',
  autoDetect: true,
  detectionProviderConfigs: [ { id: 'whisper_stub' } ],
  translationProviderConfigs: [
    { id: 'openai_chat', params: { model: 'gpt-4o-mini' } },
    { id: 'deepl' }
  ],
  enableCaching: true,
  enableCodeAwareTranslation: true,
  enablePivotNormalization: true,
}
```

Use environment variables for secrets:
```
OPENAI_API_KEY=sk-...
DEEPL_API_KEY=your-deepl-key
```

## 4. Provider Selection Logic
When performing a translation, `LanguageService` picks the first provider whose declared `supportedLanguages` (if any) contains both source and target. If none explicitly match, it falls back to the first registered translation provider, and finally to `noop_translation`.

## 5. Caching
If `enableCaching` is true, translations are cached in-memory using a simple LRU mechanism keyed by `source|target|hash(content)`. Configure capacity via `translationCacheMaxEntries`.

## 6. Code-Aware Translation
With `enableCodeAwareTranslation`, fenced code blocks (``` ... ```) are partitioned and left unchanged while prose is translated. This reduces corruption of source code snippets.

## 7. Pivot Normalization
If `enablePivotNormalization` is enabled and `pivotLanguage` differs from target, content may be normalized to pivot for embedding or summarization workflows.

## 8. Error Handling & Degradation
Provider failures are swallowed and recorded in `providerMetadata.error`. The system then propagates original text when translation fails, ensuring no hard errors interrupt the turn.

## 9. Extending the Registry
Add a new provider by creating a class implementing the relevant interface inside `src/core/language/providers`, then map a new `id` in `LanguageService.initialize()`.

## 10. Roadmap
- Streaming / incremental translation provider interfaces.
- Adaptive cost-based provider ordering.
- Quality scoring / A/B translation verification.
- Glossary injection and domain-specific custom dictionaries.
