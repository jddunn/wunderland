/**
 * @fileoverview TokenUsageTracker — cumulative token usage tracking with cost estimation.
 *
 * Tracks prompt and completion tokens per model across a session. Provides
 * per-model breakdowns, totals, and rough cost estimates based on hardcoded
 * pricing for common models.
 *
 * Usage:
 * ```typescript
 * const tracker = new TokenUsageTracker();
 * tracker.record('gpt-4o-mini', 1200, 350);
 * tracker.record('gpt-4o-mini', 800, 200);
 * tracker.record('claude-sonnet-4-6-20250514', 2000, 600);
 *
 * const usage = tracker.getUsage();
 * console.log(usage.totalPromptTokens);   // 4000
 * console.log(usage.totalCompletionTokens); // 1150
 * console.log(usage.estimatedCostUSD);      // calculated from model rates
 * ```
 *
 * @module wunderland/core/TokenUsageTracker
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Per-model token usage record. */
export interface ModelTokenUsage {
  /** Model identifier (e.g., "gpt-4o-mini", "claude-sonnet-4-6-20250514") */
  model: string;
  /** Cumulative prompt (input) tokens for this model */
  promptTokens: number;
  /** Cumulative completion (output) tokens for this model */
  completionTokens: number;
  /** Total tokens (prompt + completion) for this model */
  totalTokens: number;
  /** Number of API calls tracked for this model */
  callCount: number;
  /** Estimated cost in USD for this model's usage (null if pricing unknown) */
  estimatedCostUSD: number | null;
}

/** Aggregated token usage across all models. */
export interface TokenUsageSummary {
  /** Per-model breakdowns, sorted by total tokens descending */
  perModel: ModelTokenUsage[];
  /** Total prompt tokens across all models */
  totalPromptTokens: number;
  /** Total completion tokens across all models */
  totalCompletionTokens: number;
  /** Total combined tokens across all models */
  totalTokens: number;
  /** Total API calls across all models */
  totalCalls: number;
  /** Total estimated cost in USD (sum of known model costs; null portions excluded) */
  estimatedCostUSD: number | null;
  /** Session start timestamp */
  sessionStartedAt: Date;
  /** Time of last recorded usage */
  lastRecordedAt: Date | null;
}

/** Pricing rates for a model (USD per 1M tokens). */
export interface ModelPricing {
  /** Cost per 1M prompt (input) tokens */
  promptPer1M: number;
  /** Cost per 1M completion (output) tokens */
  completionPer1M: number;
}

// ── Pricing Table ────────────────────────────────────────────────────────────

/**
 * Hardcoded pricing for common models (USD per 1M tokens).
 * Prices are approximate and may drift as providers update rates.
 * Last updated: 2025-05.
 *
 * Unknown models return null cost — consumers should display "unknown"
 * rather than $0.00 in that case.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-4o': { promptPer1M: 2.50, completionPer1M: 10.00 },
  'gpt-4o-mini': { promptPer1M: 0.15, completionPer1M: 0.60 },
  'gpt-4-turbo': { promptPer1M: 10.00, completionPer1M: 30.00 },
  'gpt-4': { promptPer1M: 30.00, completionPer1M: 60.00 },
  'gpt-3.5-turbo': { promptPer1M: 0.50, completionPer1M: 1.50 },
  'o1': { promptPer1M: 15.00, completionPer1M: 60.00 },
  'o1-mini': { promptPer1M: 3.00, completionPer1M: 12.00 },
  'o3-mini': { promptPer1M: 1.10, completionPer1M: 4.40 },

  // Anthropic
  'claude-opus-4-6-20250514': { promptPer1M: 15.00, completionPer1M: 75.00 },
  'claude-sonnet-4-6-20250514': { promptPer1M: 3.00, completionPer1M: 15.00 },
  'claude-haiku-4-5-20251001': { promptPer1M: 0.80, completionPer1M: 4.00 },
  'claude-3-5-sonnet-20241022': { promptPer1M: 3.00, completionPer1M: 15.00 },
  'claude-3-haiku-20240307': { promptPer1M: 0.25, completionPer1M: 1.25 },

  // Google
  'gemini-1.5-pro': { promptPer1M: 1.25, completionPer1M: 5.00 },
  'gemini-1.5-flash': { promptPer1M: 0.075, completionPer1M: 0.30 },
  'gemini-2.0-flash': { promptPer1M: 0.10, completionPer1M: 0.40 },

  // Meta (via providers like Together, Groq, etc. — approximate)
  'llama-3.1-70b': { promptPer1M: 0.88, completionPer1M: 0.88 },
  'llama-3.1-8b': { promptPer1M: 0.18, completionPer1M: 0.18 },

  // Mistral
  'mistral-large': { promptPer1M: 2.00, completionPer1M: 6.00 },
  'mistral-small': { promptPer1M: 0.20, completionPer1M: 0.60 },

  // DeepSeek
  'deepseek-chat': { promptPer1M: 0.14, completionPer1M: 0.28 },
  'deepseek-reasoner': { promptPer1M: 0.55, completionPer1M: 2.19 },
};

/**
 * Alias map: common short names and variants that map to canonical model IDs.
 * This allows `tracker.record('gpt-4o', ...)` to match pricing even if the
 * API returns a slightly different model string.
 */
