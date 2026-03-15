/**
 * @fileoverview Tests for two-tier extension settings merge logic.
 */

import { describe, it, expect } from 'vitest';
import { mergeExtensionOverrides } from '../cli/extensions/settings.js';

// Inline the merge logic (same as chat.ts / extension-loader.ts)
function mergeExtensionLists(
  agent: { tools?: string[]; voice?: string[]; productivity?: string[] } | undefined,
  global: { tools?: string[]; voice?: string[]; productivity?: string[] } | undefined,
  defaults: { tools: string[]; voice: string[]; productivity: string[] },
) {
  return {
    tools: agent?.tools ?? global?.tools ?? defaults.tools,
    voice: agent?.voice ?? global?.voice ?? defaults.voice,
    productivity: agent?.productivity ?? global?.productivity ?? defaults.productivity,
  };
}

describe('mergeExtensionLists', () => {
  const defaults = {
    tools: ['web-search', 'cli-executor'],
    voice: ['speech-runtime'],
    productivity: [],
  };

  it('uses hardcoded defaults when no config exists', () => {
    const result = mergeExtensionLists(undefined, undefined, defaults);
    expect(result.tools).toEqual(defaults.tools);
    expect(result.voice).toEqual(defaults.voice);
    expect(result.productivity).toEqual(defaults.productivity);
  });

  it('global config overrides defaults', () => {
    const global = { tools: ['web-search', 'image-generation'], voice: [], productivity: ['email-gmail'] };
    const result = mergeExtensionLists(undefined, global, defaults);
    expect(result.tools).toEqual(['web-search', 'image-generation']);
    expect(result.productivity).toEqual(['email-gmail']);
  });

  it('agent config overrides global config', () => {
    const global = { tools: ['web-search'], voice: [], productivity: [] };
    const agent = { tools: ['cli-executor', 'deep-research'], voice: ['elevenlabs'], productivity: [] };
    const result = mergeExtensionLists(agent, global, defaults);
    expect(result.tools).toEqual(['cli-executor', 'deep-research']);
    expect(result.voice).toEqual(['elevenlabs']);
  });

  it('partial agent config uses global for missing categories', () => {
    const global = { tools: ['web-search'], voice: ['speech-runtime'], productivity: ['email-gmail'] };
    const agent = { tools: ['cli-executor'] };
    const result = mergeExtensionLists(agent, global, defaults);
    expect(result.tools).toEqual(['cli-executor']);
    expect(result.voice).toEqual(['speech-runtime']);
    expect(result.productivity).toEqual(['email-gmail']);
  });

  it('empty agent array wins over global (explicit empty)', () => {
    const global = { tools: ['web-search', 'deep-research'], voice: [], productivity: [] };
    const agent = { tools: [] };
    const result = mergeExtensionLists(agent, global, defaults);
    expect(result.tools).toEqual([]);
  });
});

describe('mergeOverrides', () => {
  it('returns empty object when both undefined', () => {
    expect(mergeExtensionOverrides(undefined, undefined)).toEqual({});
  });

  it('returns global when no agent overrides', () => {
    const global = { 'web-search': { priority: 10 } };
    expect(mergeExtensionOverrides(global, undefined)).toEqual(global);
  });

  it('agent overrides win over global for same key', () => {
    const global = { 'web-search': { priority: 10 }, 'giphy': { priority: 50 } };
    const agent = { 'web-search': { priority: 5 } };
    const result = mergeExtensionOverrides(global, agent);
    expect(result['web-search']).toEqual({ priority: 5 });
    expect(result['giphy']).toEqual({ priority: 50 });
  });

  it('agent adds new keys not in global', () => {
    const global = { 'web-search': { priority: 10 } };
    const agent = { 'image-generation': { options: { defaultProvider: 'stability' } } };
    const result = mergeExtensionOverrides(global, agent);
    expect(result['web-search']).toEqual({ priority: 10 });
    expect(result['image-generation']).toEqual({ options: { defaultProvider: 'stability' } });
  });

  it('deep merges nested options for the same extension', () => {
    const global = { 'web-search': { priority: 10, options: { defaultProvider: 'serper', timeoutMs: 5000 } } };
    const agent = { 'web-search': { options: { defaultProvider: 'brave' } } };
    const result = mergeExtensionOverrides(global, agent);
    expect(result['web-search']).toEqual({
      priority: 10,
      options: { defaultProvider: 'brave', timeoutMs: 5000 },
    });
  });

  it('normalizes aliased override keys before merging', () => {
    const global = { 'google-calendar': { priority: 40 } };
    const agent = { 'calendar-google': { options: { refreshWindowDays: 7 } } };
    const result = mergeExtensionOverrides(global, agent);
    expect(result['calendar-google']).toEqual({
      priority: 40,
      options: { refreshWindowDays: 7 },
    });
  });
});
