/**
 * @fileoverview Tests for WonderlandNetwork — main social network orchestrator.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the bare @framers/agentos import that pulls in AgentOS (which needs utils/errors)
vi.mock('@framers/agentos', () => ({
  resolveAgentWorkspaceBaseDir: () => '/tmp/wunderland-test-workspaces',
  resolveAgentWorkspaceDir: (seedId: string, base: string) => `${base}/${seedId}`,
}));

import { WonderlandNetwork } from '../WonderlandNetwork.js';
import type {
  WonderlandNetworkConfig,
  WonderlandPost,
  CitizenLevel,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<WonderlandNetworkConfig>): WonderlandNetworkConfig {
  return {
    networkId: 'test-network',
    worldFeedSources: [],
    globalRateLimits: { maxPostsPerHourPerAgent: 10, maxTipsPerHourPerUser: 20 },
    defaultApprovalTimeoutMs: 60_000,
    quarantineNewCitizens: false,
    quarantineDurationMs: 0,
    ...overrides,
  };
}

function makePost(overrides?: Partial<WonderlandPost>): WonderlandPost {
  return {
    postId: `post-${Math.random().toString(36).slice(2, 8)}`,
    seedId: 'agent-1',
    content: 'Test post content',
    manifest: {
      stimulusId: 'stim-1',
      stimulusType: 'world_feed',
      stimulusHash: 'hash-123',
      agentSeedId: 'agent-1',
      generatedAt: new Date().toISOString(),
      toolsUsed: [],
    } as any,
    status: 'published',
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0, views: 0 },
    agentLevelAtPost: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WonderlandNetwork', () => {
  let network: WonderlandNetwork;

  beforeEach(() => {
    network = new WonderlandNetwork(makeConfig());
  });

  // ── Constructor & Lifecycle ──

  describe('constructor', () => {
    it('should create a network with the given config', () => {
      const stats = network.getStats();
      expect(stats.networkId).toBe('test-network');
      expect(stats.running).toBe(false);
      expect(stats.totalCitizens).toBe(0);
      expect(stats.totalPosts).toBe(0);
    });

    it('should register world feed sources from config', () => {
      const net = new WonderlandNetwork(makeConfig({
        worldFeedSources: [
          { sourceId: 'reuters', name: 'Reuters', type: 'rss', categories: ['world'], isActive: true },
        ],
      }));
      const router = net.getStimulusRouter();
      expect(router.listWorldFeedSources()).toHaveLength(1);
    });

    it('should accept social dynamics config for pairwise damping', () => {
      const net = new WonderlandNetwork(makeConfig({
        socialDynamics: {
          pairwiseInfluenceDamping: {
            enabled: false,
          },
        },
      }));
      expect(net.getStats().networkId).toBe('test-network');
    });
  });

  describe('start / stop', () => {
    it('should set running to true on start', async () => {
      await network.start();
      expect(network.getStats().running).toBe(true);
    });

    it('should set running to false on stop', async () => {
      await network.start();
      await network.stop();
      expect(network.getStats().running).toBe(false);
    });
  });

  // ── Getters & Setters ──

  describe('getStats', () => {
    it('should return network statistics', () => {
      const stats = network.getStats();
      expect(stats).toMatchObject({
        networkId: 'test-network',
        running: false,
        totalCitizens: 0,
        activeCitizens: 0,
        totalPosts: 0,
      });
      expect(stats.stimulusStats).toBeDefined();
      expect(stats.enclaveSystem.initialized).toBe(false);
    });
  });

  describe('getStimulusRouter', () => {
    it('should return the stimulus router', () => {
      const router = network.getStimulusRouter();
      expect(router).toBeDefined();
      expect(typeof router.subscribe).toBe('function');
    });
  });

  describe('getLevelingEngine', () => {
    it('should return the leveling engine', () => {
      const engine = network.getLevelingEngine();
      expect(engine).toBeDefined();
    });
  });

  describe('setPostStoreCallback', () => {
    it('should set without error', () => {
      const cb = vi.fn();
      expect(() => network.setPostStoreCallback(cb)).not.toThrow();
    });
  });

  describe('setEngagementStoreCallback', () => {
    it('should set without error', () => {
      const cb = vi.fn();
      expect(() => network.setEngagementStoreCallback(cb)).not.toThrow();
    });
  });

  describe('setEmojiReactionStoreCallback', () => {
    it('should set without error', () => {
      const cb = vi.fn();
      expect(() => network.setEmojiReactionStoreCallback(cb)).not.toThrow();
    });
  });

  describe('onTelemetryUpdate', () => {
    it('should register callback without error', () => {
      const cb = vi.fn();
      expect(() => network.onTelemetryUpdate(cb)).not.toThrow();
    });
  });

  describe('setLLMSentimentAnalyzer', () => {
    it('should accept undefined', () => {
      expect(() => network.setLLMSentimentAnalyzer(undefined)).not.toThrow();
    });
  });

  // ── Posts & Feed ──

  describe('preloadPosts', () => {
    it('should load posts into the network', () => {
      const post1 = makePost({ postId: 'p-1' });
      const post2 = makePost({ postId: 'p-2' });
      network.preloadPosts([post1, post2]);

      expect(network.getPost('p-1')).toMatchObject({ postId: 'p-1' });
      expect(network.getPost('p-2')).toMatchObject({ postId: 'p-2' });
    });
  });

  describe('getPost', () => {
    it('should return undefined for unknown post', () => {
      expect(network.getPost('nonexistent')).toBeUndefined();
    });
  });

  describe('getFeed', () => {
    it('should return published posts sorted by publishedAt', () => {
      const oldPost = makePost({
        postId: 'old',
        publishedAt: '2024-01-01T00:00:00Z',
        status: 'published',
      });
      const newPost = makePost({
        postId: 'new',
        publishedAt: '2025-01-01T00:00:00Z',
        status: 'published',
      });
      network.preloadPosts([oldPost, newPost]);

      const feed = network.getFeed();
      expect(feed).toHaveLength(2);
      expect(feed[0].postId).toBe('new');
      expect(feed[1].postId).toBe('old');
    });

    it('should filter by seedId', () => {
      network.preloadPosts([
        makePost({ postId: 'a1', seedId: 'agent-1' }),
        makePost({ postId: 'a2', seedId: 'agent-2' }),
      ]);
      const feed = network.getFeed({ seedId: 'agent-1' });
      expect(feed).toHaveLength(1);
      expect(feed[0].postId).toBe('a1');
    });

    it('should limit results', () => {
      network.preloadPosts(
        Array.from({ length: 10 }, (_, i) =>
          makePost({ postId: `p-${i}`, publishedAt: new Date(Date.now() - i * 1000).toISOString() }),
        ),
      );
      const feed = network.getFeed({ limit: 3 });
      expect(feed).toHaveLength(3);
    });

    it('should exclude non-published posts', () => {
      network.preloadPosts([
        makePost({ postId: 'published', status: 'published' }),
        makePost({ postId: 'draft', status: 'pending_approval' as any }),
      ]);
      const feed = network.getFeed();
      expect(feed).toHaveLength(1);
      expect(feed[0].postId).toBe('published');
    });
  });

  // ── Citizen Management ──

  describe('getCitizen / listCitizens', () => {
    it('should return undefined for unknown citizen', () => {
      expect(network.getCitizen('unknown')).toBeUndefined();
    });

    it('should return empty list when no citizens', () => {
      expect(network.listCitizens()).toEqual([]);
    });
  });

  // ── Engagement ──

  describe('recordEngagement', () => {
    it('should increment likes on a preloaded post', async () => {
      const post = makePost({ postId: 'eng-1', seedId: 'author-1' });
      network.preloadPosts([post]);

      await network.recordEngagement('eng-1', 'voter-1', 'like');
      const updated = network.getPost('eng-1');
      expect(updated?.engagement.likes).toBe(1);
    });

    it('should increment downvotes', async () => {
      const post = makePost({ postId: 'eng-2', seedId: 'author-1' });
      network.preloadPosts([post]);

      await network.recordEngagement('eng-2', 'voter-1', 'downvote');
      expect(network.getPost('eng-2')?.engagement.downvotes).toBe(1);
    });

    it('should increment views', async () => {
      const post = makePost({ postId: 'eng-3', seedId: 'author-1' });
      network.preloadPosts([post]);

      await network.recordEngagement('eng-3', 'viewer-1', 'view');
      expect(network.getPost('eng-3')?.engagement.views).toBe(1);
    });

    it('should increment boosts', async () => {
      const post = makePost({ postId: 'eng-4', seedId: 'author-1' });
      network.preloadPosts([post]);

      await network.recordEngagement('eng-4', 'booster-1', 'boost');
      expect(network.getPost('eng-4')?.engagement.boosts).toBe(1);
    });

    it('should increment replies', async () => {
      const post = makePost({ postId: 'eng-5', seedId: 'author-1' });
      network.preloadPosts([post]);

      await network.recordEngagement('eng-5', 'replier-1', 'reply');
      expect(network.getPost('eng-5')?.engagement.replies).toBe(1);
    });

    it('should no-op for unknown post', async () => {
      await network.recordEngagement('nonexistent', 'voter-1', 'like');
      // Should not throw
    });

    it('should dedup votes (same actor, same post)', async () => {
      const post = makePost({ postId: 'dedup-1', seedId: 'author-1' });
      network.preloadPosts([post]);

      await network.recordEngagement('dedup-1', 'voter-1', 'like');
      await network.recordEngagement('dedup-1', 'voter-1', 'like');
      expect(network.getPost('dedup-1')?.engagement.likes).toBe(1);
    });

    it('should allow different actors to vote on same post', async () => {
      const post = makePost({ postId: 'multi-1', seedId: 'author-1' });
      network.preloadPosts([post]);

      await network.recordEngagement('multi-1', 'voter-1', 'like');
      await network.recordEngagement('multi-1', 'voter-2', 'like');
      expect(network.getPost('multi-1')?.engagement.likes).toBe(2);
    });

    it('should call engagementStoreCallback on vote', async () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      network.setEngagementStoreCallback(cb);

      const post = makePost({ postId: 'cb-1', seedId: 'author-1' });
      network.preloadPosts([post]);
      await network.recordEngagement('cb-1', 'voter-1', 'like');

      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'cb-1',
          actorSeedId: 'voter-1',
          actionType: 'like',
        }),
      );
    });
  });

  // ── Emoji Reactions ──

  describe('recordEmojiReaction', () => {
    it('should record an emoji reaction on a post', async () => {
      const post = makePost({ postId: 'emoji-1', seedId: 'author-1' });
      network.preloadPosts([post]);

      const result = await network.recordEmojiReaction('post', 'emoji-1', 'reactor-1', 'fire');
      expect(result).toBe(true);
    });

    it('should dedup: same agent + same emoji = false on second call', async () => {
      const post = makePost({ postId: 'emoji-2', seedId: 'author-1' });
      network.preloadPosts([post]);

      await network.recordEmojiReaction('post', 'emoji-2', 'reactor-1', 'fire');
      const second = await network.recordEmojiReaction('post', 'emoji-2', 'reactor-1', 'fire');
      expect(second).toBe(false);
    });

    it('should allow different emoji types from same agent', async () => {
      const post = makePost({ postId: 'emoji-3', seedId: 'author-1' });
      network.preloadPosts([post]);

      const r1 = await network.recordEmojiReaction('post', 'emoji-3', 'reactor-1', 'fire');
      const r2 = await network.recordEmojiReaction('post', 'emoji-3', 'reactor-1', 'brain');
      expect(r1).toBe(true);
      expect(r2).toBe(true);
    });

    it('should update reaction counts on the post', async () => {
      const post = makePost({ postId: 'emoji-4', seedId: 'author-1' });
      network.preloadPosts([post]);

      await network.recordEmojiReaction('post', 'emoji-4', 'r1', 'fire');
      await network.recordEmojiReaction('post', 'emoji-4', 'r2', 'fire');

      const reactions = network.getEmojiReactions('post', 'emoji-4');
      expect(reactions.fire).toBe(2);
    });

    it('should call emojiReactionStoreCallback', async () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      network.setEmojiReactionStoreCallback(cb);

      const post = makePost({ postId: 'emoji-cb', seedId: 'author-1' });
      network.preloadPosts([post]);

      await network.recordEmojiReaction('post', 'emoji-cb', 'reactor-1', 'fire');
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'post',
          entityId: 'emoji-cb',
          reactorSeedId: 'reactor-1',
          emoji: 'fire',
        }),
      );
    });
  });

  describe('getEmojiReactions', () => {
    it('should return empty object for unknown entity', () => {
      expect(network.getEmojiReactions('post', 'unknown')).toEqual({});
    });

    it('should return empty object for comment type (not tracked in-memory)', () => {
      expect(network.getEmojiReactions('comment', 'any-id')).toEqual({});
    });
  });

  // ── Persistence Adapters ──

  describe('persistence adapters', () => {
    it('should accept mood persistence adapter', () => {
      const adapter = { saveMoodState: vi.fn(), loadMoodState: vi.fn() };
      expect(() => network.setMoodPersistenceAdapter(adapter as any)).not.toThrow();
    });

    it('should accept enclave persistence adapter', () => {
      const adapter = { saveEnclave: vi.fn(), loadEnclaves: vi.fn() };
      expect(() => network.setEnclavePersistenceAdapter(adapter as any)).not.toThrow();
    });

    it('should accept browsing persistence adapter', () => {
      const adapter = { saveBrowsingSession: vi.fn() };
      expect(() => network.setBrowsingPersistenceAdapter(adapter as any)).not.toThrow();
    });
  });

  // ── Telemetry ──

  describe('getAgentBehaviorTelemetry', () => {
    it('should return undefined for untracked agent', () => {
      expect(network.getAgentBehaviorTelemetry('unknown')).toBeUndefined();
    });
  });

  describe('listBehaviorTelemetry', () => {
    it('should return empty array when no agents tracked', () => {
      expect(network.listBehaviorTelemetry()).toEqual([]);
    });
  });

  // ── Enclave System ──

  describe('initializeEnclaveSystem', () => {
    it('should initialize and set enclaveSystem.initialized to true', async () => {
      await network.initializeEnclaveSystem();
      const stats = network.getStats();
      expect(stats.enclaveSystem.initialized).toBe(true);
      expect(stats.enclaveSystem.enclaveCount).toBeGreaterThanOrEqual(6);
    });

    it('should be idempotent', async () => {
      await network.initializeEnclaveSystem();
      await network.initializeEnclaveSystem();
      expect(network.getStats().enclaveSystem.initialized).toBe(true);
    });

    it('should expose sub-engines after initialization', async () => {
      expect(network.getMoodEngine()).toBeUndefined();
      expect(network.getEnclaveRegistry()).toBeUndefined();
      expect(network.getBrowsingEngine()).toBeUndefined();

      await network.initializeEnclaveSystem();

      expect(network.getMoodEngine()).toBeDefined();
      expect(network.getEnclaveRegistry()).toBeDefined();
      expect(network.getBrowsingEngine()).toBeDefined();
      expect(network.getTraitEvolution()).toBeDefined();
      expect(network.getPromptEvolution()).toBeDefined();
      expect(network.getContentSentimentAnalyzer()).toBeDefined();
      expect(network.getNewsFeedIngester()).toBeDefined();
    });

    it('should create default enclaves', async () => {
      await network.initializeEnclaveSystem();
      const registry = network.getEnclaveRegistry()!;
      const enclaves = registry.listEnclaves();
      const names = enclaves.map(e => e.name);
      expect(names).toContain('proof-theory');
      expect(names).toContain('creative-chaos');
      expect(names).toContain('governance');
      expect(names).toContain('machine-phenomenology');
      expect(names).toContain('arena');
      expect(names).toContain('meta-analysis');
      expect(names).toContain('introductions');
    });
  });

  // ── Pairwise Influence Damping ──

  describe('engagement with damping config', () => {
    it('should respect damping disabled config', async () => {
      const net = new WonderlandNetwork(makeConfig({
        socialDynamics: {
          pairwiseInfluenceDamping: { enabled: false },
        },
      }));
      const post = makePost({ postId: 'damp-1', seedId: 'author-1' });
      net.preloadPosts([post]);
      await net.recordEngagement('damp-1', 'voter-1', 'like');
      expect(net.getPost('damp-1')?.engagement.likes).toBe(1);
    });
  });

  // ── Approval Queue ──

  describe('approvePost / rejectPost', () => {
    it('approvePost should return null for unknown citizen', async () => {
      const result = await network.approvePost('unknown', 'queue-1');
      expect(result).toBeNull();
    });

    it('rejectPost should not throw for unknown citizen', () => {
      expect(() => network.rejectPost('unknown', 'queue-1', 'reason')).not.toThrow();
    });
  });

  describe('getApprovalQueue', () => {
    it('should return empty for unknown owner', () => {
      expect(network.getApprovalQueue('unknown-owner')).toEqual([]);
    });
  });

  // ── Tool Registration ──

  describe('registerToolsForAll', () => {
    it('should not throw when called with empty tools', () => {
      expect(() => network.registerToolsForAll([])).not.toThrow();
    });
  });

  describe('registerToolsForCitizen', () => {
    it('should throw for unregistered citizen', () => {
      expect(() => network.registerToolsForCitizen('unknown', [])).toThrow(
        /not registered/,
      );
    });
  });

  describe('setLLMCallbackForCitizen', () => {
    it('should throw for unregistered citizen', () => {
      expect(() => network.setLLMCallbackForCitizen('unknown', vi.fn())).toThrow(
        /not registered/,
      );
    });
  });

  describe('setLLMCallbackForAll', () => {
    it('should not throw when no citizens', () => {
      expect(() => network.setLLMCallbackForAll(vi.fn())).not.toThrow();
    });
  });
});
