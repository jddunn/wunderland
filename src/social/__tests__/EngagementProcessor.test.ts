// @ts-nocheck
/**
 * @fileoverview Tests for EngagementProcessor — votes, boosts, emoji reactions, pairwise damping.
 * @module wunderland/social/__tests__/EngagementProcessor.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EngagementProcessor, type EngagementDeps, type PairwiseInfluenceDampingConfig } from '../EngagementProcessor.js';
import type { WonderlandPost, InputManifest } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(seedId: string): InputManifest {
  return {
    seedId,
    runtimeSignature: 'sig',
    stimulus: { type: 'world_feed', eventId: 'e1', timestamp: new Date().toISOString(), sourceProviderId: 'test' },
    reasoningTraceHash: 'hash',
    humanIntervention: false,
    intentChainHash: 'chain',
    processingSteps: 1,
    modelsUsed: ['gpt-4'],
    securityFlags: [],
  };
}

function makePost(overrides: Partial<WonderlandPost> = {}): WonderlandPost {
  const seedId = overrides.seedId ?? 'author-1';
  return {
    postId: 'post-1',
    seedId,
    content: 'Hello world',
    manifest: makeManifest(seedId),
    status: 'published',
    createdAt: new Date().toISOString(),
    engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0, views: 0 },
    agentLevelAtPost: 1,
    ...overrides,
  };
}

function buildDeps(overrides: Partial<EngagementDeps> = {}): EngagementDeps {
  return {
    posts: new Map(),
    citizens: new Map(),
    safetyEngine: {
      canAct: vi.fn().mockReturnValue({ allowed: true }),
      checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
      recordAction: vi.fn(),
    },
    actionDeduplicator: {
      isDuplicate: vi.fn().mockReturnValue(false),
      record: vi.fn(),
    },
    levelingEngine: {
      awardXP: vi.fn(),
    },
    moodEngine: {
      applyDelta: vi.fn(),
    },
    auditLog: {
      log: vi.fn(),
    },
    engagementStoreCallback: null,
    emojiReactionStoreCallback: null,
    telemetryCallbacks: [],
    behaviorTelemetry: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EngagementProcessor', () => {
  describe('constructor', () => {
    it('creates a processor with default damping config', () => {
      const deps = buildDeps();
      const processor = new EngagementProcessor(deps);
      expect(processor).toBeInstanceOf(EngagementProcessor);
    });

    it('creates a processor with custom damping config', () => {
      const deps = buildDeps();
      const processor = new EngagementProcessor(deps, { enabled: false });
      expect(processor).toBeInstanceOf(EngagementProcessor);
    });
  });

  describe('recordEngagement', () => {
    let deps: EngagementDeps;
    let processor: EngagementProcessor;
    let post: WonderlandPost;
    const author = { seedId: 'author-1', displayName: 'Author' };

    beforeEach(() => {
      post = makePost({ postId: 'post-1', seedId: 'author-1' });
      deps = buildDeps({
        posts: new Map([['post-1', post]]),
        citizens: new Map([['author-1', author]]),
      });
      // Disable damping so pairwise weight is always 1 by default
      processor = new EngagementProcessor(deps, { enabled: false });
    });

    it('updates post counter for like', async () => {
      await processor.recordEngagement('post-1', 'actor-1', 'like');
      expect(post.engagement.likes).toBe(1);
    });

    it('updates post counter for downvote', async () => {
      await processor.recordEngagement('post-1', 'actor-1', 'downvote');
      expect(post.engagement.downvotes).toBe(1);
    });

    it('updates post counter for boost', async () => {
      await processor.recordEngagement('post-1', 'actor-1', 'boost');
      expect(post.engagement.boosts).toBe(1);
    });

    it('updates post counter for reply', async () => {
      await processor.recordEngagement('post-1', 'actor-1', 'reply');
      expect(post.engagement.replies).toBe(1);
    });

    it('updates post counter for view', async () => {
      await processor.recordEngagement('post-1', 'actor-1', 'view');
      expect(post.engagement.views).toBe(1);
    });

    it('does nothing when post does not exist', async () => {
      await processor.recordEngagement('nonexistent', 'actor-1', 'like');
      expect(deps.auditLog.log).not.toHaveBeenCalled();
    });

    it('skips when safety canAct check fails', async () => {
      deps.safetyEngine.canAct.mockReturnValue({ allowed: false, reason: 'banned' });
      await processor.recordEngagement('post-1', 'actor-1', 'like');

      expect(post.engagement.likes).toBe(0);
      expect(deps.auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failure' }),
      );
    });

    it('skips when rate limit check fails', async () => {
      deps.safetyEngine.checkRateLimit.mockReturnValue({ allowed: false, reason: 'rate limited' });
      await processor.recordEngagement('post-1', 'actor-1', 'like');

      expect(post.engagement.likes).toBe(0);
      expect(deps.auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'rate_limited' }),
      );
    });

    it('deduplicates votes (like)', async () => {
      await processor.recordEngagement('post-1', 'actor-1', 'like');
      expect(post.engagement.likes).toBe(1);

      // Second call: actionDeduplicator says it is a duplicate
      deps.actionDeduplicator.isDuplicate.mockReturnValue(true);
      await processor.recordEngagement('post-1', 'actor-1', 'like');

      expect(post.engagement.likes).toBe(1); // not incremented again
      expect(deps.auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'deduplicated' }),
      );
    });

    it('deduplicates boosts', async () => {
      await processor.recordEngagement('post-1', 'actor-1', 'boost');
      expect(post.engagement.boosts).toBe(1);

      deps.actionDeduplicator.isDuplicate.mockReturnValue(true);
      await processor.recordEngagement('post-1', 'actor-1', 'boost');

      expect(post.engagement.boosts).toBe(1);
      expect(deps.auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'deduplicated' }),
      );
    });

    it('awards XP to post author', async () => {
      await processor.recordEngagement('post-1', 'actor-1', 'like');

      expect(deps.levelingEngine.awardXP).toHaveBeenCalledWith(author, 'like_received', 1);
    });

    it('does not award XP when author is not in citizens map', async () => {
      deps.citizens.clear();
      await processor.recordEngagement('post-1', 'actor-1', 'like');

      expect(deps.levelingEngine.awardXP).not.toHaveBeenCalled();
    });

    it('records action in safetyEngine after rate-limited action', async () => {
      await processor.recordEngagement('post-1', 'actor-1', 'like');
      expect(deps.safetyEngine.recordAction).toHaveBeenCalledWith('actor-1', 'vote');
    });

    it('calls engagementStoreCallback when provided', async () => {
      const storeCb = vi.fn().mockResolvedValue(undefined);
      deps.engagementStoreCallback = storeCb;
      processor = new EngagementProcessor(deps, { enabled: false });

      await processor.recordEngagement('post-1', 'actor-1', 'like');

      expect(storeCb).toHaveBeenCalledWith(
        expect.objectContaining({ postId: 'post-1', actorSeedId: 'actor-1', actionType: 'like' }),
      );
    });
  });

  describe('pairwise influence damping', () => {
    it('returns weight 1 on first interaction', () => {
      const deps = buildDeps();
      const processor = new EngagementProcessor(deps, { enabled: true });

      const weight = processor.computePairwiseInfluenceWeight('actor-1', 'author-1', 'like');
      expect(weight).toBe(1);
    });

    it('returns weight 1 for self-interactions', () => {
      const deps = buildDeps();
      const processor = new EngagementProcessor(deps, { enabled: true });

      const weight = processor.computePairwiseInfluenceWeight('actor-1', 'actor-1', 'like');
      expect(weight).toBe(1);
    });

    it('reduces weight after exceeding maxInteractionsBeforeDamping', () => {
      const deps = buildDeps();
      const processor = new EngagementProcessor(deps, {
        enabled: true,
        maxInteractionsBeforeDamping: 2,
        dampingFactor: 0.3,
        decayHalfLifeMs: 1e15, // effectively no decay
      });

      // First two interactions: weight = 1
      const w1 = processor.computePairwiseInfluenceWeight('actor-1', 'author-1', 'like');
      expect(w1).toBe(1);
      const w2 = processor.computePairwiseInfluenceWeight('actor-1', 'author-1', 'like');
      expect(w2).toBe(1);

      // Third interaction: count=3 > max=2 => excess=1, weight = 1 - 1*0.3 = 0.7
      const w3 = processor.computePairwiseInfluenceWeight('actor-1', 'author-1', 'like');
      expect(w3).toBeCloseTo(0.7, 1);
    });

    it('damped engagement is downgraded to view when weight below suppression threshold', async () => {
      const post = makePost({ postId: 'post-1', seedId: 'author-1' });
      const deps = buildDeps({
        posts: new Map([['post-1', post]]),
        citizens: new Map([['author-1', { seedId: 'author-1' }]]),
      });

      // Configure aggressive damping: threshold 0.5, 1 interaction before damping, factor 0.6
      const processor = new EngagementProcessor(deps, {
        enabled: true,
        maxInteractionsBeforeDamping: 1,
        dampingFactor: 0.6,
        suppressionThreshold: 0.5,
        decayHalfLifeMs: 1e15,
      });

      // First call: weight = 1
      await processor.recordEngagement('post-1', 'actor-1', 'like');
      expect(post.engagement.likes).toBe(1);

      // Reset dedup so the like goes through dedup check
      deps.actionDeduplicator.isDuplicate.mockReturnValue(false);

      // Second call: count=2 > max=1 => excess=1, weight = 1 - 1*0.6 = 0.4 < 0.5 => damped to 'view'
      await processor.recordEngagement('post-1', 'actor-1', 'like');
      expect(post.engagement.likes).toBe(1); // not incremented (damped)
      expect(post.engagement.views).toBe(1); // view was recorded instead
    });
  });

  describe('recordEmojiReaction', () => {
    let deps: EngagementDeps;
    let processor: EngagementProcessor;
    let post: WonderlandPost;
    const author = { seedId: 'author-1', displayName: 'Author' };

    beforeEach(() => {
      post = makePost({ postId: 'post-1', seedId: 'author-1' });
      deps = buildDeps({
        posts: new Map([['post-1', post]]),
        citizens: new Map([['author-1', author]]),
      });
      processor = new EngagementProcessor(deps, { enabled: false });
    });

    it('adds reaction and updates post engagement reactions', async () => {
      const result = await processor.recordEmojiReaction('post', 'post-1', 'reactor-1', 'fire');

      expect(result).toBe(true);
      expect(post.engagement.reactions).toBeDefined();
      expect(post.engagement.reactions!['fire']).toBe(1);
    });

    it('increments existing reaction count', async () => {
      await processor.recordEmojiReaction('post', 'post-1', 'reactor-1', 'fire');
      await processor.recordEmojiReaction('post', 'post-1', 'reactor-2', 'fire');

      expect(post.engagement.reactions!['fire']).toBe(2);
    });

    it('deduplicates same reactor+emoji combination', async () => {
      const first = await processor.recordEmojiReaction('post', 'post-1', 'reactor-1', 'fire');
      const second = await processor.recordEmojiReaction('post', 'post-1', 'reactor-1', 'fire');

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(post.engagement.reactions!['fire']).toBe(1);
    });

    it('allows different emojis from same reactor', async () => {
      await processor.recordEmojiReaction('post', 'post-1', 'reactor-1', 'fire');
      await processor.recordEmojiReaction('post', 'post-1', 'reactor-1', 'brain');

      expect(post.engagement.reactions!['fire']).toBe(1);
      expect(post.engagement.reactions!['brain']).toBe(1);
    });

    it('returns false when safety check fails', async () => {
      deps.safetyEngine.canAct.mockReturnValue({ allowed: false });
      const result = await processor.recordEmojiReaction('post', 'post-1', 'reactor-1', 'fire');

      expect(result).toBe(false);
      expect(post.engagement.reactions).toBeUndefined();
    });

    it('awards XP to post author on emoji reaction', async () => {
      await processor.recordEmojiReaction('post', 'post-1', 'reactor-1', 'fire');

      expect(deps.levelingEngine.awardXP).toHaveBeenCalledWith(author, 'emoji_received', 1);
    });

    it('does not award XP for self-reaction', async () => {
      await processor.recordEmojiReaction('post', 'post-1', 'author-1', 'fire');

      expect(deps.levelingEngine.awardXP).not.toHaveBeenCalled();
    });

    it('suppressed when pairwise weight is below threshold', async () => {
      const processor2 = new EngagementProcessor(deps, {
        enabled: true,
        maxInteractionsBeforeDamping: 1,
        dampingFactor: 0.6,
        suppressionThreshold: 0.5,
        decayHalfLifeMs: 1e15,
      });

      // First reaction => weight = 1 (initial)
      const r1 = await processor2.recordEmojiReaction('post', 'post-1', 'reactor-1', 'fire');
      expect(r1).toBe(true);

      // Second reaction: count=2 > max=1 => excess=1, weight=0.4 < 0.5 => suppressed
      const r2 = await processor2.recordEmojiReaction('post', 'post-1', 'reactor-1', 'brain');
      expect(r2).toBe(false);
      expect(deps.auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'damped' }),
      );
    });

    it('calls emojiReactionStoreCallback when provided', async () => {
      const storeCb = vi.fn().mockResolvedValue(undefined);
      deps.emojiReactionStoreCallback = storeCb;
      processor = new EngagementProcessor(deps, { enabled: false });

      await processor.recordEmojiReaction('post', 'post-1', 'reactor-1', 'fire');

      expect(storeCb).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'post',
          entityId: 'post-1',
          reactorSeedId: 'reactor-1',
          emoji: 'fire',
        }),
      );
    });
  });

  describe('getEmojiReactions', () => {
    it('returns counts from post engagement', () => {
      const post = makePost({
        postId: 'post-1',
        engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0, views: 0, reactions: { fire: 3, brain: 1 } },
      });
      const deps = buildDeps({ posts: new Map([['post-1', post]]) });
      const processor = new EngagementProcessor(deps);

      const counts = processor.getEmojiReactions('post', 'post-1');
      expect(counts).toEqual({ fire: 3, brain: 1 });
    });

    it('returns empty object for unknown post', () => {
      const deps = buildDeps();
      const processor = new EngagementProcessor(deps);

      const counts = processor.getEmojiReactions('post', 'unknown');
      expect(counts).toEqual({});
    });

    it('returns empty object for comment entity type', () => {
      const deps = buildDeps();
      const processor = new EngagementProcessor(deps);

      const counts = processor.getEmojiReactions('comment', 'comment-1');
      expect(counts).toEqual({});
    });
  });
});
