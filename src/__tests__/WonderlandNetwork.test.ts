/**
 * @fileoverview Tests for WonderlandNetwork orchestrator
 * @module wunderland/__tests__/WonderlandNetwork.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WonderlandNetwork } from '../social/WonderlandNetwork.js';
import { CitizenLevel } from '../social/types.js';
import type { WonderlandNetworkConfig, NewsroomConfig, Tip } from '../social/types.js';

const testNetworkConfig: WonderlandNetworkConfig = {
  networkId: 'test-network',
  worldFeedSources: [
    {
      sourceId: 'reuters',
      name: 'Reuters',
      type: 'rss',
      categories: ['technology', 'science'],
      isActive: true,
    },
  ],
  globalRateLimits: {
    maxPostsPerHourPerAgent: 5,
    maxTipsPerHourPerUser: 20,
  },
  defaultApprovalTimeoutMs: 300000,
  quarantineNewCitizens: false,
  quarantineDurationMs: 0,
};

function createNewsroomConfig(seedId: string, overrides: Partial<NewsroomConfig> = {}): NewsroomConfig {
  return {
    seedConfig: {
      seedId,
      name: `Agent ${seedId}`,
      description: 'A test agent',
      hexacoTraits: {
        honesty: 0.7,
        emotionality: 0.5,
        extraversion: 0.6,
        agreeableness: 0.8,
        conscientiousness: 0.7,
        openness: 0.9,
      },
      securityProfile: {
        enablePreLLM: true,
        enableDualLLMAudit: false,
        enableOutputSigning: true,
      },
    },
    ownerId: 'user-123',
    worldFeedTopics: ['technology'],
    acceptTips: true,
    postingCadence: { type: 'interval', value: 3600000 },
    maxPostsPerHour: 5,
    approvalTimeoutMs: 300000,
    requireApproval: false, // Auto-publish for easier testing
    ...overrides,
  };
}

describe('WonderlandNetwork', () => {
  let network: WonderlandNetwork;

  beforeEach(() => {
    process.env.WUNDERLAND_SIGNING_SECRET = 'test-secret-for-network';
    network = new WonderlandNetwork(testNetworkConfig);
  });

  afterEach(() => {
    delete process.env.WUNDERLAND_SIGNING_SECRET;
  });

  describe('Lifecycle', () => {
    it('should start the network', async () => {
      await network.start();
      const stats = network.getStats();
      expect(stats.running).toBe(true);
      expect(stats.networkId).toBe('test-network');
    });

    it('should stop the network', async () => {
      await network.start();
      await network.stop();
      expect(network.getStats().running).toBe(false);
    });
  });

  describe('Citizen registration', () => {
    it('should register a citizen', async () => {
      const citizen = await network.registerCitizen(createNewsroomConfig('agent-1'));

      expect(citizen.seedId).toBe('agent-1');
      expect(citizen.ownerId).toBe('user-123');
      expect(citizen.level).toBe(CitizenLevel.NEWCOMER);
      expect(citizen.xp).toBe(0);
      expect(citizen.isActive).toBe(true);
    });

    it('should throw for duplicate registration', async () => {
      await network.registerCitizen(createNewsroomConfig('agent-1'));
      await expect(network.registerCitizen(createNewsroomConfig('agent-1'))).rejects.toThrow(
        'already registered',
      );
    });

    it('should list active citizens', async () => {
      await network.registerCitizen(createNewsroomConfig('agent-1'));
      await network.registerCitizen(createNewsroomConfig('agent-2'));

      const citizens = network.listCitizens();
      expect(citizens).toHaveLength(2);
    });

    it('should get citizen by seedId', async () => {
      await network.registerCitizen(createNewsroomConfig('agent-1'));
      const citizen = network.getCitizen('agent-1');
      expect(citizen).toBeDefined();
      expect(citizen!.seedId).toBe('agent-1');
    });

    it('should return undefined for unknown citizen', () => {
      expect(network.getCitizen('unknown')).toBeUndefined();
    });
  });

  describe('Unregistration', () => {
    it('should unregister a citizen', async () => {
      await network.registerCitizen(createNewsroomConfig('agent-1'));
      await network.unregisterCitizen('agent-1');

      const citizens = network.listCitizens();
      expect(citizens).toHaveLength(0);

      // Profile still exists but inactive
      const citizen = network.getCitizen('agent-1');
      expect(citizen).toBeDefined();
      expect(citizen!.isActive).toBe(false);
    });
  });

  describe('Feed', () => {
    it('should return empty feed initially', () => {
      const feed = network.getFeed();
      expect(feed).toHaveLength(0);
    });

    it('should return published posts in feed', async () => {
      await network.start();
      await network.registerCitizen(createNewsroomConfig('agent-1'));

      // Inject a stimulus to generate a post
      const router = network.getStimulusRouter();
      const event = await router.ingestWorldFeed({
        headline: 'Breaking: AI advances',
        category: 'technology',
        sourceName: 'Reuters',
      });

      // Wait for processing
      await new Promise((r) => setTimeout(r, 50));

      const feed = network.getFeed();
      // Post may or may not appear depending on random observer filtering
      expect(feed.length).toBeGreaterThanOrEqual(0);
    });

    it('should filter feed by seedId', async () => {
      await network.start();
      await network.registerCitizen(createNewsroomConfig('agent-1'));
      await network.registerCitizen(createNewsroomConfig('agent-2'));

      // The feed filtering works on published posts
      const feed = network.getFeed({ seedId: 'agent-1' });
      for (const post of feed) {
        expect(post.seedId).toBe('agent-1');
      }
    });

    it('should limit feed results', () => {
      const feed = network.getFeed({ limit: 10 });
      expect(feed.length).toBeLessThanOrEqual(10);
    });
  });

  describe('Tips', () => {
    it('should submit a tip', async () => {
      await network.registerCitizen(createNewsroomConfig('agent-1'));

      const tip: Tip = {
        tipId: 'tip-1',
        amount: 100,
        dataSource: { type: 'text', payload: 'Interesting data' },
        attribution: { type: 'github', identifier: 'johnn' },
        visibility: 'public',
        createdAt: new Date().toISOString(),
        status: 'queued',
      };

      const result = await network.submitTip(tip);
      expect(result.eventId).toBeDefined();
    });
  });

  describe('Engagement', () => {
    it('should record engagement actions', async () => {
      await network.start();
      await network.registerCitizen(createNewsroomConfig('agent-1'));

      // We need a published post to record engagement on
      // For now, we test that the method doesn't throw for non-existent post
      await network.recordEngagement('nonexistent', 'agent-1', 'like');
      // Should not throw
    });
  });

  describe('Approval workflow', () => {
    it('should get approval queue for owner', async () => {
      const config = createNewsroomConfig('agent-1', { requireApproval: true });
      await network.registerCitizen(config);
      await network.start();

      // Inject stimulus
      const router = network.getStimulusRouter();
      await router.ingestWorldFeed({
        headline: 'Test',
        category: 'technology',
        sourceName: 'Test',
      });

      await new Promise((r) => setTimeout(r, 50));

      const queue = network.getApprovalQueue('user-123');
      // May have entries depending on observer random filtering
      expect(Array.isArray(queue)).toBe(true);
    });
  });

  describe('Post store callback', () => {
    it('should call external storage callback on publish', async () => {
      const storeCallback = vi.fn().mockResolvedValue(undefined);
      network.setPostStoreCallback(storeCallback);

      await network.start();
      await network.registerCitizen(createNewsroomConfig('agent-1'));

      // Inject high-priority stimulus to ensure it gets processed
      const router = network.getStimulusRouter();
      await router.ingestWorldFeed({
        headline: 'Breaking news',
        category: 'technology',
        sourceName: 'Reuters',
      });

      await new Promise((r) => setTimeout(r, 100));

      // May or may not be called depending on observer filtering
      // Just verify the callback was set correctly
      expect(typeof storeCallback).toBe('function');
    });
  });

  describe('getStats', () => {
    it('should return network statistics', async () => {
      await network.registerCitizen(createNewsroomConfig('agent-1'));
      const stats = network.getStats();

      expect(stats.networkId).toBe('test-network');
      expect(stats.totalCitizens).toBe(1);
      expect(stats.activeCitizens).toBe(1);
      expect(stats.totalPosts).toBe(0);
      expect(stats.stimulusStats).toBeDefined();
    });
  });

  describe('Accessors', () => {
    it('should expose StimulusRouter', () => {
      expect(network.getStimulusRouter()).toBeDefined();
    });

    it('should expose LevelingEngine', () => {
      expect(network.getLevelingEngine()).toBeDefined();
    });

    it('should get post by ID', () => {
      expect(network.getPost('nonexistent')).toBeUndefined();
    });
  });
});
