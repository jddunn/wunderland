/**
 * @fileoverview Tests for WonderlandNetwork behavior telemetry.
 * @module wunderland/social/__tests__/WonderlandNetworkTelemetry.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WonderlandNetwork } from '../WonderlandNetwork.js';
import type {
  WonderlandNetworkConfig,
  NewsroomConfig,
  WonderlandPost,
} from '../types.js';
import type { WonderlandTelemetryEvent } from '../WonderlandNetwork.js';

const networkConfig: WonderlandNetworkConfig = {
  networkId: 'telemetry-test',
  worldFeedSources: [],
  globalRateLimits: {
    maxPostsPerHourPerAgent: 10,
    maxTipsPerHourPerUser: 20,
  },
  defaultApprovalTimeoutMs: 300000,
  quarantineNewCitizens: false,
  quarantineDurationMs: 0,
};

function createNewsroom(seedId: string, conscientiousness = 0.75): NewsroomConfig {
  return {
    seedConfig: {
      seedId,
      name: `Agent ${seedId}`,
      description: 'Telemetry integration test agent',
      hexacoTraits: {
        honesty_humility: 0.72,
        emotionality: 0.56,
        extraversion: 0.63,
        agreeableness: 0.66,
        conscientiousness,
        openness: 0.76,
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

describe('WonderlandNetwork behavior telemetry', () => {
  beforeEach(() => {
    process.env.WUNDERLAND_SIGNING_SECRET = 'test-signing-secret';
  });

  afterEach(() => {
    delete process.env.WUNDERLAND_SIGNING_SECRET;
  });

  it('tracks engagement impact and resulting mood drift telemetry', async () => {
    const network = new WonderlandNetwork(networkConfig);
    await network.registerCitizen(createNewsroom('seed-author'));
    await network.registerCitizen(createNewsroom('seed-reactor'));
    await network.initializeEnclaveSystem();
    await network.start();

    const publishedAt = new Date().toISOString();
    const post: WonderlandPost = {
      postId: 'post-1',
      seedId: 'seed-author',
      content: 'Telemetry target post',
      manifest: {} as any,
      status: 'published',
      createdAt: publishedAt,
      publishedAt,
      engagement: {
        likes: 0,
        downvotes: 0,
        boosts: 0,
        replies: 0,
        views: 0,
      },
      agentLevelAtPost: 1,
    };
    network.preloadPosts([post]);

    await network.recordEngagement('post-1', 'seed-reactor', 'like');

    const telemetry = network.getAgentBehaviorTelemetry('seed-author');
    expect(telemetry).toBeDefined();
    expect(telemetry!.engagement.received.likes).toBe(1);
    expect(telemetry!.engagement.moodDelta.valence).toBeGreaterThan(0);
    expect(telemetry!.mood.updates).toBeGreaterThanOrEqual(1);
    expect(telemetry!.mood.lastSource).toBe('engagement');
  });

  it('tracks dynamic voice archetype switches through telemetry events', async () => {
    const network = new WonderlandNetwork(networkConfig);
    await network.registerCitizen(createNewsroom('seed-voice', 0.86));
    await network.initializeEnclaveSystem();
    await network.start();

    network.setLLMCallbackForCitizen('seed-voice', async (messages) => {
      const systemPrompt = String(messages[0]?.content ?? '');
      if (systemPrompt.includes('reply relevance evaluator')) {
        return { content: 'YES', model: 'test-model' };
      }
      return { content: 'A tight, opinionated post with clear evidence.', model: 'test-model' };
    });

    const voiceEvents: WonderlandTelemetryEvent[] = [];
    network.onTelemetryUpdate((event) => {
      if (event.type === 'voice_profile') voiceEvents.push(event);
    });

    const router = network.getStimulusRouter();
    await router.ingestWorldFeed({
      headline: 'Breaking: critical infrastructure update shipped',
      category: 'technology',
      sourceName: 'Reuters',
      body: 'Emergency patch completed without downtime.',
    });

    const moodEngine = network.getMoodEngine()!;
    moodEngine.updateMood(
      'seed-voice',
      { valence: -0.5, arousal: 0.6, dominance: 0.45 },
      { trigger: 'test_provocative_shift' },
    );

    await router.emitInternalThought(
      'Challenge a weak assumption from the latest thread and propose a better model.',
      'seed-voice',
      'low',
    );

    const telemetry = network.getAgentBehaviorTelemetry('seed-voice');
    expect(telemetry).toBeDefined();
    expect(telemetry!.voice.updates).toBeGreaterThanOrEqual(2);
    expect(telemetry!.voice.archetypeSwitches).toBeGreaterThanOrEqual(1);
    expect(voiceEvents.some((e) => e.type === 'voice_profile' && e.switchedArchetype)).toBe(true);
  });
});
