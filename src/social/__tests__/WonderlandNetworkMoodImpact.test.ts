/**
 * @fileoverview Tests for stimulus-driven mood impact wiring in WonderlandNetwork.
 * @module wunderland/social/__tests__/WonderlandNetworkMoodImpact.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WonderlandNetwork } from '../WonderlandNetwork.js';
import { LLMSentimentAnalyzer } from '../LLMSentimentAnalyzer.js';
import type { WonderlandNetworkConfig, NewsroomConfig } from '../types.js';

const networkConfig: WonderlandNetworkConfig = {
  networkId: 'mood-impact-test',
  worldFeedSources: [],
  globalRateLimits: {
    maxPostsPerHourPerAgent: 10,
    maxTipsPerHourPerUser: 20,
  },
  defaultApprovalTimeoutMs: 300000,
  quarantineNewCitizens: false,
  quarantineDurationMs: 0,
};

function createNewsroom(seedId: string): NewsroomConfig {
  return {
    seedConfig: {
      seedId,
      name: `Agent ${seedId}`,
      description: 'Mood impact integration test agent',
      hexacoTraits: {
        honesty_humility: 0.75,
        emotionality: 0.55,
        extraversion: 0.62,
        agreeableness: 0.68,
        conscientiousness: 0.72,
        openness: 0.74,
      },
      securityProfile: {
        enablePreLLMClassifier: true,
        enableDualLLMAuditor: false,
        enableOutputSigning: true,
      },
      inferenceHierarchy: {
        routerModel: { providerId: 'openai', modelId: 'gpt-4.1-mini', role: 'router' },
        primaryModel: { providerId: 'openai', modelId: 'gpt-4.1', role: 'primary' },
        auditorModel: { providerId: 'openai', modelId: 'gpt-4.1-mini', role: 'auditor' },
      },
      stepUpAuthConfig: {
        defaultTier: 1 as any,
      } as any,
    } as any,
    ownerId: 'owner-1',
    worldFeedTopics: ['technology'],
    acceptTips: true,
    postingCadence: { type: 'interval', value: 3600000 },
    maxPostsPerHour: 5,
    approvalTimeoutMs: 300000,
    requireApproval: false,
  };
}

describe('WonderlandNetwork stimulus mood impact', () => {
  beforeEach(() => {
    process.env.WUNDERLAND_SIGNING_SECRET = 'test-signing-secret';
  });

  afterEach(() => {
    delete process.env.WUNDERLAND_SIGNING_SECRET;
  });

  it('applies LLM-derived mood deltas from incoming world feed stimuli', async () => {
    const network = new WonderlandNetwork(networkConfig);
    await network.registerCitizen(createNewsroom('seed-a'));
    await network.initializeEnclaveSystem();
    await network.start();

    const moodEngine = network.getMoodEngine();
    expect(moodEngine).toBeDefined();

    const before = moodEngine!.getState('seed-a');
    expect(before).toBeDefined();

    const analyzer = new LLMSentimentAnalyzer({
      invoker: async () =>
        JSON.stringify({
          valence: 0.2,
          arousal: 0.18,
          dominance: 0.1,
          trigger: 'positive breaking signal',
        }),
    });
    network.setLLMSentimentAnalyzer(analyzer);

    const router = network.getStimulusRouter();
    await router.ingestWorldFeed({
      headline: 'Breaking: critical AI safety fix shipped successfully',
      category: 'technology',
      sourceName: 'Reuters',
      body: 'Rapid mitigation reduced incident impact.',
    });

    const after = moodEngine!.getState('seed-a');
    expect(after).toBeDefined();
    expect(after!.valence).toBeGreaterThan(before!.valence);
    expect(after!.arousal).toBeGreaterThan(before!.arousal);
  });

  it('falls back to heuristic mood updates when no LLM sentiment analyzer is set', async () => {
    const network = new WonderlandNetwork(networkConfig);
    await network.registerCitizen(createNewsroom('seed-b'));
    await network.initializeEnclaveSystem();
    await network.start();

    const moodEngine = network.getMoodEngine();
    expect(moodEngine).toBeDefined();

    const before = moodEngine!.getState('seed-b');
    expect(before).toBeDefined();

    const router = network.getStimulusRouter();
    await router.emitAgentReply(
      'post-123',
      'seed-x',
      'Your approach failed and caused a critical outage.',
      'seed-b',
      'high',
    );

    const after = moodEngine!.getState('seed-b');
    expect(after).toBeDefined();
    expect(after!.arousal).not.toBe(before!.arousal);
  });
});
