/**
 * @fileoverview Engagement processing — votes, boosts, replies, emoji reactions,
 * pairwise influence damping, mood deltas, telemetry recording.
 *
 * Extracted from WonderlandNetwork for focused testability.
 */

import type { WonderlandPost, EmojiReactionType, EmojiReaction, EmojiReactionCounts } from './types.js';
import type { MoodDelta } from './MoodEngine.js';

export type EngagementActionType = 'like' | 'downvote' | 'boost' | 'reply' | 'view';
export type PairwiseInfluenceAction = EngagementActionType | 'emoji_reaction';

export interface EngagementDeps {
  posts: Map<string, WonderlandPost>;
  citizens: Map<string, any>;
  safetyEngine: any;
  actionDeduplicator: any;
  levelingEngine: any;
  moodEngine: any;
  auditLog: any;
  engagementStoreCallback: ((engagement: any) => Promise<void>) | null;
  emojiReactionStoreCallback: ((reaction: EmojiReaction) => Promise<void>) | null;
  /** Telemetry callbacks for mood/engagement events */
  telemetryCallbacks: Array<(event: any) => void>;
  /** Per-agent behavior telemetry map */
  behaviorTelemetry: Map<string, any>;
}

export interface PairwiseInfluenceDampingConfig {
  enabled: boolean;
  windowMs: number;
  maxInteractionsBeforeDamping: number;
  dampingFactor: number;
  suppressionThreshold: number;
  recoveryCooldownMs: number;
  decayHalfLifeMs: number;
}

const DEFAULT_PAIRWISE_DAMPING: PairwiseInfluenceDampingConfig = {
  enabled: true,
  windowMs: 24 * 60 * 60 * 1000,
  maxInteractionsBeforeDamping: 5,
  dampingFactor: 0.3,
  suppressionThreshold: 0.15,
  recoveryCooldownMs: 12 * 60 * 60 * 1000,
  decayHalfLifeMs: 48 * 60 * 60 * 1000,
};

/**
 * Processes engagement actions (votes, boosts, replies, emoji reactions)
 * with pairwise influence damping, mood impact, XP awards, and telemetry.
 */
export class EngagementProcessor {
  private pairwiseInfluenceDamping: PairwiseInfluenceDampingConfig;
  private pairwiseInfluenceState = new Map<string, { count: number; lastAt: number }>();
  private emojiReactionIndex = new Set<string>();

  constructor(
    private deps: EngagementDeps,
    pairwiseDampingConfig?: Partial<PairwiseInfluenceDampingConfig>,
  ) {
    this.pairwiseInfluenceDamping = { ...DEFAULT_PAIRWISE_DAMPING, ...pairwiseDampingConfig };
  }

  // ── Engagement Recording ──────────────────────────────────────────────

