// @ts-nocheck
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveEffectiveAgentConfig } from '../effective-agent-config.js';
import { PresetLoader } from '../../core/PresetLoader.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveEffectiveAgentConfig — AgentOS persona registry', () => {
  it('applies selected local persona defaults and preserves local PERSONA.md overlay', async () => {
    const dir = path.join(os.tmpdir(), `wunderland-persona-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(dir);
    mkdirSync(path.join(dir, 'personas'), { recursive: true });

    writeFileSync(
      path.join(dir, 'personas', 'custom_architect.json'),
      JSON.stringify({
        id: 'custom_architect',
        name: 'Custom Architect',
        description: 'Custom file-backed persona',
        version: '1.0.0',
        baseSystemPrompt: 'You are Custom Architect. Design systems carefully.',
        defaultProviderId: 'anthropic',
        defaultModelId: 'claude-3-5-sonnet',
        personalityTraits: {
          openness: 0.91,
          conscientiousness: 0.82,
        },
        memoryConfig: {
          enabled: true,
          ragConfig: {
            enabled: true,
            defaultRetrievalStrategy: 'hybrid_search',
            defaultRetrievalTopK: 8,
            dataSources: [
              {
                id: 'arch_docs',
                dataSourceNameOrId: 'architecture_docs',
                isEnabled: true,
              },
            ],
          },
        },
      }, null, 2),
      'utf8',
    );

    writeFileSync(path.join(dir, 'PERSONA.md'), 'Local persona overlay instructions.', 'utf8');

    const { agentConfig, selectedPersona, availablePersonas } = await resolveEffectiveAgentConfig({
      agentConfig: {
        seedId: 'seed_custom_architect',
        selectedPersonaId: 'custom_architect',
        personaRegistry: { enabled: true },
      },
      workingDirectory: dir,
    });

    expect(selectedPersona?.id).toBe('custom_architect');
    expect(selectedPersona?.source).toBe('file');
    expect(agentConfig.displayName).toBe('Custom Architect');
    expect(agentConfig.bio).toBe('Custom file-backed persona');
    expect(agentConfig.llmProvider).toBe('anthropic');
    expect(agentConfig.llmModel).toBe('claude-3-5-sonnet');
    expect(agentConfig.systemPrompt).toContain('You are Custom Architect. Design systems carefully.');
    expect(agentConfig.systemPrompt).toContain('Local persona overlay instructions.');
    expect(agentConfig.personality?.openness).toBeCloseTo(0.91, 5);
    expect(agentConfig.personality?.conscientiousness).toBeCloseTo(0.82, 5);
    expect(agentConfig.rag?.enabled).toBe(true);
    expect(agentConfig.rag?.strategy).toBe('hybrid_search');
    expect(agentConfig.rag?.defaultTopK).toBe(8);
    expect(agentConfig.rag?.collectionIds).toEqual(['architecture_docs']);
    expect(availablePersonas?.some((persona) => persona.id === 'custom_architect')).toBe(true);
  });
});

describe('resolveEffectiveAgentConfig — rag hyde merge', () => {
  it('deep merges rag.hyde between preset config and agent overrides', async () => {
    vi.spyOn(PresetLoader.prototype, 'loadPreset').mockReturnValue({
      id: 'test-preset',
      name: 'Test Preset',
      description: 'Preset used for HyDE merge testing',
      hexacoTraits: {
        honesty: 0.5,
        emotionality: 0.5,
        extraversion: 0.5,
        agreeableness: 0.5,
        conscientiousness: 0.5,
        openness: 0.5,
      },
      securityTier: 'trusted',
      suggestedSkills: [],
      suggestedChannels: [],
      rag: {
        enabled: true,
        hyde: {
          enabled: true,
          initialThreshold: 0.8,
          adaptiveThreshold: true,
        },
      },
      persona: 'Preset persona',
    });

    const { agentConfig } = await resolveEffectiveAgentConfig({
      agentConfig: {
        presetId: 'test-preset',
        rag: {
          enabled: true,
          hyde: {
            minThreshold: 0.4,
            fullAnswerGranularity: false,
          },
        },
      },
      workingDirectory: process.cwd(),
    });

    expect(agentConfig.rag?.hyde).toEqual({
      enabled: true,
      initialThreshold: 0.8,
      minThreshold: 0.4,
      adaptiveThreshold: true,
      fullAnswerGranularity: false,
    });
  });
});
