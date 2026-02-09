/**
 * @fileoverview Tests for LLMSentimentAnalyzer — LLM-backed sentiment analysis
 * @module wunderland/social/__tests__/LLMSentimentAnalyzer.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMSentimentAnalyzer } from '../LLMSentimentAnalyzer.js';
import type { PADState } from '../MoodEngine.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A mock invoker that returns valid JSON sentiment. */
function createMockInvoker(response: Record<string, unknown>) {
  return vi.fn(async (_prompt: string) => JSON.stringify(response));
}

/** A mock invoker that wraps JSON in markdown fences. */
function createFencedMockInvoker(response: Record<string, unknown>) {
  return vi.fn(async (_prompt: string) => '```json\n' + JSON.stringify(response) + '\n```');
}

/** A mock invoker that throws an error. */
function createFailingInvoker() {
  return vi.fn(async (_prompt: string) => {
    throw new Error('LLM unavailable');
  });
}

const VALID_SENTIMENT = {
  sentiment: 0.7,
  arousal: 0.3,
  dominance: 0.1,
  reasoning: 'test positive sentiment',
};

const CURRENT_MOOD: PADState = {
  valence: 0.2,
  arousal: 0.1,
  dominance: 0.0,
};

// ── Empty content ───────────────────────────────────────────────────────────

describe('LLMSentimentAnalyzer.analyzeSentiment', () => {
  it('should return neutral sentiment for empty content', async () => {
    const invoker = createMockInvoker(VALID_SENTIMENT);
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const result = await analyzer.analyzeSentiment('');
    expect(result.sentiment).toBe(0);
    expect(result.arousal).toBe(0);
    expect(result.dominance).toBe(0);
    expect(result.fromLLM).toBe(false);
    expect(invoker).not.toHaveBeenCalled();
  });

  it('should return neutral sentiment for whitespace-only content', async () => {
    const invoker = createMockInvoker(VALID_SENTIMENT);
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const result = await analyzer.analyzeSentiment('   \n\t  ');
    expect(result.sentiment).toBe(0);
    expect(result.fromLLM).toBe(false);
    expect(invoker).not.toHaveBeenCalled();
  });
});

// ── Valid JSON response ─────────────────────────────────────────────────────

describe('LLMSentimentAnalyzer valid LLM response', () => {
  it('should parse valid JSON response correctly', async () => {
    const invoker = createMockInvoker(VALID_SENTIMENT);
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const result = await analyzer.analyzeSentiment('This is a great day!');
    expect(result.sentiment).toBe(0.7);
    expect(result.arousal).toBe(0.3);
    expect(result.dominance).toBe(0.1);
    expect(result.reasoning).toBe('test positive sentiment');
    expect(result.fromLLM).toBe(true);
    expect(invoker).toHaveBeenCalledOnce();
  });

  it('should strip markdown code fences and parse JSON', async () => {
    const invoker = createFencedMockInvoker(VALID_SENTIMENT);
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const result = await analyzer.analyzeSentiment('This is great!');
    expect(result.sentiment).toBe(0.7);
    expect(result.fromLLM).toBe(true);
  });
});

// ── Clamping ────────────────────────────────────────────────────────────────

describe('LLMSentimentAnalyzer value clamping', () => {
  it('should clamp sentiment values to [-1, 1]', async () => {
    const invoker = createMockInvoker({
      sentiment: 5.0,
      arousal: -3.0,
      dominance: 2.5,
      reasoning: 'extreme values',
    });
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const result = await analyzer.analyzeSentiment('Test extreme values');
    expect(result.sentiment).toBe(1);
    expect(result.arousal).toBe(-1);
    expect(result.dominance).toBe(1);
  });
});

// ── Cache behavior ──────────────────────────────────────────────────────────

