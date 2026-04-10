// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';

import {
  buildResearchPrefix,
  classifyResearchDepth,
  createResearchClassifierLlmCall,
  resolveResearchClassifierModel,
  shouldInjectResearch,
  type ResearchDepth,
} from '../runtime/research-classifier.js';

describe('research-classifier', () => {
  it('returns none when disabled', async () => {
    const result = await classifyResearchDepth('latest stock price for NVDA', {
      enabled: false,
      llmCall: async () => '{"depth":"quick","reasoning":"current data"}',
    });

    expect(result).toEqual({
      depth: 'none',
      reasoning: 'classifier disabled',
      latencyMs: 0,
    });
  });

  it('uses override patterns before calling the model', async () => {
    let called = false;
    const result = await classifyResearchDepth('/deep tmj treatment plan', {
      enabled: true,
      llmCall: async () => {
        called = true;
        return '{"depth":"none","reasoning":"should not run"}';
      },
      overrides: [{ pattern: /^\/deep\b/i, depth: 'deep' }],
    });

    expect(result.depth).toBe('deep');
    expect(result.reasoning).toBe('matched override pattern');
    expect(result.latencyMs).toBe(0);
    expect(called).toBe(false);
  });

  it('parses a valid JSON response', async () => {
    const result = await classifyResearchDepth('compare the best laptop options for travel', {
      enabled: true,
      llmCall: async () => '{"depth":"moderate","reasoning":"needs comparison across sources"}',
    });

    expect(result.depth).toBe('moderate');
    expect(result.reasoning).toBe('needs comparison across sources');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('falls back to word matching when the model response is not valid JSON', async () => {
    const result = await classifyResearchDepth('tmj diagnosis and treatment options', {
      enabled: true,
      llmCall: async () => 'deep - medical diagnosis and treatment can cause harm if wrong',
    });

    expect(result.depth).toBe('deep');
    expect(result.reasoning).toBe('parsed from fallback word match');
  });

  it('returns none when no valid depth can be parsed', async () => {
    const result = await classifyResearchDepth('hello there', {
      enabled: true,
      llmCall: async () => 'I am not sure how to classify this request.',
    });

    expect(result.depth).toBe('none');
    expect(result.reasoning).toBe('parsed from fallback word match');
  });

  it('does not block the turn when classification fails', async () => {
    const result = await classifyResearchDepth('best cities for career change', {
      enabled: true,
      llmCall: async () => {
        throw new Error('temporary provider failure');
      },
    });

    expect(result.depth).toBe('none');
    expect(result.reasoning).toContain('classifier error: temporary provider failure');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('buildResearchPrefix', () => {
  const cases: Array<{ depth: ResearchDepth; expected: string | null }> = [
    { depth: 'none', expected: null },
    { depth: 'quick', expected: 'web_search' },
    { depth: 'moderate', expected: 'researchAggregate' },
    { depth: 'deep', expected: 'deep_research' },
  ];

  it.each(cases)('builds the expected prefix for $depth', ({ depth, expected }) => {
    const prefix = buildResearchPrefix(depth);

    if (expected === null) {
      expect(prefix).toBeNull();
      return;
    }

    expect(prefix).toContain(expected);
  });
});

describe('shouldInjectResearch', () => {
  it('respects the configured minimum depth threshold', () => {
    expect(shouldInjectResearch('none', 'quick')).toBe(false);
    expect(shouldInjectResearch('quick', 'quick')).toBe(true);
    expect(shouldInjectResearch('moderate', 'quick')).toBe(true);
    expect(shouldInjectResearch('moderate', 'deep')).toBe(false);
    expect(shouldInjectResearch('deep', 'moderate')).toBe(true);
  });
});

describe('createResearchClassifierLlmCall', () => {
  it('chooses the expected lightweight model per provider', () => {
    expect(resolveResearchClassifierModel('ollama')).toBe('qwen2.5:3b');
    expect(resolveResearchClassifierModel('gemini')).toBe('gemini-2.0-flash-lite');
    expect(resolveResearchClassifierModel('openai')).toBe('gpt-4o-mini');
  });

  it('posts to the shared chat-completions endpoint and returns model output', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"depth":"moderate","reasoning":"needs comparison"}' } }],
      }),
    })) as any;
    const llmCall = createResearchClassifierLlmCall({
      providerId: 'gemini',
      apiKey: 'gem-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      fetchImpl,
    });

    const response = await llmCall('system prompt', 'compare laptop options');

    expect(response).toContain('"moderate"');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer gem-key',
        }),
      }),
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe('gemini-2.0-flash-lite');
  });

  it('normalizes trailing slashes on the configured base URL', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"depth":"quick","reasoning":"current info"}' } }],
      }),
    })) as any;
    const llmCall = createResearchClassifierLlmCall({
      providerId: 'openai',
      apiKey: 'openai-key',
      baseUrl: 'https://api.openai.com/v1/',
      fetchImpl,
    });

    await llmCall('system prompt', 'latest weather');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.any(Object),
    );
  });

  it('falls back to a none classification payload on HTTP errors', async () => {
    const llmCall = createResearchClassifierLlmCall({
      fetchImpl: vi.fn(async () => ({ ok: false })) as any,
    });

    await expect(llmCall('system', 'query')).resolves.toBe('{"depth":"none","reasoning":"classifier request failed"}');
  });
});
