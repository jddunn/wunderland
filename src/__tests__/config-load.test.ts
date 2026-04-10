// @ts-nocheck
import { afterEach, describe, expect, it } from 'vitest';

import { WunderlandConfigError } from '../config/errors.js';
import { resolveLlmConfig } from '../config/load.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('resolveLlmConfig', () => {
  it('uses the OpenAI-compatible Gemini base URL without a trailing slash', async () => {
    process.env['GEMINI_API_KEY'] = 'gemini-test-key';

    const result = await resolveLlmConfig({
      agentConfig: {
        llmProvider: 'gemini',
        llmModel: 'gemini-2.0-flash',
      },
    });

    expect(result.providerId).toBe('gemini');
    expect(result.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
  });

  it('treats direct provider apiKey overrides as usable for non-OpenAI providers', async () => {
    const [gemini, openrouter, anthropic] = await Promise.all([
      resolveLlmConfig({
        agentConfig: { llmProvider: 'gemini' },
        llm: { providerId: 'gemini', apiKey: 'gemini-direct-key' },
      }),
      resolveLlmConfig({
        agentConfig: { llmProvider: 'openrouter' },
        llm: { providerId: 'openrouter', apiKey: 'openrouter-direct-key' },
      }),
      resolveLlmConfig({
        agentConfig: { llmProvider: 'anthropic' },
        llm: { providerId: 'anthropic', apiKey: 'anthropic-direct-key' },
      }),
    ]);

    expect(gemini.canUseLLM).toBe(true);
    expect(openrouter.canUseLLM).toBe(true);
    expect(anthropic.canUseLLM).toBe(true);
  });

  it('uses provider-specific default models instead of leaking the OpenAI fallback', async () => {
    process.env['OPENAI_MODEL'] = 'gpt-4o-mini';
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-test-key';

    const result = await resolveLlmConfig({
      agentConfig: {
        llmProvider: 'anthropic',
      },
    });

    expect(result.providerId).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-20250514');
  });

  it('honors provider-specific model env overrides', async () => {
    process.env['ANTHROPIC_MODEL'] = 'claude-custom';
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-test-key';

    const result = await resolveLlmConfig({
      agentConfig: {
        llmProvider: 'anthropic',
      },
    });

    expect(result.model).toBe('claude-custom');
  });

  it('normalizes trailing slashes on explicit baseUrl overrides', async () => {
    const result = await resolveLlmConfig({
      agentConfig: {
        llmProvider: 'openrouter',
      },
      llm: {
        providerId: 'openrouter',
        apiKey: 'direct-key',
        baseUrl: 'https://openrouter.ai/api/v1/',
      },
    });

    expect(result.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('rejects disabled OpenAI OAuth auth mode', async () => {
    await expect(
      resolveLlmConfig({
        agentConfig: {
          llmProvider: 'openai',
          llmAuthMethod: 'oauth',
        },
      }),
    ).rejects.toMatchObject({
      name: 'WunderlandConfigError',
      issues: expect.arrayContaining([
        expect.objectContaining({ path: 'llmAuthMethod' }),
      ]),
    } satisfies Partial<WunderlandConfigError>);
  });
});
