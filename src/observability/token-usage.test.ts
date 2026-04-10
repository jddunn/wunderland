// @ts-nocheck
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getRecordedAgentOSUsage } from '@framers/agentos';

import {
  getRecordedWunderlandSessionUsage,
  getRecordedWunderlandTokenUsage,
  globalTokenTracker,
  recordWunderlandTokenUsage,
  resetRecordedWunderlandTokenUsage,
} from './token-usage.js';

describe('token usage observability bridge', () => {
  let configDir: string;

  afterEach(async () => {
    delete process.env.AGENTOS_USAGE_LEDGER_PATH;
    delete process.env.WUNDERLAND_USAGE_LEDGER_PATH;
    if (configDir) {
      await resetRecordedWunderlandTokenUsage(configDir);
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('records prompt and completion tokens against the shared tracker and durable ledger', async () => {
    configDir = await mkdtemp(path.join(tmpdir(), 'wunderland-usage-'));
    globalTokenTracker.reset();

    await recordWunderlandTokenUsage({
      sessionId: 'session-1',
      providerId: 'openai',
      model: 'gpt-4o',
      configDirOverride: configDir,
      usage: {
        prompt_tokens: 120,
        completion_tokens: 45,
      },
    });

    const inProcessUsage = globalTokenTracker.getUsage();
    expect(inProcessUsage.totalPromptTokens).toBe(120);
    expect(inProcessUsage.totalCompletionTokens).toBe(45);
    expect(inProcessUsage.totalCalls).toBe(1);
    expect(inProcessUsage.perModel[0]?.model).toBe('gpt-4o');

    const persistedUsage = await getRecordedWunderlandTokenUsage(configDir);
    expect(persistedUsage.totalPromptTokens).toBe(120);
    expect(persistedUsage.totalCompletionTokens).toBe(45);
    expect(persistedUsage.totalCalls).toBe(1);
    expect(persistedUsage.perModel[0]?.model).toBe('gpt-4o');
  });

  it('filters persisted usage by session id', async () => {
    configDir = await mkdtemp(path.join(tmpdir(), 'wunderland-usage-'));

    await recordWunderlandTokenUsage({
      sessionId: 'session-a',
      providerId: 'openai',
      model: 'gpt-4o',
      configDirOverride: configDir,
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
      },
    });
    await recordWunderlandTokenUsage({
      sessionId: 'session-b',
      providerId: 'openai',
      model: 'gpt-4o',
      configDirOverride: configDir,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
      },
    });

    const sessionUsage = await getRecordedWunderlandSessionUsage('session-a', configDir);
    expect(sessionUsage.totalPromptTokens).toBe(10);
    expect(sessionUsage.totalCompletionTokens).toBe(5);
    expect(sessionUsage.totalCalls).toBe(1);
  });

  it('persists cost-only usage for non-token operations like image generation', async () => {
    configDir = await mkdtemp(path.join(tmpdir(), 'wunderland-usage-'));

    await recordWunderlandTokenUsage({
      sessionId: 'image-session',
      providerId: 'openai',
      model: 'gpt-image-1',
      source: 'image',
      configDirOverride: configDir,
      usage: {
        total_tokens: 0,
        totalCostUSD: 0.08,
      },
    });

    const usage = await getRecordedWunderlandTokenUsage(configDir);
    expect(usage.totalCalls).toBe(1);
    expect(usage.estimatedCostUSD).toBeCloseTo(0.08);
    expect(usage.perModel[0]?.model).toBe('gpt-image-1');
  });

  it('ignores empty models and zero-token zero-cost payloads', async () => {
    configDir = await mkdtemp(path.join(tmpdir(), 'wunderland-usage-'));
    globalTokenTracker.reset();

    await recordWunderlandTokenUsage({
      model: '',
      configDirOverride: configDir,
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
      },
    });
    await recordWunderlandTokenUsage({
      model: 'gpt-4o',
      configDirOverride: configDir,
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
      },
    });

    expect(globalTokenTracker.hasUsage()).toBe(false);
    const persistedUsage = await getRecordedWunderlandTokenUsage(configDir);
    expect(persistedUsage.totalCalls).toBe(0);
  });

  it('writes usage in a format readable by the shared AgentOS ledger', async () => {
    configDir = await mkdtemp(path.join(tmpdir(), 'wunderland-usage-'));
    const sharedLedgerPath = path.join(configDir, 'shared-usage-ledger.jsonl');
    process.env.AGENTOS_USAGE_LEDGER_PATH = sharedLedgerPath;

    await recordWunderlandTokenUsage({
      sessionId: 'shared-session',
      providerId: 'openai',
      model: 'gpt-4o',
      usage: {
        prompt_tokens: 9,
        completion_tokens: 4,
        total_tokens: 13,
        costUSD: 0.0013,
      },
    });

    await expect(getRecordedAgentOSUsage({ path: sharedLedgerPath, sessionId: 'shared-session' })).resolves.toEqual({
      sessionId: 'shared-session',
      personaId: undefined,
      promptTokens: 9,
      completionTokens: 4,
      totalTokens: 13,
      costUSD: 0.0013,
      calls: 1,
    });
  });
});
