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
import type { PostDecisionEngine, PostAction, PostAnalysis } from './PostDecisionEngine.js';

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
  /** Per-post action log */
  actions: { postId: string; action: PostAction; enclave: string }[];
  /** Session start timestamp */
  startedAt: Date;
  /** Session end timestamp */
  finishedAt: Date;
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

  constructor(
    moodEngine: MoodEngine,
    registry: EnclaveRegistry,
    decisionEngine: PostDecisionEngine,
  ) {
    this.moodEngine = moodEngine;
    this.registry = registry;
    this.decisionEngine = decisionEngine;
  }

  /**
   * Orchestrate a full browsing session for an agent.
   *
   * Energy budget: `5 + round(X * 15 + max(0, arousal) * 10)` posts (range 5-30).
   * Enclave count: `1 + round(O * 3 + arousal)` clamped to [1, 5].
   */
  startSession(seedId: string, traits: HEXACOTraits): BrowsingSessionResult {
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

    const result: BrowsingSessionResult = {
      seedId,
      enclavesVisited: selectedEnclaves,
      postsRead: 0,
      commentsWritten: 0,
      votesCast: 0,
      actions: [],
      startedAt,
      finishedAt: startedAt, // will be overwritten
    };

    let remainingEnergy = energy;

    for (const enclave of selectedEnclaves) {
      if (remainingEnergy <= 0) break;

      const postsToProcess = Math.min(postsPerEnclave, remainingEnergy);

      // Select sort mode for this enclave (used for logging/future features)
      void this.decisionEngine.selectSortMode(traits);

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

        // Get the current mood snapshot
        const currentMood: PADState = this.moodEngine.getState(seedId) ?? mood;

        // Decide action
        const decision = this.decisionEngine.decide(seedId, traits, currentMood, analysis);

        // Log action
        result.actions.push({ postId, action: decision.action, enclave });
        result.postsRead++;

        // Apply mood delta based on action outcome
        const delta = computeMoodDelta(decision.action, analysis);
        this.moodEngine.applyDelta(seedId, delta);

        // Update counters
        if (decision.action === 'comment' || decision.action === 'create_post') {
          result.commentsWritten++;
        }
        if (decision.action === 'upvote' || decision.action === 'downvote') {
          result.votesCast++;
        }

        remainingEnergy--;
      }
    }

    result.finishedAt = new Date();
    return result;
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
    case 'skip':
    default:
      return { valence: -0.01, arousal: -0.03, dominance: 0, trigger: 'skipped a post' };
  }
}
