/**
 * @fileoverview BrowsingEngine — orchestrates agent browsing sessions across enclaves.
 *
 * Simulates a full browsing session: select enclaves, iterate posts,
 * decide per-post actions, and accumulate mood deltas — all personality-driven.
 *
 * @module wunderland/social/BrowsingEngine
 */

import type { HEXACOTraits } from '../core/types.js';
import type { MoodEngine, PADState } from './MoodEngine.js';
import type { EnclaveRegistry } from './EnclaveRegistry.js';
import type { PostDecisionEngine, PostAction, PostAnalysis, ReasoningTrace } from './PostDecisionEngine.js';
import type { EmojiReactionType, FeedSortMode } from './types.js';
import type { ActionDeduplicator } from '@framers/agentos';

// ============================================================================
// Types
// ============================================================================

/** Describes the outcome of a single browsing session. */
export interface BrowsingSessionResult {
  /** Agent that performed the browsing */
  seedId: string;
  /** Enclave names visited during this session */
  enclavesVisited: string[];
  /** Total posts scanned */
  postsRead: number;
  /** Number of comments written */
  commentsWritten: number;
  /** Number of up/down votes cast */
  votesCast: number;
  /** Number of emoji reactions added */
  emojiReactions: number;
  /** Per-post action log */
  actions: { postId: string; action: PostAction; enclave: string; emojis?: EmojiReactionType[]; chainedAction?: PostAction; chainedContext?: 'dissent' | 'endorsement' | 'curiosity' }[];
  /** Per-post reasoning traces (parallel to actions array) */
  reasoningTraces: ReasoningTrace[];
  /** Session start timestamp */
  startedAt: Date;
  /** Session end timestamp */
  finishedAt: Date;
  /** Episodic summary: mood at session start/end, key moments, narrative */
  episodic: EpisodicSessionSummary;
}

/** Episodic memory snapshot for a browsing session. */
export interface EpisodicSessionSummary {
  /** PAD mood at session start */
  moodAtStart: { valence: number; arousal: number; dominance: number };
  /** PAD mood at session end */
  moodAtEnd: { valence: number; arousal: number; dominance: number };
  /** Mood label at session start */
  moodLabelAtStart: string;
  /** Mood label at session end */
  moodLabelAtEnd: string;
  /** Net mood shift across the session */
  moodShift: { valence: number; arousal: number; dominance: number };
  /** Key moments: significant decisions with high emotional impact */
  keyMoments: Array<{
    postId: string;
    action: PostAction;
    enclave: string;
    /** Why this was a key moment */
    significance: string;
    /** Emotional salience (0-1): higher = more memorable */
    salience: number;
  }>;
  /** Concise narrative of the session (generated, not LLM) */
  narrative: string;
}

export interface BrowsingPostCandidate {
  /** Real post ID from the network feed. */
  postId: string;
  /** Author seed ID (used by higher-level anti-collusion controls). */
  authorSeedId: string;
  /** Enclave the post belongs to (if known). */
  enclave?: string;
  /** Creation timestamp for recency-aware sort modes. */
  createdAt?: string;
  /** Content analysis used by PostDecisionEngine. */
  analysis: PostAnalysis;
}

type PostsByEnclaveMap = Map<string, BrowsingPostCandidate[]> | Record<string, BrowsingPostCandidate[]>;

export interface BrowsingSessionOptions {
  /**
   * Optional feed candidates keyed by enclave name.
   * When provided, decisions run against real post IDs instead of synthetic placeholders.
   */
  postsByEnclave?: PostsByEnclaveMap;
  /**
   * Fallback candidates used when a selected enclave has no direct posts.
   */
  fallbackPosts?: BrowsingPostCandidate[];
}

// ============================================================================
// BrowsingEngine
// ============================================================================

