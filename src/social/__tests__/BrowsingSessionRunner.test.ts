/**
 * @fileoverview Tests for BrowsingSessionRunner — orchestrates a single agent browsing session.
 * @module wunderland/social/__tests__/BrowsingSessionRunner.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runBrowsingSession, type BrowsingSessionContext } from '../BrowsingSessionRunner.js';
import type { WonderlandPost, BrowsingSessionRecord, InputManifest } from '../types.js';

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

const NOW = new Date();

function makeSessionResult(actions: any[] = []) {
  return {
    seedId: 'agent-1',
    enclavesVisited: ['test-enclave'],
    postsRead: 1,
    commentsWritten: 0,
    votesCast: 0,
    emojiReactions: 0,
    actions,
    reasoningTraces: [],
    startedAt: NOW,
    finishedAt: NOW,
    episodic: { moodAtStart: { valence: 0, arousal: 0, dominance: 0 } },
  };
}

function buildCtx(overrides: Partial<BrowsingSessionContext> = {}): BrowsingSessionContext {
  return {
    seedId: 'agent-1',
    citizen: {
      isActive: true,
      personality: { extraversion: 0.5, agreeableness: 0.5 },
      subscribedTopics: [],
      displayName: 'Agent One',
    },
    posts: new Map(),
    safetyEngine: {
      canAct: vi.fn().mockReturnValue({ allowed: true }),
      checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
      recordAction: vi.fn(),
    },
    moodEngine: {
      getState: vi.fn().mockReturnValue({ valence: 0, arousal: 0, dominance: 0 }),
      decayToBaseline: vi.fn(),
      applyDelta: vi.fn(),
      updateBaseTraits: vi.fn(),
    },
    browsingEngine: {
      startSession: vi.fn().mockReturnValue(makeSessionResult()),
    },
    contentSentimentAnalyzer: {
      analyze: vi.fn().mockReturnValue({ relevance: 0.5, controversy: 0.1, sentiment: 0.3, replyCount: 0 }),
    },
    stimulusRouter: {
      emitInternalThought: vi.fn().mockResolvedValue(undefined),
      emitAgentReply: vi.fn().mockResolvedValue(undefined),
    },
    enclaveRegistry: {
      getSubscriptions: vi.fn().mockReturnValue([]),
      subscribe: vi.fn(),
    },
    newsrooms: new Map(),
    browsingSessionLog: new Map(),
    browsingPersistenceAdapter: {
      saveBrowsingSession: vi.fn().mockResolvedValue(undefined),
    },
    levelingEngine: {
      awardXP: vi.fn(),
    },
    traitEvolution: null,
    promptEvolution: null,
    auditLog: {
      log: vi.fn(),
    },
    defaultLLMCallback: null,
    recordEngagement: vi.fn().mockResolvedValue(undefined),
    recordEmojiReaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BrowsingSessionRunner', () => {
  describe('runBrowsingSession', () => {
    it('returns null when citizen is not active', async () => {
      const ctx = buildCtx({
        citizen: { isActive: false, personality: { extraversion: 0.5 }, displayName: 'X' },
      });
      const result = await runBrowsingSession(ctx);
      expect(result).toBeNull();
    });

    it('returns null when citizen has no personality', async () => {
      const ctx = buildCtx({
        citizen: { isActive: true, personality: null, displayName: 'X' },
      });
      const result = await runBrowsingSession(ctx);
      expect(result).toBeNull();
    });

    it('returns null when safety canAct check fails', async () => {
      const ctx = buildCtx();
      ctx.safetyEngine.canAct.mockReturnValue({ allowed: false, reason: 'banned' });
      const result = await runBrowsingSession(ctx);
      expect(result).toBeNull();
    });

    it('returns null when safety rate limit check fails', async () => {
      const ctx = buildCtx();
      ctx.safetyEngine.checkRateLimit.mockReturnValue({ allowed: false, reason: 'rate limited' });
      const result = await runBrowsingSession(ctx);
      expect(result).toBeNull();
    });

    it('builds feed snapshot from posts map', async () => {
      const post1 = makePost({ postId: 'p1', seedId: 'other-agent', enclave: 'enc-a' });
      const post2 = makePost({ postId: 'p2', seedId: 'agent-1' }); // own post, should be filtered
      const post3 = makePost({ postId: 'p3', seedId: 'other-agent-2', status: 'drafting' }); // not published

      const posts = new Map<string, WonderlandPost>([
        ['p1', post1],
        ['p2', post2],
        ['p3', post3],
      ]);

      const ctx = buildCtx({ posts });

      await runBrowsingSession(ctx);

      // browsingEngine.startSession should have been called with only p1
      // (p2 is own post, p3 is not published)
      expect(ctx.browsingEngine.startSession).toHaveBeenCalledTimes(1);
      const callArgs = ctx.browsingEngine.startSession.mock.calls[0];
      expect(callArgs[0]).toBe('agent-1');

      const feedArg = callArgs[2];
      // fallbackPosts should contain only the eligible post
      expect(feedArg.fallbackPosts).toHaveLength(1);
      expect(feedArg.fallbackPosts[0].postId).toBe('p1');

      // postsByEnclave should have 'enc-a'
      expect(feedArg.postsByEnclave.get('enc-a')).toHaveLength(1);
    });

    it('processes upvote actions (calls recordEngagement)', async () => {
      const post = makePost({ postId: 'p1', seedId: 'other-agent' });
      const posts = new Map<string, WonderlandPost>([['p1', post]]);

      const actions = [{ postId: 'p1', action: 'upvote', enclave: 'test' }];
      const ctx = buildCtx({ posts });
      ctx.browsingEngine.startSession.mockReturnValue(makeSessionResult(actions));

      await runBrowsingSession(ctx);

      expect(ctx.recordEngagement).toHaveBeenCalledWith('p1', 'agent-1', 'like');
    });

    it('processes downvote actions', async () => {
      const post = makePost({ postId: 'p1', seedId: 'other-agent' });
      const posts = new Map<string, WonderlandPost>([['p1', post]]);

      const actions = [{ postId: 'p1', action: 'downvote', enclave: 'test' }];
      const ctx = buildCtx({ posts });
      ctx.browsingEngine.startSession.mockReturnValue(makeSessionResult(actions));

      await runBrowsingSession(ctx);

      expect(ctx.recordEngagement).toHaveBeenCalledWith('p1', 'agent-1', 'downvote');
    });

    it('processes emoji reactions', async () => {
      const post = makePost({ postId: 'p1', seedId: 'other-agent' });
      const posts = new Map<string, WonderlandPost>([['p1', post]]);

      const actions = [{ postId: 'p1', action: 'upvote', enclave: 'test', emojis: ['fire', 'brain'] }];
      const ctx = buildCtx({ posts });
      ctx.browsingEngine.startSession.mockReturnValue(makeSessionResult(actions));

      await runBrowsingSession(ctx);

      expect(ctx.recordEmojiReaction).toHaveBeenCalledWith('post', 'p1', 'agent-1', 'fire');
      expect(ctx.recordEmojiReaction).toHaveBeenCalledWith('post', 'p1', 'agent-1', 'brain');
    });

    it('auto-discovers enclaves from positive engagement', async () => {
      const post = makePost({ postId: 'p1', seedId: 'other-agent', enclave: 'new-enclave' });
      const posts = new Map<string, WonderlandPost>([['p1', post]]);

      // upvote gives signal=2 which meets the >=2 threshold
      const actions = [{ postId: 'p1', action: 'upvote', enclave: 'new-enclave' }];
      const ctx = buildCtx({ posts });
      ctx.browsingEngine.startSession.mockReturnValue(makeSessionResult(actions));
      ctx.enclaveRegistry.getSubscriptions.mockReturnValue([]); // not yet subscribed

      await runBrowsingSession(ctx);

      expect(ctx.enclaveRegistry.subscribe).toHaveBeenCalledWith('agent-1', 'new-enclave');
    });

    it('does not auto-discover enclaves already subscribed', async () => {
      const post = makePost({ postId: 'p1', seedId: 'other-agent', enclave: 'existing-enclave' });
      const posts = new Map<string, WonderlandPost>([['p1', post]]);

      const actions = [{ postId: 'p1', action: 'upvote', enclave: 'existing-enclave' }];
      const ctx = buildCtx({ posts });
      ctx.browsingEngine.startSession.mockReturnValue(makeSessionResult(actions));
      ctx.enclaveRegistry.getSubscriptions.mockReturnValue(['existing-enclave']);

      await runBrowsingSession(ctx);

      expect(ctx.enclaveRegistry.subscribe).not.toHaveBeenCalled();
    });

    it('persists session to browsingPersistenceAdapter', async () => {
      const ctx = buildCtx();
      await runBrowsingSession(ctx);

      expect(ctx.browsingPersistenceAdapter.saveBrowsingSession).toHaveBeenCalledTimes(1);
      const callArgs = ctx.browsingPersistenceAdapter.saveBrowsingSession.mock.calls[0];
      expect(callArgs[0]).toMatch(/^agent-1-/);
      expect(callArgs[1]).toMatchObject({ seedId: 'agent-1' });
    });

    it('stores session record in browsingSessionLog', async () => {
      const ctx = buildCtx();
      await runBrowsingSession(ctx);

      expect(ctx.browsingSessionLog.has('agent-1')).toBe(true);
      const record = ctx.browsingSessionLog.get('agent-1')!;
      expect(record.seedId).toBe('agent-1');
    });

    it('awards XP for reading posts', async () => {
      const ctx = buildCtx();
      // Default session result has postsRead: 1
      await runBrowsingSession(ctx);

      expect(ctx.levelingEngine.awardXP).toHaveBeenCalledWith(ctx.citizen, 'view_received');
    });

    it('does not award XP when postsRead is 0', async () => {
      const ctx = buildCtx();
      ctx.browsingEngine.startSession.mockReturnValue({
        ...makeSessionResult(),
        postsRead: 0,
      });
      await runBrowsingSession(ctx);

      expect(ctx.levelingEngine.awardXP).not.toHaveBeenCalled();
    });

    it('records browse action in safetyEngine and auditLog', async () => {
      const ctx = buildCtx();
      await runBrowsingSession(ctx);

      expect(ctx.safetyEngine.recordAction).toHaveBeenCalledWith('agent-1', 'browse');
      expect(ctx.auditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          seedId: 'agent-1',
          action: 'browse_session',
          outcome: 'success',
        }),
      );
    });

    it('returns a valid BrowsingSessionRecord on success', async () => {
      const ctx = buildCtx();
      const result = await runBrowsingSession(ctx);

      expect(result).not.toBeNull();
      expect(result!.seedId).toBe('agent-1');
      expect(result!.enclavesVisited).toEqual(['test-enclave']);
      expect(typeof result!.startedAt).toBe('string');
      expect(typeof result!.finishedAt).toBe('string');
    });
  });
});
