/**
 * @fileoverview LLMSentimentAnalyzer — LLM-backed sentiment analysis for
 * Wunderland agent mood updates. Replaces/augments the keyword-based
 * {@link ContentSentimentAnalyzer} with configurable LLM calls.
 *
 * @module wunderland/social/LLMSentimentAnalyzer
 */

import type { PADState, MoodDelta } from './MoodEngine.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the LLM-backed sentiment analyzer.
 */
export interface LLMSentimentConfig {
  /**
   * LLM invoker function — takes a prompt string, returns the model's
   * response text. The caller is responsible for wiring this to the
   * appropriate provider (e.g. OpenAI gpt-4o-mini, Ollama, etc.).
   */
  invoker: (prompt: string) => Promise<string>;

  /**
   * Whether to fall back to keyword-based analysis if the LLM call fails.
   * @default true
   */
  fallbackToKeyword?: boolean;

  /**
   * Cache TTL in milliseconds for sentiment results.
   * Identical content within this window returns cached results.
   * @default 300000 (5 minutes)
   */
  cacheTtlMs?: number;

  /**
   * Maximum number of entries in the LRU cache.
   * @default 256
   */
  maxCacheSize?: number;

  /**
   * Maximum concurrent LLM calls.
   * @default 3
   */
  maxConcurrency?: number;
}

// ============================================================================
// Result Types
// ============================================================================

/**
 * Structured sentiment analysis result.
 */
export interface SentimentResult {
  /** Overall sentiment score: -1 (very negative) to 1 (very positive). */
  sentiment: number;

  /** Arousal/energy level: -1 (calm/low energy) to 1 (intense/high energy). */
  arousal: number;

  /** Dominance/assertiveness: -1 (submissive) to 1 (dominant/commanding). */
  dominance: number;

  /** Brief explanation of the sentiment classification. */
  reasoning: string;

  /** Whether the analysis came from LLM (true) or keyword fallback (false). */
  fromLLM: boolean;
}

/**
 * Conversation tone profile aggregated from multiple messages.
 */
export interface ConversationToneProfile {
  /** Average sentiment across analyzed messages. */
  averageSentiment: number;

  /** Average arousal across analyzed messages. */
  averageArousal: number;

  /** Trend direction: 'improving', 'declining', or 'stable'. */
  trend: 'improving' | 'declining' | 'stable';

  /** Number of messages analyzed. */
  messageCount: number;
}

// ============================================================================
// LRU Cache
// ============================================================================

interface CacheEntry {
  result: SentimentResult;
  expiresAt: number;
}

class LRUCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): SentimentResult | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.result;
  }

  set(key: string, result: SentimentResult, ttlMs: number): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { result, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// ============================================================================
// Concurrency Limiter
// ============================================================================

class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ============================================================================
// Prompts
// ============================================================================

const SENTIMENT_PROMPT = `Analyze the sentiment of the following text. Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):

{"sentiment": <float -1 to 1>, "arousal": <float -1 to 1>, "dominance": <float -1 to 1>, "reasoning": "<brief explanation>"}

Where:
- sentiment: -1 = very negative, 0 = neutral, 1 = very positive
- arousal: -1 = calm/sleepy, 0 = neutral, 1 = excited/intense
- dominance: -1 = submissive/uncertain, 0 = neutral, 1 = assertive/commanding

Text to analyze:
`;

const MOOD_IMPACT_PROMPT = `Given the current mood state and new content, determine the mood change delta. Respond with ONLY a JSON object:

{"valence": <float -0.3 to 0.3>, "arousal": <float -0.3 to 0.3>, "dominance": <float -0.3 to 0.3>, "trigger": "<brief cause description>"}

Deltas should be small (-0.3 to 0.3) — moods shift gradually, not dramatically.

Current mood (PAD): valence={{valence}}, arousal={{arousal}}, dominance={{dominance}}

New content:
`;

// ============================================================================
// LLMSentimentAnalyzer
// ============================================================================

/**
 * LLM-backed sentiment analyzer for Wunderland agent mood updates.
 *
 * Features:
 * - Configurable LLM invoker (any provider via callback)
 * - LRU cache to avoid re-analyzing identical content
 * - Concurrency limiter to prevent LLM overload
 * - Fallback to keyword-based heuristic on errors
 * - PAD-compatible output for direct MoodEngine integration
 *
 * @example
 * ```typescript
 * const analyzer = new LLMSentimentAnalyzer({
 *   invoker: async (prompt) => {
 *     const res = await openai.chat.completions.create({
 *       model: 'gpt-4o-mini',
 *       messages: [{ role: 'user', content: prompt }],
 *     });
 *     return res.choices[0].message.content ?? '';
 *   },
 * });
 *
 * const result = await analyzer.analyzeSentiment('This project is amazing!');
 * // { sentiment: 0.8, arousal: 0.4, dominance: 0.1, reasoning: '...', fromLLM: true }
 * ```
 */
export class LLMSentimentAnalyzer {
  private readonly invoker: (prompt: string) => Promise<string>;
  private readonly fallbackToKeyword: boolean;
  private readonly cache: LRUCache;
  private readonly cacheTtlMs: number;
  private readonly limiter: ConcurrencyLimiter;

  constructor(config: LLMSentimentConfig) {
    this.invoker = config.invoker;
    this.fallbackToKeyword = config.fallbackToKeyword ?? true;
    this.cacheTtlMs = config.cacheTtlMs ?? 300_000;
    this.cache = new LRUCache(config.maxCacheSize ?? 256);
    this.limiter = new ConcurrencyLimiter(config.maxConcurrency ?? 3);
  }

  /**
   * Analyze the sentiment of a text string.
   * Returns PAD-compatible scores for MoodEngine integration.
   */
  async analyzeSentiment(content: string): Promise<SentimentResult> {
    if (!content.trim()) {
      return { sentiment: 0, arousal: 0, dominance: 0, reasoning: 'empty content', fromLLM: false };
    }

    // Check cache
    const cacheKey = hashContent(content);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      await this.limiter.acquire();
      try {
        const prompt = SENTIMENT_PROMPT + content.slice(0, 2000); // Truncate to save tokens
        const response = await this.invoker(prompt);
        const parsed = parseJsonResponse<{
          sentiment: number;
          arousal: number;
          dominance: number;
          reasoning: string;
        }>(response);

        const result: SentimentResult = {
          sentiment: clamp(parsed.sentiment, -1, 1),
          arousal: clamp(parsed.arousal, -1, 1),
          dominance: clamp(parsed.dominance, -1, 1),
          reasoning: parsed.reasoning ?? '',
          fromLLM: true,
        };

        this.cache.set(cacheKey, result, this.cacheTtlMs);
        return result;
      } finally {
        this.limiter.release();
      }
    } catch (err) {
      if (this.fallbackToKeyword) {
        return keywordFallback(content);
      }
      throw err;
    }
  }

  /**
   * Analyze the mood impact of new content given the agent's current mood.
   * Returns a MoodDelta compatible with MoodEngine.applyDelta().
   */
  async analyzeMoodImpact(content: string, currentMood: PADState): Promise<MoodDelta> {
    if (!content.trim()) {
      return { valence: 0, arousal: 0, dominance: 0, trigger: 'empty content' };
    }

    try {
      await this.limiter.acquire();
      try {
        const prompt = MOOD_IMPACT_PROMPT
          .replace('{{valence}}', currentMood.valence.toFixed(2))
          .replace('{{arousal}}', currentMood.arousal.toFixed(2))
          .replace('{{dominance}}', currentMood.dominance.toFixed(2))
          + content.slice(0, 2000);

        const response = await this.invoker(prompt);
        const parsed = parseJsonResponse<{
          valence: number;
          arousal: number;
          dominance: number;
          trigger: string;
        }>(response);

        return {
          valence: clamp(parsed.valence, -0.3, 0.3),
          arousal: clamp(parsed.arousal, -0.3, 0.3),
          dominance: clamp(parsed.dominance, -0.3, 0.3),
          trigger: parsed.trigger ?? 'llm sentiment analysis',
        };
      } finally {
        this.limiter.release();
      }
    } catch {
      // Fallback: derive delta from keyword sentiment
      const fb = keywordFallback(content);
      return {
        valence: fb.sentiment * 0.15,
        arousal: fb.arousal * 0.1,
        dominance: fb.dominance * 0.05,
        trigger: `keyword-fallback: ${fb.reasoning}`,
      };
    }
  }

  /**
   * Analyze the tone across multiple messages in a conversation.
   * Returns an aggregate profile with trend detection.
   */
  async analyzeConversationTone(messages: string[]): Promise<ConversationToneProfile> {
    if (messages.length === 0) {
      return { averageSentiment: 0, averageArousal: 0, trend: 'stable', messageCount: 0 };
    }

    const results: SentimentResult[] = [];
    for (const msg of messages.slice(-20)) { // Limit to last 20 messages
      results.push(await this.analyzeSentiment(msg));
    }

    const avgSentiment = results.reduce((s, r) => s + r.sentiment, 0) / results.length;
    const avgArousal = results.reduce((s, r) => s + r.arousal, 0) / results.length;

    // Detect trend from last half vs first half
    let trend: 'improving' | 'declining' | 'stable' = 'stable';
    if (results.length >= 4) {
      const mid = Math.floor(results.length / 2);
      const firstHalf = results.slice(0, mid).reduce((s, r) => s + r.sentiment, 0) / mid;
      const secondHalf = results.slice(mid).reduce((s, r) => s + r.sentiment, 0) / (results.length - mid);
      const delta = secondHalf - firstHalf;
      if (delta > 0.15) trend = 'improving';
      else if (delta < -0.15) trend = 'declining';
    }

    return {
      averageSentiment: avgSentiment,
      averageArousal: avgArousal,
      trend,
      messageCount: results.length,
    };
  }

  /** Clear the internal cache. */
  clearCache(): void {
    this.cache.clear();
  }
}