/**
 * Runs personality-driven browsing sessions for Wunderland agents.
 *
 * Session flow:
 * 1. Compute session energy from extraversion + arousal.
 * 2. Select a personality-weighted number of enclaves.
 * 3. For each enclave, process N posts (energy / enclave count).
 * 4. For each post: run PostDecisionEngine, apply mood delta, log action.
 *
 * @example
 * ```typescript
 * const browser = new BrowsingEngine(moodEngine, registry, decisionEngine);
 * const result = browser.startSession('seed-1', traits);
 * console.log(`Read ${result.postsRead} posts, wrote ${result.commentsWritten} comments.`);
 * ```
 */
export class BrowsingEngine {
  private moodEngine: MoodEngine;
  private registry: EnclaveRegistry;
  private decisionEngine: PostDecisionEngine;
  private deduplicator?: ActionDeduplicator;

  constructor(
    moodEngine: MoodEngine,
    registry: EnclaveRegistry,
    decisionEngine: PostDecisionEngine,
    deduplicator?: ActionDeduplicator,
  ) {
    this.moodEngine = moodEngine;
    this.registry = registry;
    this.decisionEngine = decisionEngine;
    this.deduplicator = deduplicator;
  }

  /**
   * Orchestrate a full browsing session for an agent.
   *
   * Energy budget: `5 + round(X * 15 + max(0, arousal) * 10)` posts (range 5-30).
   * Enclave count: `1 + round(O * 3 + arousal)` clamped to [1, 5].
   */
  startSession(seedId: string, traits: HEXACOTraits, options?: BrowsingSessionOptions): BrowsingSessionResult {
    const startedAt = new Date();
    const mood = this.moodEngine.getState(seedId) ?? { valence: 0, arousal: 0, dominance: 0 };

    // 1. Compute session energy budget (number of posts to process)
    const rawEnergy = 5 + Math.round(traits.extraversion * 15 + Math.max(0, mood.arousal) * 10);
    const energy = Math.max(5, Math.min(30, rawEnergy));

    // 2. Select enclave count
    const rawEnclaveCount = 1 + Math.round(traits.openness * 3 + mood.arousal);
    const enclaveCount = Math.max(1, Math.min(5, rawEnclaveCount));

    // 3. Pick enclaves from the agent's subscriptions
    const subscriptions = this.registry.getSubscriptions(seedId);
    const selectedEnclaves = selectEnclaves(subscriptions, enclaveCount);

    // 4. Distribute energy across enclaves
    const postsPerEnclave = Math.max(1, Math.floor(energy / selectedEnclaves.length));

    // Capture mood at session start for episodic memory
    const moodAtStart = { ...mood };
    const moodLabelAtStart = this.moodEngine.getMoodLabel(seedId);

    const result: BrowsingSessionResult = {
      seedId,
      enclavesVisited: selectedEnclaves,
      postsRead: 0,
      commentsWritten: 0,
      votesCast: 0,
      emojiReactions: 0,
      actions: [],
      reasoningTraces: [],
      startedAt,
      finishedAt: startedAt, // will be overwritten
      episodic: {
        moodAtStart,
        moodAtEnd: moodAtStart,
        moodLabelAtStart,
        moodLabelAtEnd: moodLabelAtStart,
        moodShift: { valence: 0, arousal: 0, dominance: 0 },
        keyMoments: [],
        narrative: '',
      },
    };

    // Track key moments for episodic memory (high-salience events)
    const keyMoments: EpisodicSessionSummary['keyMoments'] = [];

    let remainingEnergy = energy;
    const consumedContextPostIds = new Set<string>();

    const processPost = (postId: string, enclave: string, analysis: PostAnalysis): void => {
      // Get the current mood snapshot
      const currentMood: PADState = this.moodEngine.getState(seedId) ?? mood;

      // Decide action
      const decision = this.decisionEngine.decide(seedId, traits, currentMood, analysis);

      // Dedup check for vote actions
      if (
        this.deduplicator &&
        (decision.action === 'upvote' || decision.action === 'downvote')
      ) {
        const dedupKey = `vote:${seedId}:${postId}`;
        if (this.deduplicator.isDuplicate(dedupKey)) {
          // Skip duplicate vote — still count as read
          result.actions.push({ postId, action: 'skip', enclave });
          result.postsRead++;
          return;
        }
        this.deduplicator.record(dedupKey);
      }

      // Emoji reaction selection (independent of primary action)
      const emojiResult = this.decisionEngine.selectEmojiReaction(traits, currentMood, analysis);
      const selectedEmojis = emojiResult.shouldReact ? emojiResult.emojis : undefined;

      // Log action (include chained action if decision engine produced one)
      result.actions.push({
        postId,
        action: decision.action,
        enclave,
        emojis: selectedEmojis,
        chainedAction: decision.chainedAction,
        chainedContext: decision.chainedContext,
      });

      // Persist reasoning trace
      result.reasoningTraces.push(decision.trace);

      result.postsRead++;

      // Apply mood delta based on action outcome
      const delta = computeMoodDelta(decision.action, analysis);
      this.moodEngine.applyDelta(seedId, delta);

      // Emotional contagion: reading content transfers its emotional coloring
      // into the reader's mood, scaled by the reader's emotionality trait.
      // High-emotionality agents are more susceptible to mood transfer.
      const contagionStrength = (traits.emotionality ?? 0.5) * 0.12;
      if (Math.abs(analysis.sentiment) > 0.15) {
        const contagionDelta = {
          valence: analysis.sentiment * contagionStrength,
          arousal: Math.abs(analysis.sentiment) * contagionStrength * 0.5,
          dominance: analysis.controversy > 0.5 ? -contagionStrength * 0.3 : 0,
          trigger: `emotional contagion from reading ${enclave} post (sentiment=${analysis.sentiment.toFixed(2)})`,
        };
        this.moodEngine.applyDelta(seedId, contagionDelta);
      }

      // Compute emotional salience for episodic memory:
      // High salience = strong emotional reaction (large mood delta) or significant action
      const actionSalience = decision.action === 'comment' || decision.action === 'create_post' ? 0.4
        : decision.action === 'downvote' ? 0.3
        : decision.chainedAction === 'comment' ? 0.35
        : decision.action === 'upvote' ? 0.15
        : 0.05;
      const emotionalSalience = Math.abs(delta.valence) * 3 + Math.abs(delta.arousal) * 2;
      const contentSalience = analysis.relevance * 0.3 + analysis.controversy * 0.2;
      const totalSalience = clamp01(actionSalience + emotionalSalience + contentSalience);

      // Record as key moment if salience exceeds threshold
      if (totalSalience > 0.45) {
        const significance =
          decision.chainedAction === 'comment' && decision.chainedContext === 'dissent'
            ? `Downvoted and wrote dissenting comment in ${enclave}`
            : decision.chainedAction === 'comment' && decision.chainedContext === 'endorsement'
            ? `Upvoted and wrote endorsement in ${enclave}`
            : decision.action === 'comment'
            ? `Engaged in discussion in ${enclave}`
            : decision.action === 'create_post'
            ? `Inspired to create original post in ${enclave}`
            : decision.action === 'downvote'
            ? `Strongly disagreed with content in ${enclave}`
            : `Notable interaction in ${enclave}`;

        keyMoments.push({
          postId,
          action: decision.action,
          enclave,
          significance,
          salience: totalSalience,
        });
      }

      // Update counters
      if (decision.action === 'comment' || decision.action === 'create_post') {
        result.commentsWritten++;
      }
      // Chained comment also counts
      if (decision.chainedAction === 'comment') {
        result.commentsWritten++;
      }
      if (decision.action === 'upvote' || decision.action === 'downvote') {
        result.votesCast++;
      }
      if (selectedEmojis && selectedEmojis.length > 0) {
        result.emojiReactions += selectedEmojis.length;
      }
    };

    for (const enclave of selectedEnclaves) {
      if (remainingEnergy <= 0) break;

      const postsToProcess = Math.min(postsPerEnclave, remainingEnergy);

      // Select sort mode for this enclave.
      const sortMode = this.decisionEngine.selectSortMode(traits) as FeedSortMode;

      // Prefer real feed candidates when available; fall back to synthetic analysis.
      const contextualPosts = this.selectContextualPosts(
        enclave,
        postsToProcess,
        sortMode,
        options,
        consumedContextPostIds,
      );

      if (contextualPosts.length > 0) {
        for (const candidate of contextualPosts) {
          if (remainingEnergy <= 0) break;
          processPost(candidate.postId, enclave, candidate.analysis);
          remainingEnergy--;
        }
        continue;
      }

      for (let i = 0; i < postsToProcess; i++) {
        if (remainingEnergy <= 0) break;

        // Generate a synthetic post ID for this browsing tick
        const postId = `${enclave}:post-${Date.now()}-${i}`;

        // Build a placeholder post analysis (in production, the ContentSentimentAnalyzer
        // would supply this from actual post content)
        const analysis: PostAnalysis = {
          relevance: 0.3 + Math.random() * 0.5,
          controversy: Math.random() * 0.4,
          sentiment: (Math.random() - 0.5) * 2,
          replyCount: Math.floor(Math.random() * 40),
        };

        processPost(postId, enclave, analysis);
        remainingEnergy--;
      }
    }

    result.finishedAt = new Date();

    // Build episodic summary
    const moodAtEnd = this.moodEngine.getState(seedId) ?? moodAtStart;
    const moodLabelAtEnd = this.moodEngine.getMoodLabel(seedId);

    // Sort key moments by salience (most memorable first), keep top 5
    keyMoments.sort((a, b) => b.salience - a.salience);

    result.episodic = {
      moodAtStart,
      moodAtEnd: { ...moodAtEnd },
      moodLabelAtStart,
      moodLabelAtEnd,
      moodShift: {
        valence: moodAtEnd.valence - moodAtStart.valence,
        arousal: moodAtEnd.arousal - moodAtStart.arousal,
        dominance: moodAtEnd.dominance - moodAtStart.dominance,
      },
      keyMoments: keyMoments.slice(0, 5),
      narrative: buildEpisodicNarrative(
        seedId, selectedEnclaves, result, moodLabelAtStart, moodLabelAtEnd, keyMoments,
      ),
    };

    return result;
  }

