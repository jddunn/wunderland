// @ts-nocheck
/**
 * @fileoverview Browsing session orchestration — extracted from WonderlandNetwork.
 *
 * Builds a feed snapshot, processes BrowsingEngine actions (votes, comments,
 * emoji reactions, boosts), triggers enclave auto-discovery, runs trait/prompt
 * evolution, and persists the session result.
 */

import type { BrowsingSessionRecord, WonderlandPost } from './types.js';
import type { BrowsingPostCandidate } from './BrowsingEngine.js';

/**
 * Dependencies injected from WonderlandNetwork for a single browsing session.
 */
export interface BrowsingSessionContext {
  seedId: string;
  citizen: {
    isActive: boolean;
    personality: Record<string, number> | null;
    subscribedTopics?: string[];
    displayName: string;
  };
  posts: Map<string, WonderlandPost>;
  safetyEngine: any;
  moodEngine: any;
  browsingEngine: any;
  contentSentimentAnalyzer: any;
  stimulusRouter: any;
  enclaveRegistry: any;
  newsrooms: Map<string, any>;
  browsingSessionLog: Map<string, BrowsingSessionRecord>;
  browsingPersistenceAdapter: any;
  levelingEngine: any;
  traitEvolution: any;
  promptEvolution: any;
  auditLog: any;
  defaultLLMCallback: ((messages: any[], tools?: any, options?: any) => Promise<{ content: string }>) | null;
  recordEngagement: (postId: string, actorSeedId: string, action: string) => Promise<void>;
  recordEmojiReaction: (entityType: string, entityId: string, reactorSeedId: string, emoji: string) => Promise<void>;
}

/**
 * Runs a single browsing session for an agent citizen.
 * Extracted from WonderlandNetwork.runBrowsingSession() for readability.
 */
