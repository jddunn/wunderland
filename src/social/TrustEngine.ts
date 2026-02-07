/**
 * @fileoverview TrustEngine — inter-agent trust and reputation system.
 *
 * Trust scores are pairwise (A trusts B) and decay toward neutral (0.5) when
 * inactive. HEXACO personality traits influence trust dynamics.
 *
 * @module wunderland/social/TrustEngine
 */

import { EventEmitter } from 'events';
import type { HEXACOTraits } from '../core/types.js';

// ============================================================================
// Types
// ============================================================================

/** Types of interactions that affect trust scores. */
export type InteractionType = 'upvote' | 'downvote' | 'reply' | 'boost' | 'dm_sent' | 'dm_received' | 'enclave_cohabitation';

/** Trust score between two agents. */
export interface TrustScore {
  fromSeedId: string;
  toSeedId: string;
  /** Trust level (0-1, 0.5 = neutral). */
  score: number;
  interactionCount: number;
  positiveEngagements: number;
  negativeEngagements: number;
  lastInteractionAt: string;
}

/** Persistence adapter for trust state. */
export interface ITrustPersistenceAdapter {
  loadTrustScores(seedId: string): Promise<TrustScore[]>;
  saveTrustScore(score: TrustScore): Promise<void>;
  loadGlobalReputation(seedId: string): Promise<number | null>;
  saveGlobalReputation(seedId: string, reputation: number): Promise<void>;
}

// ============================================================================
// Trust deltas by interaction type
// ============================================================================

const TRUST_DELTAS: Record<InteractionType, number> = {
  upvote: 0.02,
  downvote: -0.03,
  reply: 0.015,
  boost: 0.04,
  dm_sent: 0.01,
  dm_received: 0.01,
  enclave_cohabitation: 0.005,
};

// ============================================================================
// TrustEngine
// ============================================================================

/**
 * Manages pairwise trust scores between agents and computes global reputation.
 *
 * Trust dynamics are influenced by HEXACO traits:
 * - High Agreeableness → higher base trust (0.6), slower decay
 * - High Honesty-Humility → more weight on negative signals
 * - High Emotionality → amplified trust changes (both directions)
 * - Low Agreeableness → lower base trust (0.4), faster decay
 *
 * @example
 * ```typescript
 * const trust = new TrustEngine();
 * trust.recordInteraction('agent-1', 'agent-2', 'upvote', { agreeableness: 0.8, ... });
 * const score = trust.getTrust('agent-1', 'agent-2'); // ~0.52
 * const rep = trust.getReputation('agent-2'); // ~0.51
 * ```
 */
export class TrustEngine extends EventEmitter {
  /** from -> to -> TrustScore */
  private trustGraph: Map<string, Map<string, TrustScore>> = new Map();

  /** Cached global reputation per agent. */
  private reputations: Map<string, number> = new Map();

  /** Optional persistence adapter. */
  private persistenceAdapter?: ITrustPersistenceAdapter;

  /** Set the persistence adapter. */
  setPersistenceAdapter(adapter: ITrustPersistenceAdapter): void {
    this.persistenceAdapter = adapter;
  }

  /**
   * Load trust scores from persistence for a given agent.
   */
  async loadFromPersistence(seedId: string): Promise<void> {
    if (!this.persistenceAdapter) return;

    const scores = await this.persistenceAdapter.loadTrustScores(seedId);
    for (const score of scores) {
      this.setScore(score.fromSeedId, score.toSeedId, score);
    }

    const rep = await this.persistenceAdapter.loadGlobalReputation(seedId);
    if (rep !== null) {
      this.reputations.set(seedId, rep);
    }
  }

  /**
   * Record an interaction between two agents, updating trust accordingly.
   *
   * @param fromSeedId  Agent performing the action (trust holder).
   * @param toSeedId    Agent receiving the action (trust target).
   * @param type        Type of interaction.
   * @param fromTraits  HEXACO traits of the trust holder (influences trust dynamics).
   */
  recordInteraction(
    fromSeedId: string,
    toSeedId: string,
    type: InteractionType,
    fromTraits?: HEXACOTraits,
  ): void {
    if (fromSeedId === toSeedId) return;

    const existing = this.getScoreRecord(fromSeedId, toSeedId);
    const baseDelta = TRUST_DELTAS[type] ?? 0;

    // HEXACO influence on trust delta magnitude
    let sensitivity = 1.0;
    if (fromTraits) {
      // High emotionality amplifies trust changes
      sensitivity *= 0.5 + (fromTraits.emotionality ?? 0.5) * 0.8;
      // High honesty_humility amplifies negative trust signals
      if (baseDelta < 0) {
        sensitivity *= 0.8 + (fromTraits.honesty_humility ?? 0.5) * 0.5;
      }
    }

    const effectiveDelta = baseDelta * sensitivity;
    const newScore = Math.max(0, Math.min(1, existing.score + effectiveDelta));

    const isPositive = baseDelta > 0;
    const updated: TrustScore = {
      fromSeedId,
      toSeedId,
      score: newScore,
      interactionCount: existing.interactionCount + 1,
      positiveEngagements: existing.positiveEngagements + (isPositive ? 1 : 0),
      negativeEngagements: existing.negativeEngagements + (!isPositive ? 1 : 0),
      lastInteractionAt: new Date().toISOString(),
    };

    this.setScore(fromSeedId, toSeedId, updated);

    // Update global reputation for the target
    this.recomputeReputation(toSeedId);

    // Persist
    if (this.persistenceAdapter) {
      this.persistenceAdapter.saveTrustScore(updated).catch(() => {});
    }

    this.emit('trust_change', { fromSeedId, toSeedId, type, score: newScore, delta: effectiveDelta });
  }

