/**
 * @fileoverview Tests for SmallModelResolver — cheapest/fastest model resolution
 * @module wunderland/inference/__tests__/SmallModelResolver.test
 */

import { describe, it, expect } from 'vitest';
import { SmallModelResolver } from '../SmallModelResolver.js';

// ── resolveSmall: known providers ───────────────────────────────────────────

describe('SmallModelResolver.resolveSmall', () => {
  it('OpenAI primary resolves to gpt-4o-mini', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'openai' });
    const result = resolver.resolveSmall();
    expect(result.providerId).toBe('openai');
    expect(result.modelId).toBe('gpt-4o-mini');
  });

  it('Anthropic primary resolves to claude-haiku-4-5-20251001', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'anthropic' });
    const result = resolver.resolveSmall();
    expect(result.providerId).toBe('anthropic');
    expect(result.modelId).toBe('claude-haiku-4-5-20251001');
  });

  it('Ollama primary resolves to llama3.2:3b', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'ollama' });
    const result = resolver.resolveSmall();
    expect(result.providerId).toBe('ollama');
    expect(result.modelId).toBe('llama3.2:3b');
  });

  it('Gemini primary resolves to gemini-2.0-flash-lite', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'gemini' });
    const result = resolver.resolveSmall();
    expect(result.providerId).toBe('gemini');
    expect(result.modelId).toBe('gemini-2.0-flash-lite');
  });

  it('OpenRouter primary resolves to auto', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'openrouter' });
    const result = resolver.resolveSmall();
    expect(result.providerId).toBe('openrouter');
    expect(result.modelId).toBe('auto');
  });

  it('Bedrock primary resolves to anthropic.claude-haiku', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'bedrock' });
    const result = resolver.resolveSmall();
    expect(result.providerId).toBe('bedrock');
    expect(result.modelId).toBe('anthropic.claude-haiku');
  });

  it('Qwen primary resolves to qwen-turbo', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'qwen' });
    const result = resolver.resolveSmall();
    expect(result.providerId).toBe('qwen');
    expect(result.modelId).toBe('qwen-turbo');
  });

  it('Moonshot primary resolves to kimi-k2-instant', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'moonshot' });
    const result = resolver.resolveSmall();
    expect(result.providerId).toBe('moonshot');
    expect(result.modelId).toBe('kimi-k2-instant');
  });
});

// ── Unknown provider fallback ───────────────────────────────────────────────

describe('SmallModelResolver fallback for unknown providers', () => {
  it('unknown provider falls back to ollama/llama3.2:3b by default', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'some-random-provider' });
    const result = resolver.resolveSmall();
    expect(result.providerId).toBe('ollama');
    expect(result.modelId).toBe('llama3.2:3b');
  });

  it('unknown provider uses custom fallback provider', () => {
    const resolver = new SmallModelResolver({
      primaryProvider: 'some-random-provider',
      fallbackProvider: 'openai',
    });
    const result = resolver.resolveSmall();
    expect(result.providerId).toBe('openai');
    expect(result.modelId).toBe('gpt-4o-mini');
  });

  it('unknown provider uses custom fallback model override', () => {
    const resolver = new SmallModelResolver({
      primaryProvider: 'some-random-provider',
      fallbackProvider: 'openai',
      fallbackSmallModelOverride: 'my-custom-model',
    });
    const result = resolver.resolveSmall();
    expect(result.providerId).toBe('openai');
    expect(result.modelId).toBe('my-custom-model');
  });
});

// ── smallModelOverride takes precedence ─────────────────────────────────────

describe('SmallModelResolver smallModelOverride', () => {
  it('override takes precedence over mapping', () => {
    const resolver = new SmallModelResolver({
      primaryProvider: 'openai',
      smallModelOverride: 'my-custom-small-model',
    });
    const result = resolver.resolveSmall();
    expect(result.providerId).toBe('openai');
    expect(result.modelId).toBe('my-custom-small-model');
  });

  it('override takes precedence even for unknown providers', () => {
    const resolver = new SmallModelResolver({
      primaryProvider: 'unknown-provider',
      smallModelOverride: 'custom-model',
    });
    const result = resolver.resolveSmall();
    expect(result.providerId).toBe('unknown-provider');
    expect(result.modelId).toBe('custom-model');
  });
});

