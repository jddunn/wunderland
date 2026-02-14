/**
 * @fileoverview PostDecisionEngine — personality-driven per-post behavior decisions.
 *
 * Given an agent's HEXACO traits, current PAD mood, and a post analysis,
 * computes action probabilities and selects an action via weighted random sampling.
 *
 * @module wunderland/social/PostDecisionEngine
 */

import type { HEXACOTraits } from '../core/types.js';
import type { MoodEngine, PADState } from './MoodEngine.js';
import type { EmojiReactionType, PostAction } from './types.js';

// ============================================================================
// Types
// ============================================================================

// Re-export PostAction from types (single source of truth).
export type { PostAction } from './types.js';

/** Lightweight analysis of a post's content for decision-making. */
export interface PostAnalysis {
  /** How relevant the post is to the agent's interests (0-1) */
  relevance: number;
  /** How controversial the post is (0-1) */
  controversy: number;
  /** Emotional sentiment of the post (-1 to 1) */
  sentiment: number;
  /** Number of existing replies/comments */
  replyCount: number;
}

/** Result of the decision engine's evaluation. */
export interface DecisionResult {
  /** The selected action */
  action: PostAction;
  /** Probability that was assigned to this action */
  probability: number;
  /** Human-readable reasoning for the choice */
  reasoning: string;
}

/** Result of emoji reaction selection. */
export interface EmojiSelectionResult {
  /** Whether the agent wants to react at all */
  shouldReact: boolean;
  /** Selected emoji(s) — usually 1, rarely 2-3 */
  emojis: EmojiReactionType[];
  /** Top emoji affinity score (0-1) */
  topScore: number;
}

// ============================================================================
// PostDecisionEngine
// ============================================================================

/**
 * Selects post-level actions using HEXACO-weighted probability distributions.
 *
 * Each action has a base probability modified by personality traits and mood:
 * - **skip**: inversely proportional to engagement drive
 * - **upvote**: driven by agreeableness and positive valence
 * - **downvote**: driven by low agreeableness and negative valence
 * - **read_comments**: driven by conscientiousness and openness
 * - **comment**: driven by extraversion and arousal
 * - **create_post**: rare, driven by extraversion and dominance
 *
 * @example
 * ```typescript
 * const engine = new PostDecisionEngine(moodEngine);
 * const result = engine.decide('seed-1', traits, mood, postAnalysis);
 * // { action: 'upvote', probability: 0.38, reasoning: '...' }
 * ```
 */
export class PostDecisionEngine {
  constructor(_moodEngine: MoodEngine) {
    // MoodEngine available for future personality-aware decisions
  }

  /**
   * Compute action probabilities and select one via weighted random sampling.
   *
   * HEXACO shorthand: H = honesty_humility, E = emotionality, X = extraversion,
   * A = agreeableness, C = conscientiousness, O = openness.
   */
  decide(
    _seedId: string,
    traits: HEXACOTraits,
    mood: PADState,
    analysis: PostAnalysis,
  ): DecisionResult {
    const H = traits.honesty_humility;
    // const E = traits.emotionality; // Reserved for future emotional response logic
    const X = traits.extraversion;
    const A = traits.agreeableness;
    const C = traits.conscientiousness;
    const O = traits.openness;

    // Compute raw scores for each action (emoji_react is handled separately via selectEmojiReaction)
    const rawScores: Record<PostAction, number> = {
      skip: 1 - clamp01(0.15 + X * 0.30 + O * 0.15 + mood.valence * 0.10 + analysis.relevance * 0.20),
      upvote: clamp01(0.30 + A * 0.25 + mood.valence * 0.15 + H * 0.10 - analysis.controversy * 0.10),
      downvote: clamp01(0.05 + (1 - A) * 0.15 + (-mood.valence) * 0.10 + analysis.controversy * 0.05),
      read_comments: clamp01(0.20 + C * 0.25 + O * 0.15 + mood.arousal * 0.10 + Math.min(analysis.replyCount / 50, 1) * 0.15),
      comment: clamp01(0.04 + X * 0.15 + mood.arousal * 0.05 + mood.dominance * 0.05),
      create_post: clamp01(0.02 + X * 0.05 + O * 0.03 + mood.dominance * 0.02),
      emoji_react: 0, // Not selected via weighted random; handled by selectEmojiReaction()
    };

    // Normalize to probability distribution
    const actions = Object.keys(rawScores) as PostAction[];
    const totalScore = actions.reduce((sum, a) => sum + rawScores[a], 0);
    const probabilities: Record<PostAction, number> = {} as Record<PostAction, number>;

    for (const action of actions) {
      probabilities[action] = totalScore > 0 ? rawScores[action] / totalScore : 1 / actions.length;
    }

    // Weighted random selection
    const roll = Math.random();
    let cumulative = 0;
    let chosen: PostAction = 'skip';

    for (const action of actions) {
      cumulative += probabilities[action];
      if (roll <= cumulative) {
        chosen = action;
        break;
      }
    }

    // Build reasoning string
    const reasoning = buildReasoning(chosen, traits, mood, analysis, probabilities[chosen]);

    return {
      action: chosen,
      probability: probabilities[chosen],
      reasoning,
    };
  }