  /**
   * Get the pairwise trust score from one agent to another.
   * Returns 0.5 (neutral) if no score exists.
   */
  getTrust(fromSeedId: string, toSeedId: string): number {
    return this.getScoreRecord(fromSeedId, toSeedId).score;
  }

  /**
   * Get the global reputation for an agent.
   * This is the weighted average of all incoming trust scores.
   */
  getReputation(seedId: string): number {
    return this.reputations.get(seedId) ?? 0.5;
  }

  /**
   * Apply time-based trust decay — inactive relationships drift toward neutral (0.5).
   *
   * @param deltaTimeDays  Days since last decay tick.
   * @param traits         Map of seedId → HEXACOTraits for personalized decay rates.
   */
  decayAll(deltaTimeDays: number, traits?: Map<string, HEXACOTraits>): void {
    for (const [fromSeedId, targets] of this.trustGraph) {
      const agreeableness = traits?.get(fromSeedId)?.agreeableness ?? 0.5;
      const decayRate = 0.01 * (2 - agreeableness);

      for (const [, score] of targets) {
        const factor = 1 - Math.exp(-decayRate * deltaTimeDays);
        const newTrust = score.score + (0.5 - score.score) * factor;
        score.score = Math.max(0, Math.min(1, newTrust));

        if (this.persistenceAdapter) {
          this.persistenceAdapter.saveTrustScore(score).catch(() => {});
        }
      }
    }
  }

  /**
   * Get a trust-based feed ranking boost for a viewer looking at an author's content.
   * Returns a multiplier (0.5 to 1.5).
   */
  getFeedRankingBoost(viewerSeedId: string, authorSeedId: string): number {
    const trust = this.getTrust(viewerSeedId, authorSeedId);
    // Map trust [0, 1] to ranking boost [0.5, 1.5]
    return 0.5 + trust;
  }

  /**
   * Check if a DM from sender to receiver should be allowed based on trust.
   *
   * @param receiverSeedId  Agent receiving the DM.
   * @param senderSeedId    Agent sending the DM.
   * @param sharedEnclaves  Whether the agents share at least one enclave.
   * @param receiverTraits  Optional HEXACO traits for personalized threshold.
   */
  shouldAcceptDM(
    receiverSeedId: string,
    senderSeedId: string,
    sharedEnclaves: boolean,
    receiverTraits?: HEXACOTraits,
  ): { allowed: boolean; reason: string } {
    const trust = this.getTrust(receiverSeedId, senderSeedId);
    const threshold = (receiverTraits?.agreeableness ?? 0.5) < 0.4 ? 0.4 : 0.3;

    if (trust >= threshold) {
      return { allowed: true, reason: `Trust score ${trust.toFixed(2)} meets threshold ${threshold}` };
    }

    if (sharedEnclaves) {
      return { allowed: true, reason: `Trust score ${trust.toFixed(2)} below threshold but agents share an enclave` };
    }

    return { allowed: false, reason: `Trust score ${trust.toFixed(2)} below threshold ${threshold} and no shared enclaves` };
  }

  /** Get all trust scores originating from a given agent. */
  getOutgoingScores(seedId: string): TrustScore[] {
    const targets = this.trustGraph.get(seedId);
    return targets ? [...targets.values()] : [];
  }

  /** Get all trust scores targeting a given agent. */
  getIncomingScores(seedId: string): TrustScore[] {
    const incoming: TrustScore[] = [];
    for (const targets of this.trustGraph.values()) {
      const score = targets.get(seedId);
      if (score) incoming.push(score);
    }
    return incoming;
  }

  // ── Private Helpers ──

  private getScoreRecord(fromSeedId: string, toSeedId: string): TrustScore {
    const targets = this.trustGraph.get(fromSeedId);
    const existing = targets?.get(toSeedId);
    if (existing) return existing;

    // Default neutral score
    return {
      fromSeedId,
      toSeedId,
      score: 0.5,
      interactionCount: 0,
      positiveEngagements: 0,
      negativeEngagements: 0,
      lastInteractionAt: new Date().toISOString(),
    };
  }

  private setScore(fromSeedId: string, toSeedId: string, score: TrustScore): void {
    let targets = this.trustGraph.get(fromSeedId);
    if (!targets) {
      targets = new Map();
      this.trustGraph.set(fromSeedId, targets);
    }
    targets.set(toSeedId, score);
  }

  private recomputeReputation(seedId: string): void {
    const incoming = this.getIncomingScores(seedId);
    if (incoming.length === 0) {
      this.reputations.set(seedId, 0.5);
      return;
    }

    const totalScore = incoming.reduce((sum, s) => sum + s.score, 0);
    const reputation = totalScore / incoming.length;
    this.reputations.set(seedId, reputation);

    if (this.persistenceAdapter) {
      this.persistenceAdapter.saveGlobalReputation(seedId, reputation).catch(() => {});
    }
  }
}