  async recordEngagement(
    postId: string,
    actorSeedId: string,
    actionType: EngagementActionType,
  ): Promise<void> {
    const post = this.deps.posts.get(postId);
    if (!post) return;

    const pairWeight = this.computePairwiseInfluenceWeight(actorSeedId, post.seedId, actionType);
    const shouldDamp =
      post.seedId !== actorSeedId &&
      (actionType === 'like' || actionType === 'downvote' || actionType === 'boost' || actionType === 'reply') &&
      pairWeight < this.pairwiseInfluenceDamping.suppressionThreshold;
    const effective: EngagementActionType = shouldDamp ? 'view' : actionType;

    const canAct = this.deps.safetyEngine.canAct(actorSeedId);
    if (!canAct.allowed) {
      this.deps.auditLog.log({ seedId: actorSeedId, action: `engagement:${actionType}`, targetId: postId, outcome: 'failure' });
      return;
    }

    const rateLimitAction = (effective === 'like' || effective === 'downvote') ? 'vote'
      : effective === 'boost' ? 'boost'
      : effective === 'reply' ? 'comment' : null;

    if (rateLimitAction) {
      const rateCheck = this.deps.safetyEngine.checkRateLimit(actorSeedId, rateLimitAction);
      if (!rateCheck.allowed) {
        this.deps.auditLog.log({ seedId: actorSeedId, action: `engagement:${actionType}`, targetId: postId, outcome: 'rate_limited' });
        return;
      }
    }

    // Dedup
    if (effective === 'like' || effective === 'downvote') {
      const key = `vote:${actorSeedId}:${postId}`;
      if (this.deps.actionDeduplicator.isDuplicate(key)) {
        this.deps.auditLog.log({ seedId: actorSeedId, action: `engagement:${actionType}`, targetId: postId, outcome: 'deduplicated' });
        return;
      }
      this.deps.actionDeduplicator.record(key);
    } else if (effective === 'boost') {
      const key = `boost:${actorSeedId}:${postId}`;
      if (this.deps.actionDeduplicator.isDuplicate(key)) {
        this.deps.auditLog.log({ seedId: actorSeedId, action: `engagement:${actionType}`, targetId: postId, outcome: 'deduplicated' });
        return;
      }
      this.deps.actionDeduplicator.record(key);
    }

    // Update counters
    switch (effective) {
      case 'like': post.engagement.likes++; break;
      case 'downvote': post.engagement.downvotes++; break;
      case 'boost': post.engagement.boosts++; break;
      case 'reply': post.engagement.replies++; break;
      case 'view': post.engagement.views++; break;
    }

    // XP
    const author = this.deps.citizens.get(post.seedId);
    if (author) {
      this.deps.levelingEngine.awardXP(author, `${effective}_received`, pairWeight);
    }

    // Mood delta on author
    if (post.seedId !== actorSeedId) {
      const delta = this.engagementMoodDelta(effective);
      if (delta) {
        const scaled = this.scaleMoodDelta(delta, pairWeight);
        if (scaled && this.deps.moodEngine) {
          this.deps.moodEngine.applyDelta?.(post.seedId, scaled) ??
            this.applyMoodDeltaFallback(post.seedId, scaled);
        }
      }
      this.emitTelemetry({ type: 'engagement_impact', seedId: post.seedId, timestamp: new Date().toISOString(), action: effective, delta: delta ?? { valence: 0, arousal: 0, dominance: 0 } });
    }

    if (rateLimitAction) this.deps.safetyEngine.recordAction(actorSeedId, rateLimitAction);
    this.deps.auditLog.log({
      seedId: actorSeedId,
      action: `engagement:${actionType}`,
      targetId: postId,
      outcome: shouldDamp ? 'damped' : 'success',
      metadata: { effectiveAction: effective, pairwiseInfluenceWeight: Number(pairWeight.toFixed(3)) },
    });

    if (this.deps.engagementStoreCallback) {
      this.deps.engagementStoreCallback({ postId, actorSeedId, actionType: effective }).catch(() => {});
    }
  }

  // ── Emoji Reactions ───────────────────────────────────────────────────

  async recordEmojiReaction(
    entityType: 'post' | 'comment',
    entityId: string,
    reactorSeedId: string,
    emoji: EmojiReactionType,
  ): Promise<boolean> {
    const canAct = this.deps.safetyEngine.canAct(reactorSeedId);
    if (!canAct.allowed) return false;

    const post = entityType === 'post' ? this.deps.posts.get(entityId) : undefined;
    const pairWeight = post ? this.computePairwiseInfluenceWeight(reactorSeedId, post.seedId, 'emoji_reaction') : 1;
    if (post && pairWeight < this.pairwiseInfluenceDamping.suppressionThreshold) {
      this.deps.auditLog.log({ seedId: reactorSeedId, action: 'emoji_reaction', targetId: entityId, outcome: 'damped', metadata: { emoji, entityType } });
      return false;
    }

    const dedupKey = `${entityType}:${entityId}:${reactorSeedId}:${emoji}`;
    if (this.emojiReactionIndex.has(dedupKey)) return false;
    this.emojiReactionIndex.add(dedupKey);

    if (entityType === 'post' && post) {
      if (!post.engagement.reactions) post.engagement.reactions = {};
      post.engagement.reactions[emoji] = (post.engagement.reactions[emoji] ?? 0) + 1;

      const author = this.deps.citizens.get(post.seedId);
      if (author && post.seedId !== reactorSeedId) {
        this.deps.levelingEngine.awardXP(author, 'emoji_received', pairWeight);
        const delta: MoodDelta = { valence: 0.04, arousal: 0.02, dominance: 0.01, trigger: `received_emoji_${emoji}` };
        const scaled = this.scaleMoodDelta(delta, pairWeight);
        if (scaled && this.deps.moodEngine) {
          this.deps.moodEngine.applyDelta?.(post.seedId, scaled) ??
            this.applyMoodDeltaFallback(post.seedId, scaled);
        }
      }
    }

    const reaction: EmojiReaction = { entityType, entityId, reactorSeedId, emoji, createdAt: new Date().toISOString() };
    if (this.deps.emojiReactionStoreCallback) {
      await this.deps.emojiReactionStoreCallback(reaction).catch(() => {});
    }

    this.deps.auditLog.log({ seedId: reactorSeedId, action: 'emoji_reaction', targetId: entityId, outcome: 'success', metadata: { emoji, entityType } });
    return true;
  }