// ============================================================================
// Helpers
// ============================================================================

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hashContent(content: string): string {
  // Simple djb2 hash — good enough for cache keys
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(36);
}

function parseJsonResponse<T>(response: string): T {
  // Strip markdown code fences if present
  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return JSON.parse(cleaned);
}

/**
 * Keyword-based fallback when LLM is unavailable.
 * Uses a simple word-scoring approach for basic sentiment.
 */
function keywordFallback(content: string): SentimentResult {
  const lower = content.toLowerCase();
  const words = lower.split(/\s+/);

  const POSITIVE = new Set([
    'great', 'good', 'excellent', 'amazing', 'wonderful', 'fantastic',
    'brilliant', 'love', 'happy', 'excited', 'helpful', 'thanks', 'awesome',
    'perfect', 'beautiful', 'impressive', 'outstanding', 'delightful',
  ]);
  const NEGATIVE = new Set([
    'bad', 'terrible', 'awful', 'horrible', 'hate', 'angry', 'frustrated',
    'disappointing', 'useless', 'broken', 'wrong', 'fail', 'worst', 'ugly',
    'annoying', 'painful', 'disgusting', 'pathetic', 'stupid',
  ]);
  const HIGH_AROUSAL = new Set([
    'urgent', 'exciting', 'amazing', 'incredible', 'emergency', 'critical',
    'astonishing', 'shocking', 'explosive', 'wild', 'insane',
  ]);

  let positive = 0;
  let negative = 0;
  let arousal = 0;

  for (const word of words) {
    if (POSITIVE.has(word)) positive++;
    if (NEGATIVE.has(word)) negative++;
    if (HIGH_AROUSAL.has(word)) arousal++;
  }

  const total = Math.max(positive + negative, 1);
  const sentiment = (positive - negative) / total;
  const arousalScore = Math.min(arousal / Math.max(words.length, 1) * 10, 1);

  return {
    sentiment: clamp(sentiment, -1, 1),
    arousal: clamp(arousalScore, -1, 1),
    dominance: 0,
    reasoning: `keyword: ${positive} positive, ${negative} negative words`,
    fromLLM: false,
  };
}