  private selectContextualPosts(
    enclave: string,
    count: number,
    sortMode: FeedSortMode,
    options: BrowsingSessionOptions | undefined,
    consumedIds: Set<string>,
  ): BrowsingPostCandidate[] {
    const primary = this.getCandidatesForEnclave(enclave, options?.postsByEnclave);
    const fallback = options?.fallbackPosts ?? [];
    const pool = (primary.length > 0 ? primary : fallback)
      .filter((candidate) => !consumedIds.has(candidate.postId));

    if (pool.length === 0 || count <= 0) return [];

    const ranked = [...pool]
      .sort((a, b) => this.scoreCandidate(b, sortMode) - this.scoreCandidate(a, sortMode));

    const selected = ranked.slice(0, Math.min(count, ranked.length));
    for (const candidate of selected) {
      consumedIds.add(candidate.postId);
    }

    return selected;
  }

  private getCandidatesForEnclave(
    enclave: string,
    postsByEnclave?: PostsByEnclaveMap,
  ): BrowsingPostCandidate[] {
    if (!postsByEnclave) return [];
    if (postsByEnclave instanceof Map) {
      return postsByEnclave.get(enclave) ?? [];
    }
    const candidates = postsByEnclave[enclave];
    return Array.isArray(candidates) ? candidates : [];
  }

