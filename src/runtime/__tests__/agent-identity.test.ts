import { describe, expect, it } from 'vitest';

import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../../core/index.js';
import { resolveAgentDisplayName } from '../agent-identity.js';
import { buildAgenticSystemPrompt } from '../system-prompt-builder.js';
import type { NormalizedRuntimePolicy } from '../policy.js';

const POLICY: NormalizedRuntimePolicy = {
  securityTier: 'balanced',
  permissionSet: 'supervised',
  toolAccessProfile: 'assistant',
  executionMode: 'human-dangerous',
  wrapToolOutputs: true,
};

function makeSeed(name: string) {
  return createWunderlandSeed({
    seedId: 'seed_test',
    name,
    description: 'Test assistant',
    hexacoTraits: {
      honesty_humility: 0.8,
      emotionality: 0.5,
      extraversion: 0.6,
      agreeableness: 0.7,
      conscientiousness: 0.8,
      openness: 0.7,
    },
    securityProfile: DEFAULT_SECURITY_PROFILE,
    inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
    stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
  });
}

describe('agent-identity', () => {
  it('prefers displayName, then agentName, globalAgentName, and seedId', () => {
    expect(resolveAgentDisplayName({
      displayName: '  Local Bot  ',
      agentName: 'Config Bot',
      globalAgentName: 'Global Bot',
      seedId: 'seed_1',
      fallback: 'Fallback Bot',
    })).toBe('Local Bot');

    expect(resolveAgentDisplayName({
      displayName: '   ',
      agentName: 'Config Bot',
      globalAgentName: 'Global Bot',
      seedId: 'seed_1',
      fallback: 'Fallback Bot',
    })).toBe('Config Bot');

    expect(resolveAgentDisplayName({
      displayName: '',
      agentName: '',
      globalAgentName: 'Global Bot',
      seedId: 'seed_1',
      fallback: 'Fallback Bot',
    })).toBe('Global Bot');

    expect(resolveAgentDisplayName({
      displayName: '',
      agentName: '',
      globalAgentName: '',
      seedId: 'seed_1',
      fallback: 'Fallback Bot',
    })).toBe('seed_1');
  });

  it('falls back when no candidate names are present', () => {
    expect(resolveAgentDisplayName({
      displayName: '',
      agentName: undefined,
      globalAgentName: '   ',
      seedId: null,
      fallback: 'Fallback Bot',
    })).toBe('Fallback Bot');
  });
});

describe('system-prompt-builder identity fallback', () => {
  it('uses a deterministic identity line when baseSystemPrompt is blank', () => {
    const seed = makeSeed('Ava');
    (seed as any).baseSystemPrompt = '   ';

    const prompt = buildAgenticSystemPrompt({
      seed,
      policy: POLICY,
      mode: 'chat',
      lazyTools: false,
      autoApproveToolCalls: false,
    });

    expect(prompt).toContain('You are Ava, an adaptive AI assistant powered by Wunderland.');
    expect(prompt).not.toContain('\n\nundefined\n\n');
  });
});