const MODEL_ALIASES: Record<string, string> = {
  'gpt-4o-2024-08-06': 'gpt-4o',
  'gpt-4o-2024-05-13': 'gpt-4o',
  'gpt-4o-mini-2024-07-18': 'gpt-4o-mini',
  'gpt-4-turbo-2024-04-09': 'gpt-4-turbo',
  'gpt-4-0125-preview': 'gpt-4-turbo',
  'gpt-3.5-turbo-0125': 'gpt-3.5-turbo',
  'o1-2024-12-17': 'o1',
  'o1-mini-2024-09-12': 'o1-mini',
  'claude-3-5-sonnet-latest': 'claude-3-5-sonnet-20241022',
  'claude-3-haiku-latest': 'claude-3-haiku-20240307',
};

// ── TokenUsageTracker ────────────────────────────────────────────────────────

/**
 * Tracks cumulative token usage per model across a session.
 *
 * Thread-safe for single-threaded Node.js — no mutex needed since
 * JS is single-threaded and record() is synchronous.
 */
export class TokenUsageTracker {
  private usage: Map<string, { promptTokens: number; completionTokens: number; callCount: number }>;
  private sessionStartedAt: Date;
  private lastRecordedAt: Date | null;

  constructor() {
    this.usage = new Map();
    this.sessionStartedAt = new Date();
    this.lastRecordedAt = null;
  }

  /**
   * Record token usage for a single API call.
   *
   * @param model - The model identifier (e.g., "gpt-4o-mini")
   * @param promptTokens - Number of prompt (input) tokens consumed
   * @param completionTokens - Number of completion (output) tokens generated
   */
  record(model: string, promptTokens: number, completionTokens: number): void {
    if (!model || typeof model !== 'string') return;
    if (!Number.isFinite(promptTokens) || promptTokens < 0) promptTokens = 0;
    if (!Number.isFinite(completionTokens) || completionTokens < 0) completionTokens = 0;

    const existing = this.usage.get(model);
    if (existing) {
      existing.promptTokens += promptTokens;
      existing.completionTokens += completionTokens;
      existing.callCount += 1;
    } else {
      this.usage.set(model, {
        promptTokens,
        completionTokens,
        callCount: 1,
      });
    }

    this.lastRecordedAt = new Date();
  }

  /**
   * Get the full usage summary with per-model breakdowns and totals.
   */
  getUsage(): TokenUsageSummary {
    const perModel: ModelTokenUsage[] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCalls = 0;
    let totalCostKnown = 0;
    let hasAnyPricing = false;

    for (const [model, data] of this.usage.entries()) {
      const totalTokens = data.promptTokens + data.completionTokens;
      const cost = this.estimateCost(model, data.promptTokens, data.completionTokens);

      if (cost !== null) {
        totalCostKnown += cost;
        hasAnyPricing = true;
      }

      perModel.push({
        model,
        promptTokens: data.promptTokens,
        completionTokens: data.completionTokens,
        totalTokens,
        callCount: data.callCount,
        estimatedCostUSD: cost,
      });

      totalPromptTokens += data.promptTokens;
      totalCompletionTokens += data.completionTokens;
      totalCalls += data.callCount;
    }

    // Sort by total tokens descending
    perModel.sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      perModel,
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      totalCalls,
      estimatedCostUSD: hasAnyPricing ? totalCostKnown : null,
      sessionStartedAt: this.sessionStartedAt,
      lastRecordedAt: this.lastRecordedAt,
    };
  }

  /**
   * Reset all tracked usage (e.g., at session boundaries).
   */
  reset(): void {
    this.usage.clear();
    this.sessionStartedAt = new Date();
    this.lastRecordedAt = null;
  }

  /**
   * Check if any usage has been recorded.
   */
  hasUsage(): boolean {
    return this.usage.size > 0;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Estimate cost for a given model and token counts.
   * Returns null if pricing is not known for the model.
   */
  private estimateCost(
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): number | null {
    const pricing = this.resolvePricing(model);
    if (!pricing) return null;

    const promptCost = (promptTokens / 1_000_000) * pricing.promptPer1M;
    const completionCost = (completionTokens / 1_000_000) * pricing.completionPer1M;

    return promptCost + completionCost;
  }

  /**
   * Resolve pricing for a model ID, checking the canonical table first,
   * then aliases, then prefix matching (for versioned model names).
   */
  private resolvePricing(model: string): ModelPricing | null {
    // Direct match
    if (MODEL_PRICING[model]) return MODEL_PRICING[model];

    // Alias match
    const alias = MODEL_ALIASES[model];
    if (alias && MODEL_PRICING[alias]) return MODEL_PRICING[alias];

    // Prefix match: find the longest matching key
    // e.g., "gpt-4o-mini-2024-07-18" matches "gpt-4o-mini"
    let bestMatch: string | null = null;
    let bestLen = 0;
    for (const key of Object.keys(MODEL_PRICING)) {
      if (model.startsWith(key) && key.length > bestLen) {
        bestMatch = key;
        bestLen = key.length;
      }
    }

    return bestMatch ? MODEL_PRICING[bestMatch] : null;
  }
}