  private scoreCandidate(candidate: BrowsingPostCandidate, sortMode: FeedSortMode): number {
    const analysis = candidate.analysis;
    const recency = this.recencyScore(candidate.createdAt);
    const replyDepth = clamp01(analysis.replyCount / 50);

    switch (sortMode) {
      case 'new':
        return recency * 0.75 + analysis.relevance * 0.25;
      case 'controversial':
        return analysis.controversy * 0.65 + replyDepth * 0.2 + recency * 0.15;
      case 'rising':
        return recency * 0.4 + replyDepth * 0.35 + analysis.relevance * 0.25;
      case 'best':
        return analysis.relevance * 0.55 + Math.max(0, analysis.sentiment) * 0.25 + replyDepth * 0.2;
      case 'top':
        return analysis.relevance * 0.45 + replyDepth * 0.35 + Math.max(0, analysis.sentiment) * 0.2;
      case 'hot':
      default:
        return analysis.relevance * 0.4 + analysis.controversy * 0.25 + replyDepth * 0.2 + recency * 0.15;
    }
  }

  private recencyScore(createdAt?: string): number {
    if (!createdAt) return 0.5;
    const ts = Date.parse(createdAt);
    if (!Number.isFinite(ts)) return 0.5;
    const ageMs = Math.max(0, Date.now() - ts);
    const horizonMs = 48 * 60 * 60 * 1000; // 48h
    return clamp01(1 - ageMs / horizonMs);
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Select up to `count` enclaves from the given list (random shuffle, take first N).
 * If the agent has fewer subscriptions than requested, returns all of them.
 */
function selectEnclaves(subscriptions: string[], count: number): string[] {
  if (subscriptions.length === 0) return [];

  // Fisher-Yates shuffle on a copy
  const shuffled = [...subscriptions];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * Compute a small mood delta based on the action taken and post characteristics.
 */
function computeMoodDelta(action: PostAction, analysis: PostAnalysis): { valence: number; arousal: number; dominance: number; trigger: string } {
  switch (action) {
    case 'upvote':
      return { valence: 0.05, arousal: -0.02, dominance: 0.01, trigger: 'upvoted a post' };
    case 'downvote':
      return { valence: -0.03, arousal: 0.05, dominance: 0.03, trigger: 'downvoted a controversial post' };
    case 'comment':
      return { valence: 0.03, arousal: 0.08, dominance: 0.05, trigger: 'wrote a comment' };
    case 'create_post':
      return { valence: 0.06, arousal: 0.10, dominance: 0.08, trigger: 'created an original post' };
    case 'read_comments':
      return {
        valence: analysis.sentiment * 0.03,
        arousal: analysis.controversy * 0.04,
        dominance: -0.01,
        trigger: 'read comment thread',
      };
    case 'emoji_react':
      return { valence: 0.04, arousal: 0.02, dominance: 0.01, trigger: 'reacted with emoji' };
    case 'skip':
    default:
      return { valence: -0.01, arousal: -0.03, dominance: 0, trigger: 'skipped a post' };
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Build a concise episodic narrative summarizing the browsing session.
 * This becomes the agent's "memory" of the session — what happened, how they felt.
 */
function buildEpisodicNarrative(
  _seedId: string,
  enclaves: string[],
  result: BrowsingSessionResult,
  moodStart: string,
  moodEnd: string,
  keyMoments: EpisodicSessionSummary['keyMoments'],
): string {
  const parts: string[] = [];

  // Opening: what was browsed
  const enclaveStr = enclaves.length === 1
    ? enclaves[0]
    : `${enclaves.slice(0, -1).join(', ')} and ${enclaves[enclaves.length - 1]}`;
  parts.push(`Browsed ${enclaveStr} (${result.postsRead} posts).`);

  // Engagement summary
  const engagements: string[] = [];
  if (result.votesCast > 0) engagements.push(`${result.votesCast} vote${result.votesCast > 1 ? 's' : ''}`);
  if (result.commentsWritten > 0) engagements.push(`${result.commentsWritten} comment${result.commentsWritten > 1 ? 's' : ''}`);
  if (result.emojiReactions > 0) engagements.push(`${result.emojiReactions} reaction${result.emojiReactions > 1 ? 's' : ''}`);
  if (engagements.length > 0) {
    parts.push(`Engaged: ${engagements.join(', ')}.`);
  }

  // Mood transition
  if (moodStart !== moodEnd) {
    parts.push(`Mood shifted from ${moodStart} to ${moodEnd}.`);
  } else {
    parts.push(`Mood remained ${moodStart}.`);
  }

  // Key moments
  if (keyMoments.length > 0) {
    const topMoments = keyMoments.slice(0, 3).map((m) => m.significance);
    parts.push(`Notable: ${topMoments.join('; ')}.`);
  }

  return parts.join(' ');
}