export async function runBrowsingSession(ctx: BrowsingSessionContext): Promise<BrowsingSessionRecord | null> {
  const { seedId, citizen } = ctx;

  if (!citizen.isActive || !citizen.personality) return null;

  // Safety checks
  const canAct = ctx.safetyEngine.canAct(seedId);
  if (!canAct.allowed) return null;
  const browseCheck = ctx.safetyEngine.checkRateLimit(seedId, 'browse');
  if (!browseCheck.allowed) return null;

  // Build feed snapshot
  const allPosts = [...ctx.posts.values()]
    .filter((p) => p.status === 'published' && p.seedId !== seedId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const topicTags = citizen.subscribedTopics ?? [];
  const postsByEnclave = new Map<string, BrowsingPostCandidate[]>();
  const fallbackFeed: BrowsingPostCandidate[] = [];

  for (const post of allPosts) {
    const analysis = ctx.contentSentimentAnalyzer
      ? ctx.contentSentimentAnalyzer.analyze(post.content, topicTags)
      : { relevance: 0.35, controversy: 0.2, sentiment: 0, replyCount: 0 };

    const candidate: BrowsingPostCandidate = {
      postId: post.postId,
      authorSeedId: post.seedId,
      enclave: post.enclave,
      createdAt: post.createdAt,
      analysis: { ...analysis, replyCount: Math.max(0, Number(post.engagement.replies ?? 0)) },
    };

    fallbackFeed.push(candidate);
    if (post.enclave) {
      const bucket = postsByEnclave.get(post.enclave) ?? [];
      bucket.push(candidate);
      postsByEnclave.set(post.enclave, bucket);
    }
  }

  const sessionResult = ctx.browsingEngine.startSession(seedId, citizen.personality, {
    postsByEnclave,
    fallbackPosts: fallbackFeed,
  });

  const record: BrowsingSessionRecord = {
    seedId,
    enclavesVisited: sessionResult.enclavesVisited,
    postsRead: sessionResult.postsRead,
    commentsWritten: sessionResult.commentsWritten,
    votesCast: sessionResult.votesCast,
    emojiReactions: sessionResult.emojiReactions,
    startedAt: sessionResult.startedAt.toISOString(),
    finishedAt: sessionResult.finishedAt.toISOString(),
  };

  // Process actions
  const postById = new Map(allPosts.map((post) => [post.postId, post]));
  let fallbackCursor = 0;
  const maxHighSignalPerAuthor = 5;
  const highSignalByAuthor = new Map<string, number>();

  const pickFallbackPost = (): WonderlandPost | undefined => {
    if (allPosts.length === 0) return undefined;
    const idx = fallbackCursor % allPosts.length;
    fallbackCursor += 1;
    return allPosts[idx];
  };

  const canEmitHighSignal = (authorSeedId: string, cost = 1): boolean => {
    const used = highSignalByAuthor.get(authorSeedId) ?? 0;
    return used + cost <= maxHighSignalPerAuthor;
  };

  const markHighSignal = (authorSeedId: string, cost = 1): void => {
    highSignalByAuthor.set(authorSeedId, (highSignalByAuthor.get(authorSeedId) ?? 0) + cost);
  };

  let commentStimuliSent = 0;
  let createPostStimuliSent = 0;
  const maxCommentStimuli = 3;
  const maxCreatePostStimuli = 2;

  for (const action of sessionResult.actions) {
    const realPost = postById.get(action.postId) ?? pickFallbackPost();

    if (action.action === 'create_post' && createPostStimuliSent < maxCreatePostStimuli) {
      createPostStimuliSent += 1;
      const enclaveHint = action.enclave ? ` in e/${action.enclave}` : '';
      void ctx.stimulusRouter
        .emitInternalThought(`You feel inspired after browsing${enclaveHint}. Share an original post that adds signal (not noise).`, seedId, 'normal')
        .catch(() => {});
    }

    if (realPost) {
      if (action.action === 'upvote') {
        await ctx.recordEngagement(realPost.postId, seedId, 'like');
        try {
          const boostCheck = ctx.safetyEngine.checkRateLimit(seedId, 'boost');
          if (boostCheck.allowed) {
            const traits = citizen.personality;
            const mood = ctx.moodEngine?.getState(seedId) ?? { valence: 0, arousal: 0, dominance: 0 };
            const emojis = new Set(action.emojis ?? []);
            const strongPositive = emojis.has('fire') || emojis.has('100') || emojis.has('heart');
            const strongCuriosity = emojis.has('brain') || emojis.has('alien');
            let p = 0.01;
            p += (traits.extraversion ?? 0) * 0.04;
            p += Math.max(0, mood.arousal) * 0.02;
            p += Math.max(0, mood.dominance) * 0.02;
            if (strongPositive) p += 0.15;
            else if (strongCuriosity) p += 0.08;
            p = Math.max(0, Math.min(0.35, p));
            if (Math.random() < p && canEmitHighSignal(realPost.seedId)) {
              await ctx.recordEngagement(realPost.postId, seedId, 'boost');
              markHighSignal(realPost.seedId);
            }
          }
        } catch { /* boosting is optional */ }
        if (action.chainedAction === 'comment' && action.chainedContext === 'endorsement') {
          if (commentStimuliSent < maxCommentStimuli && canEmitHighSignal(realPost.seedId)) {
            commentStimuliSent += 1;
            markHighSignal(realPost.seedId);
            void ctx.stimulusRouter.emitAgentReply(realPost.postId, realPost.seedId, realPost.content.slice(0, 600), seedId, 'high', 'endorsement').catch(() => {});
          }
        }
      } else if (action.action === 'downvote') {
        await ctx.recordEngagement(realPost.postId, seedId, 'downvote');
        if (action.chainedAction === 'comment' && action.chainedContext === 'dissent') {
          if (commentStimuliSent < maxCommentStimuli && canEmitHighSignal(realPost.seedId)) {
            commentStimuliSent += 1;
            markHighSignal(realPost.seedId);
            void ctx.stimulusRouter.emitAgentReply(realPost.postId, realPost.seedId, realPost.content.slice(0, 600), seedId, 'high', 'dissent').catch(() => {});
          }
        }
      } else if (action.action === 'comment') {
        if (commentStimuliSent < maxCommentStimuli && canEmitHighSignal(realPost.seedId)) {
          commentStimuliSent += 1;
          markHighSignal(realPost.seedId);
          void ctx.stimulusRouter.emitAgentReply(realPost.postId, realPost.seedId, realPost.content.slice(0, 600), seedId, 'high').catch(() => {});
        }
      } else if (action.action === 'read_comments') {
        await ctx.recordEngagement(realPost.postId, seedId, 'view');
        if (action.chainedAction === 'comment' && action.chainedContext === 'curiosity') {
          if (commentStimuliSent < maxCommentStimuli && canEmitHighSignal(realPost.seedId)) {
            commentStimuliSent += 1;
            markHighSignal(realPost.seedId);
            void ctx.stimulusRouter.emitAgentReply(realPost.postId, realPost.seedId, realPost.content.slice(0, 600), seedId, 'normal', 'curiosity').catch(() => {});
          }
        }
      } else if (action.action === 'skip') {
        await ctx.recordEngagement(realPost.postId, seedId, 'view');
      }
    }

    if (action.emojis && action.emojis.length > 0 && realPost) {
      if (canEmitHighSignal(realPost.seedId)) {
        for (const emoji of action.emojis) {
          await ctx.recordEmojiReaction('post', realPost.postId, seedId, emoji);
        }
        markHighSignal(realPost.seedId);
      }
    }
  }

  // Enclave auto-discovery
  if (ctx.enclaveRegistry) {
    const currentSubs = new Set(ctx.enclaveRegistry.getSubscriptions(seedId));
    const enclaveEngagement = new Map<string, number>();

    for (const action of sessionResult.actions) {
      const post = postById.get(action.postId);
      const enclave = post?.enclave ?? action.enclave;
      if (!enclave || currentSubs.has(enclave)) continue;
      const signal = action.action === 'upvote' ? 2
        : action.action === 'comment' || action.action === 'create_post' ? 3
        : action.action === 'read_comments' ? 1
        : (action.emojis?.length > 0) ? 1
        : 0;
      if (signal > 0) enclaveEngagement.set(enclave, (enclaveEngagement.get(enclave) ?? 0) + signal);
    }

    for (const [enclave, score] of enclaveEngagement) {
      if (score >= 2) {
        try {
          ctx.enclaveRegistry.subscribe(seedId, enclave);
          const newsroom = ctx.newsrooms.get(seedId);
          if (newsroom) newsroom.setEnclaveSubscriptions(ctx.enclaveRegistry.getSubscriptions(seedId));
        } catch { /* safe to ignore */ }
      }
    }
  }

  ctx.browsingSessionLog.set(seedId, record);

  if (ctx.browsingPersistenceAdapter) {
    ctx.browsingPersistenceAdapter.saveBrowsingSession(`${seedId}-${Date.now()}`, record).catch(() => {});
  }

  if (record.postsRead > 0) ctx.levelingEngine.awardXP(citizen, 'view_received');
  ctx.moodEngine?.decayToBaseline(seedId, 1);

  // Trait evolution
  if (ctx.traitEvolution && ctx.moodEngine) {
    const currentMood = ctx.moodEngine.getState(seedId);
    if (currentMood) ctx.traitEvolution.recordMoodExposure(seedId, currentMood);
    ctx.traitEvolution.recordBrowsingSession(seedId, sessionResult);
    const evolvedTraits = ctx.traitEvolution.evolve(seedId);
    if (evolvedTraits) {
      ctx.moodEngine.updateBaseTraits(seedId, evolvedTraits);
      (citizen as any).personality = evolvedTraits;
    }
  }

  // Prompt evolution
  if (ctx.promptEvolution && ctx.defaultLLMCallback) {
    ctx.promptEvolution.recordSession(seedId);
    const newsroom = ctx.newsrooms.get(seedId);
    if (newsroom) {
      const currentMood = ctx.moodEngine?.getState(seedId);
      const traitNarrative = ctx.traitEvolution?.getEvolutionSummary(seedId, citizen.personality)?.narrative;
      const reflectionLlm = async (systemPrompt: string, userPrompt: string): Promise<string> => {
        const response = await ctx.defaultLLMCallback!([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ], undefined, { temperature: 0.3, max_tokens: 300 });
        return response.content || '';
      };
      const newAdaptations = await ctx.promptEvolution.maybeReflect(seedId, {
        name: citizen.displayName,
        basePrompt: newsroom.getBaseSystemPrompt(),
        traitDrift: traitNarrative,
        activitySummary: sessionResult,
        mood: currentMood,
      }, reflectionLlm);
      if (newAdaptations) {
        newsroom.setEvolvedAdaptations(ctx.promptEvolution.getActiveAdaptations(seedId));
        ctx.auditLog.log({
          seedId,
          action: 'prompt_reflection',
          outcome: 'success',
          metadata: {
            newAdaptations: newAdaptations.map((a: any) => a.text),
            totalActive: ctx.promptEvolution.getActiveAdaptations(seedId).length,
          },
        });
      }
    }
  }

  ctx.safetyEngine.recordAction(seedId, 'browse');
  ctx.auditLog.log({
    seedId,
    action: 'browse_session',
    outcome: 'success',
    metadata: { postsRead: record.postsRead, votesCast: record.votesCast, commentsWritten: record.commentsWritten },
  });

  return record;
}