  getEmojiReactions(entityType: 'post' | 'comment', entityId: string): EmojiReactionCounts {
    if (entityType === 'post') {
      const post = this.deps.posts.get(entityId);
      return post?.engagement.reactions ?? {};
    }
    return {};
  }

  // ── Pairwise Influence ────────────────────────────────────────────────

  computePairwiseInfluenceWeight(actorSeedId: string, authorSeedId: string, action: PairwiseInfluenceAction): number {
    if (!this.pairwiseInfluenceDamping.enabled || actorSeedId === authorSeedId) return 1;
    const key = `${actorSeedId}→${authorSeedId}`;
    const state = this.pairwiseInfluenceState.get(key);
    const now = Date.now();
    if (!state) {
      this.pairwiseInfluenceState.set(key, { count: this.pairwiseActionImpact(action), lastAt: now });
      return 1;
    }
    const elapsed = now - state.lastAt;
    const decay = Math.pow(0.5, elapsed / this.pairwiseInfluenceDamping.decayHalfLifeMs);
    const decayedCount = state.count * decay;
    const newCount = decayedCount + this.pairwiseActionImpact(action);
    this.pairwiseInfluenceState.set(key, { count: newCount, lastAt: now });
    if (newCount <= this.pairwiseInfluenceDamping.maxInteractionsBeforeDamping) return 1;
    const excess = newCount - this.pairwiseInfluenceDamping.maxInteractionsBeforeDamping;
    return Math.max(0, 1 - excess * this.pairwiseInfluenceDamping.dampingFactor);
  }

  private pairwiseActionImpact(action: PairwiseInfluenceAction): number {
    return action === 'boost' ? 2 : action === 'reply' ? 1.5 : 1;
  }

  // ── Mood Helpers ──────────────────────────────────────────────────────

  private engagementMoodDelta(action: EngagementActionType): MoodDelta | undefined {
    switch (action) {
      case 'like': return { valence: 0.06, arousal: 0.02, dominance: 0.02, trigger: 'received_upvote' };
      case 'downvote': return { valence: -0.05, arousal: 0.04, dominance: -0.02, trigger: 'received_downvote' };
      case 'boost': return { valence: 0.08, arousal: 0.03, dominance: 0.04, trigger: 'received_boost' };
      case 'reply': return { valence: 0.03, arousal: 0.06, dominance: 0.03, trigger: 'received_reply' };
      default: return undefined;
    }
  }

  private scaleMoodDelta(delta: MoodDelta, weight: number): MoodDelta | undefined {
    if (weight <= 0) return undefined;
    if (weight >= 1) return delta;
    return {
      valence: delta.valence * weight,
      arousal: delta.arousal * weight,
      dominance: delta.dominance * weight,
      trigger: delta.trigger,
    };
  }

  private applyMoodDeltaFallback(seedId: string, delta: MoodDelta): void {
    // Fallback when moodEngine doesn't have applyDelta — just emit telemetry
    this.emitTelemetry({ type: 'mood_delta_applied', seedId, timestamp: new Date().toISOString(), delta, source: 'engagement' });
  }

  private emitTelemetry(event: any): void {
    for (const cb of this.deps.telemetryCallbacks) {
      try { cb(event); } catch { /* non-critical */ }
    }
  }

  setEmojiReactionStoreCallback(callback: (reaction: EmojiReaction) => Promise<void>): void {
    this.deps.emojiReactionStoreCallback = callback;
  }

  setEngagementStoreCallback(callback: (engagement: any) => Promise<void>): void {
    this.deps.engagementStoreCallback = callback;
  }
}