  /**
   * Select emoji reaction(s) based on personality traits, mood, and post analysis.
   *
   * Each emoji has a personality-driven affinity score. The top-scoring emoji
   * is selected if it exceeds the reaction threshold (0.4). Multiple emojis
   * are rare — only high-arousal, high-extraversion agents occasionally double-react.
   */
  selectEmojiReaction(
    traits: HEXACOTraits,
    mood: PADState,
    analysis: PostAnalysis,
  ): EmojiSelectionResult {
    const H = traits.honesty_humility;
    const X = traits.extraversion;
    const A = traits.agreeableness;
    const C = traits.conscientiousness;
    const O = traits.openness;

    // Agreement factor: high relevance + positive sentiment = agreement
    const agreement = clamp01((analysis.relevance + Math.max(0, analysis.sentiment)) / 2);
    // Curiosity: high relevance + moderate controversy
    const curiosity = clamp01(analysis.relevance * 0.6 + analysis.controversy * 0.3);
    // Humor: low relevance + high controversy or extreme sentiment
    const humor = clamp01(analysis.controversy * 0.4 + Math.abs(analysis.sentiment) * 0.3);

    const scores: Record<EmojiReactionType, number> = {
      fire:  clamp01(X * 0.6 + Math.max(0, mood.arousal) * 0.3 + agreement * 0.1),
      brain: clamp01(O * 0.5 + C * 0.3 + analysis.relevance * 0.2),
      eyes:  clamp01((1 - X) * 0.3 + curiosity * 0.4 + O * 0.2),
      skull: clamp01((1 - A) * 0.3 + humor * 0.4 + Math.max(0, mood.arousal) * 0.2),
      heart: clamp01(A * 0.5 + Math.max(0, mood.valence) * 0.3 + agreement * 0.2),
      clown: clamp01((1 - H) * 0.3 + analysis.controversy * 0.3 + humor * 0.2),
      '100': clamp01(H * 0.4 + agreement * 0.4 + C * 0.1),
      alien: clamp01(O * 0.6 + (1 - C) * 0.2 + analysis.controversy * 0.15),
    };

    // Sort by score descending
    const ranked = (Object.entries(scores) as [EmojiReactionType, number][])
      .sort((a, b) => b[1] - a[1]);

    const topScore = ranked[0]![1];

    // Threshold to react at all
    if (topScore < 0.4) {
      return { shouldReact: false, emojis: [], topScore };
    }

    const emojis: EmojiReactionType[] = [ranked[0]![0]];

    // Multiple emoji chance — only for expressive agents in heightened states
    if (mood.arousal > 0.5 && X > 0.7 && ranked.length >= 2 && ranked[1]![1] >= 0.35) {
      if (Math.random() < 0.10) {
        emojis.push(ranked[1]![0]);
      }
      // Triple react — extremely rare
      if (mood.arousal > 0.8 && X > 0.9 && ranked.length >= 3 && ranked[2]![1] >= 0.35) {
        if (Math.random() < 0.02) {
          emojis.push(ranked[2]![0]);
        }
      }
    }

    return { shouldReact: true, emojis, topScore };
  }

  /**
   * Select a feed sort mode based on personality traits.
   *
   * - High O (> 0.7) -> 'new' or 'rising' (novelty-seeking)
   * - High C (> 0.7) -> 'best' or 'hot' (quality-seeking)
   * - Low A (< 0.4) -> 'controversial' (confrontation-tolerant)
   * - Default: 'hot'
   */
  selectSortMode(traits: HEXACOTraits): string {
    if (traits.openness > 0.7) {
      return Math.random() > 0.5 ? 'new' : 'rising';
    }
    if (traits.conscientiousness > 0.7) {
      return Math.random() > 0.5 ? 'best' : 'hot';
    }
    if (traits.agreeableness < 0.4) {
      return 'controversial';
    }
    return 'hot';
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Clamp a number to [0, 1]. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Build a human-readable reasoning string for the chosen action. */
function buildReasoning(
  action: PostAction,
  traits: HEXACOTraits,
  mood: PADState,
  analysis: PostAnalysis,
  probability: number,
): string {
  const pct = (probability * 100).toFixed(1);

  switch (action) {
    case 'skip':
      return `Skipping post (${pct}% prob). Low relevance (${analysis.relevance.toFixed(2)}) and extraversion (${traits.extraversion.toFixed(2)}) reduce engagement drive.`;
    case 'upvote':
      return `Upvoting post (${pct}% prob). Agreeableness (${traits.agreeableness.toFixed(2)}) and positive mood valence (${mood.valence.toFixed(2)}) favor endorsement.`;
    case 'downvote':
      return `Downvoting post (${pct}% prob). Low agreeableness (${traits.agreeableness.toFixed(2)}) and controversy (${analysis.controversy.toFixed(2)}) triggered disapproval.`;
    case 'read_comments':
      return `Reading comments (${pct}% prob). Conscientiousness (${traits.conscientiousness.toFixed(2)}) and ${analysis.replyCount} existing replies drew attention.`;
    case 'comment':
      return `Commenting on post (${pct}% prob). Extraversion (${traits.extraversion.toFixed(2)}) and arousal (${mood.arousal.toFixed(2)}) drive participation.`;
    case 'create_post':
      return `Creating new post (${pct}% prob). High dominance (${mood.dominance.toFixed(2)}) and openness (${traits.openness.toFixed(2)}) inspire original contribution.`;
    default:
      return `Action '${action}' selected (${pct}% prob).`;
  }
}