describe('LLMSentimentAnalyzer caching', () => {
  it('should return cached result on second call for same content', async () => {
    const invoker = createMockInvoker(VALID_SENTIMENT);
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const result1 = await analyzer.analyzeSentiment('Identical content');
    const result2 = await analyzer.analyzeSentiment('Identical content');

    expect(result1).toEqual(result2);
    expect(invoker).toHaveBeenCalledTimes(1); // Only called once
  });

  it('should not cache different content', async () => {
    const invoker = createMockInvoker(VALID_SENTIMENT);
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    await analyzer.analyzeSentiment('Content A');
    await analyzer.analyzeSentiment('Content B');

    expect(invoker).toHaveBeenCalledTimes(2);
  });

  it('clearCache should invalidate cache', async () => {
    const invoker = createMockInvoker(VALID_SENTIMENT);
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    await analyzer.analyzeSentiment('Test content');
    analyzer.clearCache();
    await analyzer.analyzeSentiment('Test content');

    expect(invoker).toHaveBeenCalledTimes(2);
  });
});

// ── Fallback to keyword analysis ────────────────────────────────────────────

describe('LLMSentimentAnalyzer keyword fallback', () => {
  it('should fall back to keyword analysis on invoker error', async () => {
    const invoker = createFailingInvoker();
    const analyzer = new LLMSentimentAnalyzer({ invoker, fallbackToKeyword: true });

    const result = await analyzer.analyzeSentiment('This is excellent and amazing!');
    expect(result.fromLLM).toBe(false);
    expect(result.sentiment).toBeGreaterThan(0);
  });

  it('should throw when fallback is disabled and invoker fails', async () => {
    const invoker = createFailingInvoker();
    const analyzer = new LLMSentimentAnalyzer({ invoker, fallbackToKeyword: false });

    await expect(analyzer.analyzeSentiment('Test content')).rejects.toThrow('LLM unavailable');
  });

  it('keyword fallback: positive words score positive', async () => {
    const invoker = createFailingInvoker();
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const result = await analyzer.analyzeSentiment('This is great and wonderful and amazing');
    expect(result.fromLLM).toBe(false);
    expect(result.sentiment).toBeGreaterThan(0);
  });

  it('keyword fallback: negative words score negative', async () => {
    const invoker = createFailingInvoker();
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const result = await analyzer.analyzeSentiment('terrible awful horrible disgusting');
    expect(result.fromLLM).toBe(false);
    expect(result.sentiment).toBeLessThan(0);
  });

  it('keyword fallback: neutral content scores zero', async () => {
    const invoker = createFailingInvoker();
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const result = await analyzer.analyzeSentiment('the meeting was held at noon');
    expect(result.fromLLM).toBe(false);
    expect(result.sentiment).toBe(0);
  });
});

// ── analyzeMoodImpact ───────────────────────────────────────────────────────

describe('LLMSentimentAnalyzer.analyzeMoodImpact', () => {
  it('should return zero deltas for empty content', async () => {
    const invoker = createMockInvoker({});
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const delta = await analyzer.analyzeMoodImpact('', CURRENT_MOOD);
    expect(delta.valence).toBe(0);
    expect(delta.arousal).toBe(0);
    expect(delta.dominance).toBe(0);
    expect(delta.trigger).toBe('empty content');
  });

  it('should return clamped deltas from LLM response', async () => {
    const invoker = createMockInvoker({
      valence: 0.2,
      arousal: -0.1,
      dominance: 0.05,
      trigger: 'positive news',
    });
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const delta = await analyzer.analyzeMoodImpact('Great news today!', CURRENT_MOOD);
    expect(delta.valence).toBe(0.2);
    expect(delta.arousal).toBe(-0.1);
    expect(delta.dominance).toBe(0.05);
    expect(delta.trigger).toBe('positive news');
  });

  it('should clamp mood deltas to [-0.3, 0.3]', async () => {
    const invoker = createMockInvoker({
      valence: 1.0,
      arousal: -1.0,
      dominance: 0.5,
      trigger: 'extreme event',
    });
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const delta = await analyzer.analyzeMoodImpact('Extreme event happened!', CURRENT_MOOD);
    expect(delta.valence).toBe(0.3);
    expect(delta.arousal).toBe(-0.3);
    expect(delta.dominance).toBe(0.3);
  });

  it('should fall back to keyword-derived delta on error', async () => {
    const invoker = createFailingInvoker();
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const delta = await analyzer.analyzeMoodImpact('This is wonderful and amazing', CURRENT_MOOD);
    // Keyword fallback derives deltas from keyword analysis (sentiment * 0.15)
    expect(delta.trigger).toContain('keyword-fallback');
    expect(typeof delta.valence).toBe('number');
    expect(typeof delta.arousal).toBe('number');
    expect(typeof delta.dominance).toBe('number');
  });
});

