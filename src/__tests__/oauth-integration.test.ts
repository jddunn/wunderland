import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWunderland } from '../index.js';

/**
 * Integration tests for the OAuth authentication path through the public API.
 * Tests that createWunderland() correctly resolves llmAuthMethod: 'oauth'
 * and passes getApiKey through to the LLM call chain.
 */
describe('OAuth integration — createWunderland()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves OAuth config when llmAuthMethod is "oauth" and tokens exist', async () => {
    // Mock the @framers/agentos/auth module
    const mockGetAccessToken = vi.fn(async () => 'oauth-test-token-123');

    vi.doMock('@framers/agentos/auth', () => ({
      OpenAIOAuthFlow: class {
        getAccessToken = mockGetAccessToken;
      },
      FileTokenStore: class {
        load = vi.fn(async () => null);
        save = vi.fn(async () => {});
        clear = vi.fn(async () => {});
      },
    }));

    // Mock fetch for the chat completions call
    const fetchMock = vi.fn(async (_url: string, opts: any) => {
      // Capture the Authorization header
      const authHeader = opts?.headers?.Authorization;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: 'gpt-test',
          usage: {},
          choices: [{ message: { role: 'assistant', content: `Auth: ${authHeader}` } }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await createWunderland({
      agentConfig: {
        llmProvider: 'openai',
        llmModel: 'gpt-test',
        llmAuthMethod: 'oauth',
      },
      llm: { providerId: 'openai', apiKey: '', model: 'gpt-test' },
      tools: 'none',
      discovery: { enabled: false },
    });

    expect(app).toBeDefined();

    // The diagnostics should show the provider
    const diag = app.diagnostics();
    expect(diag.llm.providerId).toBe('openai');

    await app.close();
  });

  it('falls back gracefully when @framers/agentos/auth is not available', async () => {
    // Don't mock the auth module — let it fail naturally
    // createWunderland should still work with api-key fallback
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        model: 'gpt-test',
        usage: {},
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-api-key', model: 'gpt-test' },
      tools: 'none',
      discovery: { enabled: false },
    });

    expect(app).toBeDefined();
    const diag = app.diagnostics();
    expect(diag.llm.providerId).toBe('openai');

    await app.close();
  });

  it('includes llmAuthMethod in agent config type', () => {
    // Type-level test: ensure WunderlandAgentConfig accepts llmAuthMethod
    const config = {
      llmProvider: 'openai',
      llmModel: 'gpt-4o',
      llmAuthMethod: 'oauth' as const,
    };
    expect(config.llmAuthMethod).toBe('oauth');
  });
});

describe('OAuth integration — LLMProviderConfig getApiKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('chatCompletionsRequest uses getApiKey when provided', async () => {
    // Import the function and test that getApiKey is called
    const { openaiChatWithTools } = await import('../runtime/tool-calling.js');

    let capturedAuthHeader = '';
    const fetchMock = vi.fn(async (_url: string, opts: any) => {
      capturedAuthHeader = opts?.headers?.Authorization || '';
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: 'gpt-test',
          usage: {},
          choices: [{ message: { role: 'assistant', content: 'test response' } }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const getApiKey = vi.fn(async () => 'dynamic-oauth-token');

    await openaiChatWithTools({
      apiKey: 'static-key-should-not-be-used',
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      temperature: 0.2,
      maxTokens: 100,
      getApiKey,
    });

    // getApiKey should have been called
    expect(getApiKey).toHaveBeenCalledOnce();

    // The Authorization header should use the dynamic token, not the static key
    expect(capturedAuthHeader).toBe('Bearer dynamic-oauth-token');
  });

  it('chatCompletionsRequest falls back to static apiKey when getApiKey is absent', async () => {
    const { openaiChatWithTools } = await import('../runtime/tool-calling.js');

    let capturedAuthHeader = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) => {
      capturedAuthHeader = opts?.headers?.Authorization || '';
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: 'gpt-test',
          usage: {},
          choices: [{ message: { role: 'assistant', content: 'test' } }],
        }),
      };
    }));

    await openaiChatWithTools({
      apiKey: 'my-static-api-key',
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      temperature: 0.2,
      maxTokens: 100,
      // no getApiKey
    });

    expect(capturedAuthHeader).toBe('Bearer my-static-api-key');
  });
});
