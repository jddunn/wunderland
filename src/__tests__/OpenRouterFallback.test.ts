/**
 * @fileoverview Tests for openaiChatWithTools fallback behavior (OpenRouter, etc.)
 * @module wunderland/__tests__/OpenRouterFallback.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openaiChatWithTools } from '../cli/openai/tool-calling.js';
import type { LLMProviderConfig } from '../cli/openai/tool-calling.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successResponse(content: string = 'Hello', model: string = 'gpt-4o-mini') {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content } }],
        model,
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
  };
}

function errorResponse(status: number, body: string = 'error') {
  return {
    ok: false,
    status,
    text: async () => body,
  };
}

const defaultOpts = {
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  temperature: 0.2,
  maxTokens: 1400,
};

const openRouterFallback: LLMProviderConfig = {
  apiKey: 'sk-or-test',
  model: 'auto',
  baseUrl: 'https://openrouter.ai/api/v1',
  extraHeaders: {
    'HTTP-Referer': 'https://myapp.example.com',
    'X-Title': 'MyApp',
  },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Primary provider
// ---------------------------------------------------------------------------

describe('openaiChatWithTools — primary provider', () => {
  it('calls OpenAI endpoint by default when no baseUrl', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    await openaiChatWithTools({ ...defaultOpts });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('uses custom baseUrl when provided', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    await openaiChatWithTools({
      ...defaultOpts,
      baseUrl: 'https://custom-llm.example.com/v1',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://custom-llm.example.com/v1/chat/completions');
  });

  it('sends Authorization header with API key', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    await openaiChatWithTools({ ...defaultOpts });

    const [, reqInit] = mockFetch.mock.calls[0];
    expect(reqInit.headers.Authorization).toBe('Bearer sk-test');
  });

  it('returns parsed message, model, and usage', async () => {
    mockFetch.mockResolvedValueOnce(successResponse('world', 'gpt-4o'));

    const result = await openaiChatWithTools({ ...defaultOpts });

    expect(result.message).toEqual({ role: 'assistant', content: 'world' });
    expect(result.model).toBe('gpt-4o');
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it('throws error on non-200 response with status code in message', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(422, 'Unprocessable Entity'));

    await expect(openaiChatWithTools({ ...defaultOpts })).rejects.toThrow(/422/);
  });
});

// ---------------------------------------------------------------------------
// 2. Fallback behavior
// ---------------------------------------------------------------------------

describe('openaiChatWithTools — fallback behavior', () => {
  it('calls fallback when primary returns 429 (rate limit)', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(429, 'rate limited'))
      .mockResolvedValueOnce(successResponse('fallback response'));

    const result = await openaiChatWithTools({
      ...defaultOpts,
      fallback: openRouterFallback,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.message.content).toBe('fallback response');
  });

  it('calls fallback when primary returns 500 (server error)', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(500, 'internal server error'))
      .mockResolvedValueOnce(successResponse('fallback ok'));

    const result = await openaiChatWithTools({
      ...defaultOpts,
      fallback: openRouterFallback,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.message.content).toBe('fallback ok');
  });

  it('calls fallback when primary returns 502 (bad gateway)', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(502, 'bad gateway'))
      .mockResolvedValueOnce(successResponse('recovered'));

    const result = await openaiChatWithTools({
      ...defaultOpts,
      fallback: openRouterFallback,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.message.content).toBe('recovered');
  });

  it('calls fallback when primary returns 401 (auth failure)', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(401, 'unauthorized'))
      .mockResolvedValueOnce(successResponse('auth fallback'));

    const result = await openaiChatWithTools({
      ...defaultOpts,
      fallback: openRouterFallback,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.message.content).toBe('auth fallback');
  });

  it('does NOT call fallback when primary returns 400 (bad request — not retryable)', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(400, 'bad request'));

    await expect(
      openaiChatWithTools({
        ...defaultOpts,
        fallback: openRouterFallback,
      }),
    ).rejects.toThrow(/400/);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('calls fallback when fetch throws network error (ECONNREFUSED)', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'))
      .mockResolvedValueOnce(successResponse('network fallback'));

    const result = await openaiChatWithTools({
      ...defaultOpts,
      fallback: openRouterFallback,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.message.content).toBe('network fallback');
  });

  it('does NOT attempt fallback when no fallback configured (just re-throws)', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500, 'server down'));

    await expect(openaiChatWithTools({ ...defaultOpts })).rejects.toThrow(/500/);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('calls onFallback callback with error and provider name when falling back', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(429, 'rate limited'))
      .mockResolvedValueOnce(successResponse());

    const onFallback = vi.fn();

    await openaiChatWithTools({
      ...defaultOpts,
      fallback: openRouterFallback,
      onFallback,
    });

    expect(onFallback).toHaveBeenCalledTimes(1);
    const [primaryError, providerName] = onFallback.mock.calls[0];
    expect(primaryError).toBeInstanceOf(Error);
    expect(primaryError.message).toMatch(/429/);
    expect(providerName).toBe('OpenRouter');
  });
});

// ---------------------------------------------------------------------------
// 3. Fallback with OpenRouter specifics
// ---------------------------------------------------------------------------

describe('openaiChatWithTools — fallback with OpenRouter', () => {
  it('uses OpenRouter baseUrl for fallback request', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(500, 'primary down'))
      .mockResolvedValueOnce(successResponse('or response', 'openai/gpt-4o'));

    await openaiChatWithTools({
      ...defaultOpts,
      fallback: openRouterFallback,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [fallbackUrl] = mockFetch.mock.calls[1];
    expect(fallbackUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('sends extra headers from fallback config (HTTP-Referer, X-Title)', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(502, 'bad gateway'))
      .mockResolvedValueOnce(successResponse());

    await openaiChatWithTools({
      ...defaultOpts,
      fallback: openRouterFallback,
    });

    const [, fallbackReqInit] = mockFetch.mock.calls[1];
    expect(fallbackReqInit.headers['HTTP-Referer']).toBe('https://myapp.example.com');
    expect(fallbackReqInit.headers['X-Title']).toBe('MyApp');
  });

  it('uses fallback model (e.g. "auto") instead of primary model', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(429, 'rate limited'))
      .mockResolvedValueOnce(successResponse('auto response', 'auto'));

    await openaiChatWithTools({
      ...defaultOpts,
      fallback: openRouterFallback,
    });

    const [, fallbackReqInit] = mockFetch.mock.calls[1];
    const body = JSON.parse(fallbackReqInit.body);
    expect(body.model).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// 4. Fallback also fails
// ---------------------------------------------------------------------------

describe('openaiChatWithTools — fallback also fails', () => {
  it('throws fallback error when both primary and fallback fail', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(500, 'primary error'))
      .mockResolvedValueOnce(errorResponse(503, 'fallback also down'));

    await expect(
      openaiChatWithTools({
        ...defaultOpts,
        fallback: openRouterFallback,
      }),
    ).rejects.toThrow(/503/);
  });

  it('error message comes from fallback provider, not primary', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(500, 'PRIMARY_SPECIFIC_ERROR'))
      .mockResolvedValueOnce(errorResponse(503, 'FALLBACK_SPECIFIC_ERROR'));

    try {
      await openaiChatWithTools({
        ...defaultOpts,
        fallback: openRouterFallback,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('FALLBACK_SPECIFIC_ERROR');
      expect(message).not.toContain('PRIMARY_SPECIFIC_ERROR');
    }
  });
});
