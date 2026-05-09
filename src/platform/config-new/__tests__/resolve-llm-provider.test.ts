// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { resolveLlmProviderAndModel } from '../provider-defaults.js';

describe('resolveLlmProviderAndModel — precedence', () => {
  it('falls back to global config when no flags and no local agent.config.json (the wunderland-from-anywhere bug)', () => {
    const result = resolveLlmProviderAndModel({
      providerFlag: '',
      ollamaFlag: false,
      modelFlag: '',
      localCfg: null,
      globalCfg: { llmProvider: 'ollama', llmModel: 'qwen2.5:7b' },
    });
    expect(result.providerId).toBe('ollama');
    expect(result.model).toBe('qwen2.5:7b');
  });

  it('local agent.config.json wins over global config', () => {
    const result = resolveLlmProviderAndModel({
      localCfg: { llmProvider: 'openai', llmModel: 'gpt-4o-mini' },
      globalCfg: { llmProvider: 'ollama', llmModel: 'qwen2.5:7b' },
    });
    expect(result.providerId).toBe('openai');
    expect(result.model).toBe('gpt-4o-mini');
  });

  it('--provider flag wins over both local and global config', () => {
    const result = resolveLlmProviderAndModel({
      providerFlag: 'anthropic',
      localCfg: { llmProvider: 'openai' },
      globalCfg: { llmProvider: 'ollama' },
    });
    expect(result.providerId).toBe('anthropic');
  });

  it('--ollama flag wins over --provider flag', () => {
    const result = resolveLlmProviderAndModel({
      providerFlag: 'openai',
      ollamaFlag: true,
      localCfg: { llmProvider: 'openai' },
      globalCfg: { llmProvider: 'anthropic' },
    });
    expect(result.providerId).toBe('ollama');
  });

  it('defaults to openai when nothing configured anywhere', () => {
    const result = resolveLlmProviderAndModel({});
    expect(result.providerId).toBe('openai');
    expect(result.model).toBe('gpt-4o');
  });

  it('--model flag wins over local + global model', () => {
    const result = resolveLlmProviderAndModel({
      providerFlag: 'anthropic',
      modelFlag: 'claude-opus-4-7',
      localCfg: { llmModel: 'claude-sonnet-4-6' },
      globalCfg: { llmModel: 'claude-haiku-4-5-20251001' },
    });
    expect(result.providerId).toBe('anthropic');
    expect(result.model).toBe('claude-opus-4-7');
  });

  it('global config llmModel is honored when local cfg has no model', () => {
    const result = resolveLlmProviderAndModel({
      localCfg: null,
      globalCfg: { llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-6' },
    });
    expect(result.providerId).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('uses provider default model when no model flag, no local model, no global model', () => {
    const result = resolveLlmProviderAndModel({
      globalCfg: { llmProvider: 'ollama' },
    });
    expect(result.providerId).toBe('ollama');
    expect(result.model).toBe('llama3.2'); // ollama default in TEXT_PROVIDER_DEFAULTS
  });

  it('rejects unsupported provider in any source', () => {
    expect(() =>
      resolveLlmProviderAndModel({
        providerFlag: 'cohere-the-llm-provider',
      }),
    ).toThrow(/Unsupported provider/);
  });
});