// ── resolveDefault ──────────────────────────────────────────────────────────

describe('SmallModelResolver.resolveDefault', () => {
  it('OpenAI returns gpt-4o', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'openai' });
    const result = resolver.resolveDefault();
    expect(result.providerId).toBe('openai');
    expect(result.modelId).toBe('gpt-4o');
  });

  it('Anthropic returns claude-sonnet-4-5-20250929', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'anthropic' });
    const result = resolver.resolveDefault();
    expect(result.providerId).toBe('anthropic');
    expect(result.modelId).toBe('claude-sonnet-4-5-20250929');
  });

  it('Ollama returns llama3', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'ollama' });
    const result = resolver.resolveDefault();
    expect(result.providerId).toBe('ollama');
    expect(result.modelId).toBe('llama3');
  });

  it('Gemini returns gemini-2.0-flash', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'gemini' });
    const result = resolver.resolveDefault();
    expect(result.providerId).toBe('gemini');
    expect(result.modelId).toBe('gemini-2.0-flash');
  });

  it('unknown provider returns auto', () => {
    const resolver = new SmallModelResolver({ primaryProvider: 'some-new-provider' });
    const result = resolver.resolveDefault();
    expect(result.providerId).toBe('some-new-provider');
    expect(result.modelId).toBe('auto');
  });
});

// ── isKnownProvider ─────────────────────────────────────────────────────────

describe('SmallModelResolver.isKnownProvider', () => {
  it('returns true for known providers', () => {
    expect(SmallModelResolver.isKnownProvider('openai')).toBe(true);
    expect(SmallModelResolver.isKnownProvider('anthropic')).toBe(true);
    expect(SmallModelResolver.isKnownProvider('ollama')).toBe(true);
    expect(SmallModelResolver.isKnownProvider('gemini')).toBe(true);
    expect(SmallModelResolver.isKnownProvider('bedrock')).toBe(true);
    expect(SmallModelResolver.isKnownProvider('openrouter')).toBe(true);
    expect(SmallModelResolver.isKnownProvider('qwen')).toBe(true);
    expect(SmallModelResolver.isKnownProvider('moonshot')).toBe(true);
    expect(SmallModelResolver.isKnownProvider('minimax')).toBe(true);
    expect(SmallModelResolver.isKnownProvider('venice')).toBe(true);
    expect(SmallModelResolver.isKnownProvider('cloudflare-ai')).toBe(true);
    expect(SmallModelResolver.isKnownProvider('xiaomi-mimo')).toBe(true);
    expect(SmallModelResolver.isKnownProvider('github-copilot')).toBe(true);
  });

  it('returns false for unknown providers', () => {
    expect(SmallModelResolver.isKnownProvider('nonexistent')).toBe(false);
    expect(SmallModelResolver.isKnownProvider('')).toBe(false);
    expect(SmallModelResolver.isKnownProvider('OpenAI')).toBe(false);
  });
});

// ── getSmallModelMap ────────────────────────────────────────────────────────

describe('SmallModelResolver.getSmallModelMap', () => {
  it('returns a map with all known providers', () => {
    const map = SmallModelResolver.getSmallModelMap();
    expect(map['openai']).toBe('gpt-4o-mini');
    expect(map['anthropic']).toBe('claude-haiku-4-5-20251001');
    expect(map['ollama']).toBe('llama3.2:3b');
    expect(map['gemini']).toBe('gemini-2.0-flash-lite');
  });

  it('returned map is a copy (mutating it does not affect internals)', () => {
    const map1 = SmallModelResolver.getSmallModelMap();
    (map1 as Record<string, string>)['openai'] = 'MUTATED';

    const map2 = SmallModelResolver.getSmallModelMap();
    expect(map2['openai']).toBe('gpt-4o-mini');
  });
});
