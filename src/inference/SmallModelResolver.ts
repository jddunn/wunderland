/**
 * @fileoverview SmallModelResolver — resolves the cheapest/fastest model
 * from a given provider for lightweight tasks like sentiment analysis,
 * style profiling, and routing.
 *
 * @module wunderland/inference/SmallModelResolver
 */

// ============================================================================
// Provider-to-Small-Model Mapping
// ============================================================================

/** Known provider IDs and their corresponding small/cheap models. */
const SMALL_MODEL_MAP: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  ollama: 'llama3.2:3b',
  openrouter: 'auto',
  bedrock: 'anthropic.claude-haiku',
  gemini: 'gemini-2.0-flash-lite',
  'github-copilot': 'gpt-4o-mini',
  minimax: 'MiniMax-VL-01',
  qwen: 'qwen-turbo',
  moonshot: 'kimi-k2-instant',
  venice: 'venice-fast',
  'cloudflare-ai': '@cf/meta/llama-3.1-8b-instruct',
  'xiaomi-mimo': 'mimo-v2-flash',
};

/** Default model IDs per provider (the primary/powerful model). */
const DEFAULT_MODEL_MAP: Record<string, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-5-20250929',
  ollama: 'llama3',
  openrouter: 'auto',
  bedrock: 'anthropic.claude-sonnet',
  gemini: 'gemini-2.0-flash',
  'github-copilot': 'gpt-4o',
  minimax: 'MiniMax-M2.1',
  qwen: 'qwen-max',
  moonshot: 'kimi-k2.5',
  venice: 'venice-default',
  'cloudflare-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'xiaomi-mimo': 'mimo-v2-flash',
};

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for SmallModelResolver.
 */
export interface SmallModelResolverConfig {
  /** The primary provider ID (e.g. 'openai', 'anthropic', 'ollama'). */
  primaryProvider: string;

  /**
   * Override the small model for the primary provider.
   * If not set, the built-in mapping is used.
   */
  smallModelOverride?: string;

  /**
   * Fallback provider if primary is unavailable.
   * Defaults to 'ollama' for local execution.
   */
  fallbackProvider?: string;

  /**
   * Override the small model for the fallback provider.
   */
  fallbackSmallModelOverride?: string;
}

// ============================================================================
// SmallModelResolver
// ============================================================================

/**
 * Resolves the cheapest/fastest model from a configured provider.
 *
 * Used by:
 * - {@link LLMSentimentAnalyzer} for mood/sentiment analysis
 * - {@link StyleAdaptationEngine} for communication style profiling
 * - {@link WunderlandSecurityPipeline} DualLLMAuditor for audit checks
 *
 * @example
 * ```typescript
 * const resolver = new SmallModelResolver({ primaryProvider: 'openai' });
 * const model = resolver.resolveSmall();
 * // => { providerId: 'openai', modelId: 'gpt-4o-mini' }
 * ```
 */
export class SmallModelResolver {
  private readonly config: SmallModelResolverConfig;

  constructor(config: SmallModelResolverConfig) {
    this.config = config;
  }

  /**
   * Resolve the smallest/cheapest model from the primary provider.
   * Falls back to the fallback provider if the primary isn't recognized.
   */
  resolveSmall(): { providerId: string; modelId: string } {
    const { primaryProvider, smallModelOverride, fallbackProvider, fallbackSmallModelOverride } = this.config;

    // Try explicit override first
    if (smallModelOverride) {
      return { providerId: primaryProvider, modelId: smallModelOverride };
    }

    // Try known mapping
    const knownSmall = SMALL_MODEL_MAP[primaryProvider];
    if (knownSmall) {
      return { providerId: primaryProvider, modelId: knownSmall };
    }

    // Fallback
    const fb = fallbackProvider ?? 'ollama';
    const fbModel = fallbackSmallModelOverride ?? SMALL_MODEL_MAP[fb] ?? 'llama3.2:3b';
    return { providerId: fb, modelId: fbModel };
  }

  /**
   * Resolve the default (primary) model from the primary provider.
   */
  resolveDefault(): { providerId: string; modelId: string } {
    const { primaryProvider } = this.config;
    const known = DEFAULT_MODEL_MAP[primaryProvider];
    return {
      providerId: primaryProvider,
      modelId: known ?? 'auto',
    };
  }

  /**
   * Get all known small model mappings.
   */
  static getSmallModelMap(): Readonly<Record<string, string>> {
    return { ...SMALL_MODEL_MAP };
  }

  /**
   * Check if a provider ID is recognized.
   */
  static isKnownProvider(providerId: string): boolean {
    return providerId in SMALL_MODEL_MAP;
  }
}
