import { describe, expect, it } from 'vitest';

import { buildAgentConfig } from '../helpers/build-agent-scaffold.js';

describe('buildAgentConfig', () => {
  it('uses balanced human-reviewed defaults when no tier is specified', () => {
    const { config } = buildAgentConfig({ agentName: 'my-agent' });

    expect(config.permissionSet).toBe('supervised');
    expect(config.executionMode).toBe('human-dangerous');
    expect(config.toolAccessProfile).toBe('assistant');
  });

  it('inherits preset security, persona, discovery, and rag defaults', () => {
    const { config } = buildAgentConfig({
      agentName: 'research-bot',
      agentPreset: {
        id: 'research-assistant',
        name: 'Research Assistant',
        description: 'Thorough researcher',
        securityTier: 'balanced',
        toolAccessProfile: 'assistant',
        suggestedSkills: ['web-search'],
        suggestedChannels: ['webchat'],
        suggestedExtensions: { tools: ['web-search'] },
        discovery: { enabled: true, recallProfile: 'aggressive' },
        rag: { enabled: true, preset: 'accurate', includeGraphRag: true },
        persona: 'Preset persona',
        hexacoTraits: {
          honesty: 0.9,
          emotionality: 0.4,
          extraversion: 0.5,
          agreeableness: 0.7,
          conscientiousness: 0.9,
          openness: 0.8,
        },
      },
    });

    expect(config.systemPrompt).toBe('Preset persona');
    expect(config.presetId).toBe('research-assistant');
    expect(config.discovery).toEqual({ enabled: true, recallProfile: 'aggressive' });
    expect(config.rag).toEqual({ enabled: true, preset: 'accurate', includeGraphRag: true });
    expect(config.executionMode).toBe('human-dangerous');
  });
});