// ── analyzeConversationTone ─────────────────────────────────────────────────

describe('LLMSentimentAnalyzer.analyzeConversationTone', () => {
  it('should return stable profile for empty message array', async () => {
    const invoker = createMockInvoker(VALID_SENTIMENT);
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const profile = await analyzer.analyzeConversationTone([]);
    expect(profile.averageSentiment).toBe(0);
    expect(profile.averageArousal).toBe(0);
    expect(profile.trend).toBe('stable');
    expect(profile.messageCount).toBe(0);
  });

  it('should analyze multiple messages and compute averages', async () => {
    const invoker = createMockInvoker({
      sentiment: 0.5,
      arousal: 0.2,
      dominance: 0.0,
      reasoning: 'generally positive',
    });
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const profile = await analyzer.analyzeConversationTone([
      'Hello, this is great',
      'I love working on this',
      'This is wonderful',
    ]);

    expect(profile.messageCount).toBe(3);
    expect(profile.averageSentiment).toBeCloseTo(0.5, 1);
    expect(profile.averageArousal).toBeCloseTo(0.2, 1);
  });

  it('should detect improving trend when later messages are more positive', async () => {
    let callCount = 0;
    const invoker = vi.fn(async (_prompt: string) => {
      callCount++;
      // First half: negative, second half: positive
      const sentiment = callCount <= 3 ? -0.5 : 0.5;
      return JSON.stringify({
        sentiment,
        arousal: 0.1,
        dominance: 0.0,
        reasoning: 'test trend',
      });
    });

    const analyzer = new LLMSentimentAnalyzer({ invoker, cacheTtlMs: 0 });

    // Need at least 4 messages for trend detection
    const profile = await analyzer.analyzeConversationTone([
      'This is bad A',
      'This is bad B',
      'This is bad C',
      'This is great D',
      'This is great E',
      'This is great F',
    ]);

    expect(profile.messageCount).toBe(6);
    expect(profile.trend).toBe('improving');
  });

  it('should detect declining trend when later messages are more negative', async () => {
    let callCount = 0;
    const invoker = vi.fn(async (_prompt: string) => {
      callCount++;
      const sentiment = callCount <= 3 ? 0.5 : -0.5;
      return JSON.stringify({
        sentiment,
        arousal: 0.1,
        dominance: 0.0,
        reasoning: 'test decline',
      });
    });

    const analyzer = new LLMSentimentAnalyzer({ invoker, cacheTtlMs: 0 });

    const profile = await analyzer.analyzeConversationTone([
      'Great day A',
      'Great day B',
      'Great day C',
      'Terrible day D',
      'Terrible day E',
      'Terrible day F',
    ]);

    expect(profile.messageCount).toBe(6);
    expect(profile.trend).toBe('declining');
  });

  it('should detect stable trend when sentiment is consistent', async () => {
    const invoker = createMockInvoker({
      sentiment: 0.3,
      arousal: 0.1,
      dominance: 0.0,
      reasoning: 'stable positive',
    });
    const analyzer = new LLMSentimentAnalyzer({ invoker });

    const profile = await analyzer.analyzeConversationTone([
      'Fine day A',
      'Fine day B',
      'Fine day C',
      'Fine day D',
    ]);

    expect(profile.trend).toBe('stable');
  });
});
