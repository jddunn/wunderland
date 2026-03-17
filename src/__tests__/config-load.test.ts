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
