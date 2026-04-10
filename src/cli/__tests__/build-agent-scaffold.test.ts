// @ts-nocheck
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { buildAgentConfig, writeAgentScaffold } from '../helpers/build-agent-scaffold.js';

describe('buildAgentConfig', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('uses balanced human-reviewed defaults when no tier is specified', () => {
    const { config } = buildAgentConfig({ agentName: 'my-agent' });

    expect(config.permissionSet).toBe('supervised');
    expect(config.executionMode).toBe('human-dangerous');
    expect(config.toolAccessProfile).toBe('assistant');
    expect((config.observability as any)?.textLogs).toEqual({
      enabled: true,
      directory: './logs',
      includeToolCalls: true,
    });
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

  it('creates a logs directory with a nested gitignore when scaffolding', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'wunderland-scaffold-'));
    const { config } = buildAgentConfig({ agentName: 'my-agent' });

    await writeAgentScaffold({
      targetDir: tempDir,
      config,
      envData: {},
      agentName: 'my-agent',
    });

    const logsDir = path.join(tempDir, 'logs');
    const logsIgnore = path.join(logsDir, '.gitignore');
    expect(existsSync(logsDir)).toBe(true);
    expect(existsSync(logsIgnore)).toBe(true);
    expect(await readFile(logsIgnore, 'utf8')).toBe('*\n!.gitignore\n');
  });
});
