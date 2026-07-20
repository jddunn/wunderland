import { describe, it, expect } from 'vitest';
import { resolveMissionModel, assertQualityFloor, type MissionModel } from '../mission-model-flags.js';

const runtime: MissionModel = {
  providerId: 'openai',
  model: 'gpt-4o',
  apiKey: 'rt-key',
  baseUrl: 'https://api.openai.com/v1',
};

const providerEnv: Record<string, string | undefined> = {
  OPENAI_API_KEY: 'oa',
  ANTHROPIC_API_KEY: 'an',
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  OPENROUTER_API_KEY: 'or',
};

describe('resolveMissionModel', () => {
  it('returns runtime defaults when no flag is given', () => {
    expect(resolveMissionModel(undefined, runtime, providerEnv)).toEqual(runtime);
  });

  it('splits provider/model on the FIRST slash only (multi-segment model ids survive)', () => {
    const r = resolveMissionModel('openrouter/anthropic/claude-sonnet-5', runtime, providerEnv);
    expect(r.providerId).toBe('openrouter');
    expect(r.model).toBe('anthropic/claude-sonnet-5');
  });

  it('resolves the API key + baseUrl for the SELECTED provider, not the runtime default', () => {
    const r = resolveMissionModel('anthropic/claude-sonnet-5', runtime, providerEnv);
    expect(r.providerId).toBe('anthropic');
    expect(r.apiKey).toBe('an'); // NOT 'rt-key' — no cross-provider key leak
    expect(r.baseUrl).toBe('https://api.anthropic.com');
  });

  it('bare model with no slash keeps the runtime provider + key', () => {
    const r = resolveMissionModel('gpt-4o-mini', runtime, providerEnv);
    expect(r.providerId).toBe('openai');
    expect(r.model).toBe('gpt-4o-mini');
    expect(r.apiKey).toBe('rt-key');
  });

  it('honors an unknown provider but keeps runtime credentials', () => {
    const r = resolveMissionModel('customcloud/some-model', runtime, providerEnv);
    expect(r.providerId).toBe('customcloud');
    expect(r.model).toBe('some-model');
    expect(r.apiKey).toBe('rt-key');
  });

  it('throws when the selected known provider has no key in env', () => {
    expect(() => resolveMissionModel('anthropic/x', runtime, {})).toThrow(/no API key/i);
  });
});

describe('assertQualityFloor', () => {
  it('rejects a local model when the assistant floor is required', () => {
    expect(() =>
      assertQualityFloor(
        { providerId: 'ollama', model: 'qwen2.5:7b', apiKey: 'x' },
        { requireNonLocal: true, source: 'config.json' },
      ),
    ).toThrow(/below the assistant quality floor.*config\.json/i);
  });

  it('passes a cloud model', () => {
    expect(
      assertQualityFloor(
        { providerId: 'anthropic', model: 'claude-sonnet-5', apiKey: 'x' },
        { requireNonLocal: true, source: 'flag' },
      ).model,
    ).toBe('claude-sonnet-5');
  });

  it('is a no-op when the floor is not required', () => {
    const m: MissionModel = { providerId: 'ollama', model: 'qwen2.5:7b', apiKey: 'x' };
    expect(assertQualityFloor(m, { requireNonLocal: false })).toBe(m);
  });
});
