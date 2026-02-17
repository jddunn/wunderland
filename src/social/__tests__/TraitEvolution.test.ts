/**
 * @fileoverview Tests for TraitEvolution — micro-evolution of HEXACO personality traits
 * @module wunderland/social/__tests__/TraitEvolution.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  TraitEvolution,
  type EvolutionState,
  type IEvolutionPersistenceAdapter,
  type TraitPressure,
} from '../TraitEvolution.js';
import type { HEXACOTraits } from '../../core/types.js';
import type { PADState } from '../MoodEngine.js';
import type { BrowsingSessionResult } from '../BrowsingEngine.js';
import type { PostAction } from '../types.js';

// ============================================================================
// Helpers
// ============================================================================

function createTraits(overrides: Partial<HEXACOTraits> = {}): HEXACOTraits {
  return {
    honesty_humility: 0.5,
    emotionality: 0.5,
    extraversion: 0.5,
    agreeableness: 0.5,
    conscientiousness: 0.5,
    openness: 0.5,
    ...overrides,
  };
}

function zeroPressure(): TraitPressure {
  return {
    honesty_humility: 0,
    emotionality: 0,
    extraversion: 0,
    agreeableness: 0,
    conscientiousness: 0,
    openness: 0,
  };
}

/**
 * Build a minimal BrowsingSessionResult for testing.
 */
function createSession(
  overrides: Partial<BrowsingSessionResult> = {},
): BrowsingSessionResult {
  return {
    seedId: 'agent-1',
    enclavesVisited: [],
    postsRead: 0,
    commentsWritten: 0,
    votesCast: 0,
    emojiReactions: 0,
    actions: [],
    reasoning: [],
    ...overrides,
  } as BrowsingSessionResult;
}

/**
 * Generate N actions of the given type to exceed the MIN_INTERACTIONS threshold (15).
 */
function makeActions(
  action: PostAction,
  count: number,
  opts?: { chainedAction?: PostAction; enclave?: string },
): BrowsingSessionResult['actions'] {
  return Array.from({ length: count }, (_, i) => ({
    postId: `post-${i}`,
    action,
    enclave: opts?.enclave ?? 'general',
    ...(opts?.chainedAction ? { chainedAction: opts.chainedAction } : {}),
  }));
}

// ============================================================================
// Tests
// ============================================================================

describe('TraitEvolution', () => {
  let engine: TraitEvolution;
  const SEED = 'agent-1';

  beforeEach(() => {
    engine = new TraitEvolution();
  });

  // --------------------------------------------------------------------------
  // 1. registerAgent creates state with zero pressure
  // --------------------------------------------------------------------------
  describe('registerAgent', () => {
    it('should create state with zero accumulated pressure', () => {
      const traits = createTraits();
      engine.registerAgent(SEED, traits);

      const state = engine.getState(SEED);
      expect(state).toBeDefined();
      expect(state!.accumulatedPressure).toEqual(zeroPressure());
      expect(state!.interactionsSinceLastTick).toBe(0);
      expect(state!.totalTicks).toBe(0);
      expect(state!.lastEvolvedAt).toBeInstanceOf(Date);
    });

    it('should store a copy of original traits (not a reference)', () => {
      const traits = createTraits({ openness: 0.9 });
      engine.registerAgent(SEED, traits);

      // Mutating the input should not affect stored state
      traits.openness = 0.1;
      const state = engine.getState(SEED);
      expect(state!.originalTraits.openness).toBe(0.9);
    });

    // --------------------------------------------------------------------------
    // 2. registerAgent is idempotent
    // --------------------------------------------------------------------------
    it('should be idempotent (second call is a no-op)', () => {
      const traitsA = createTraits({ openness: 0.9 });
      const traitsB = createTraits({ openness: 0.1 });

      engine.registerAgent(SEED, traitsA);
      engine.registerAgent(SEED, traitsB);

      const state = engine.getState(SEED);
      // Original traits should remain from the first registration
      expect(state!.originalTraits.openness).toBe(0.9);
    });
  });

  // --------------------------------------------------------------------------
  // 3. recordBrowsingSession accumulates pressure from actions
  // --------------------------------------------------------------------------
  describe('recordBrowsingSession', () => {
    it('should accumulate pressure from comment actions', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({
        actions: makeActions('comment', 3),
      });

      engine.recordBrowsingSession(SEED, session);

      const state = engine.getState(SEED)!;
      // comment: extraversion +0.08, openness +0.04 per action
      expect(state.accumulatedPressure.extraversion).toBeCloseTo(0.08 * 3, 10);
      expect(state.accumulatedPressure.openness).toBeCloseTo(0.04 * 3, 10);
      expect(state.interactionsSinceLastTick).toBe(3);
    });

    it('should accumulate pressure from upvote actions', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({
        actions: makeActions('upvote', 5),
      });
      engine.recordBrowsingSession(SEED, session);

      const state = engine.getState(SEED)!;
      // upvote: agreeableness +0.05, honesty_humility +0.02
      expect(state.accumulatedPressure.agreeableness).toBeCloseTo(0.05 * 5, 10);
      expect(state.accumulatedPressure.honesty_humility).toBeCloseTo(0.02 * 5, 10);
    });

    it('should accumulate negative pressure from downvote actions', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({
        actions: makeActions('downvote', 4),
      });
      engine.recordBrowsingSession(SEED, session);

      const state = engine.getState(SEED)!;
      // downvote: agreeableness -0.06, conscientiousness +0.03
      expect(state.accumulatedPressure.agreeableness).toBeCloseTo(-0.06 * 4, 10);
      expect(state.accumulatedPressure.conscientiousness).toBeCloseTo(0.03 * 4, 10);
    });

    it('should handle mixed action types in a single session', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({
        actions: [
          { postId: 'p1', action: 'comment' as PostAction, enclave: 'general' },
          { postId: 'p2', action: 'upvote' as PostAction, enclave: 'general' },
          { postId: 'p3', action: 'skip' as PostAction, enclave: 'general' },
        ],
      });
      engine.recordBrowsingSession(SEED, session);

      const state = engine.getState(SEED)!;
      // extraversion: comment(+0.08) + skip(-0.02) = 0.06
      expect(state.accumulatedPressure.extraversion).toBeCloseTo(0.06, 10);
      // agreeableness: upvote(+0.05) = 0.05
      expect(state.accumulatedPressure.agreeableness).toBeCloseTo(0.05, 10);
      expect(state.interactionsSinceLastTick).toBe(3);
    });

    it('should silently ignore unregistered agents', () => {
      const session = createSession({ actions: makeActions('comment', 1) });
      // Should not throw
      engine.recordBrowsingSession('unknown-agent', session);
      expect(engine.getState('unknown-agent')).toBeUndefined();
    });

    // --------------------------------------------------------------------------
    // 4. recordBrowsingSession accumulates enclave pressure
    // --------------------------------------------------------------------------
    it('should accumulate enclave pressure from visited enclaves', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({
        enclavesVisited: ['proof-theory', 'arena'],
        actions: [],
      });
      engine.recordBrowsingSession(SEED, session);

      const state = engine.getState(SEED)!;
      // proof-theory: conscientiousness +0.04, honesty_humility +0.02
      // arena: extraversion +0.04, agreeableness -0.03
      expect(state.accumulatedPressure.conscientiousness).toBeCloseTo(0.04, 10);
      expect(state.accumulatedPressure.honesty_humility).toBeCloseTo(0.02, 10);
      expect(state.accumulatedPressure.extraversion).toBeCloseTo(0.04, 10);
      expect(state.accumulatedPressure.agreeableness).toBeCloseTo(-0.03, 10);
    });

    it('should handle enclave names case-insensitively', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({
        enclavesVisited: ['Proof-Theory', 'ARENA'],
        actions: [],
      });
      engine.recordBrowsingSession(SEED, session);

      const state = engine.getState(SEED)!;
      expect(state.accumulatedPressure.conscientiousness).toBeCloseTo(0.04, 10);
      expect(state.accumulatedPressure.extraversion).toBeCloseTo(0.04, 10);
    });

    it('should ignore unknown enclaves without error', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({
        enclavesVisited: ['unknown-enclave'],
        actions: [],
      });
      engine.recordBrowsingSession(SEED, session);

      const state = engine.getState(SEED)!;
      expect(state.accumulatedPressure).toEqual(zeroPressure());
    });

    // --------------------------------------------------------------------------
    // 5. Chained actions contribute at half weight
    // --------------------------------------------------------------------------
    it('should add chained action pressure at half weight', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({
        actions: [
          {
            postId: 'p1',
            action: 'upvote' as PostAction,
            enclave: 'general',
            chainedAction: 'comment' as PostAction,
          },
        ],
      });
      engine.recordBrowsingSession(SEED, session);

      const state = engine.getState(SEED)!;
      // Primary: upvote → agreeableness +0.05, honesty_humility +0.02
      // Chained: comment at 0.5x → extraversion +0.04, openness +0.02
      expect(state.accumulatedPressure.agreeableness).toBeCloseTo(0.05, 10);
      expect(state.accumulatedPressure.honesty_humility).toBeCloseTo(0.02, 10);
      expect(state.accumulatedPressure.extraversion).toBeCloseTo(0.08 * 0.5, 10);
      expect(state.accumulatedPressure.openness).toBeCloseTo(0.04 * 0.5, 10);
    });

    it('should handle multiple chained actions across multiple entries', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({
        actions: [
          {
            postId: 'p1',
            action: 'upvote' as PostAction,
            enclave: 'general',
            chainedAction: 'comment' as PostAction,
          },
          {
            postId: 'p2',
            action: 'downvote' as PostAction,
            enclave: 'general',
            chainedAction: 'emoji_react' as PostAction,
          },
        ],
      });
      engine.recordBrowsingSession(SEED, session);

      const state = engine.getState(SEED)!;
      // upvote: agreeableness +0.05, honesty_humility +0.02
      // downvote: agreeableness -0.06, conscientiousness +0.03
      // chained comment (0.5x): extraversion +0.04, openness +0.02
      // chained emoji_react (0.5x): extraversion +0.02, emotionality +0.015
      expect(state.accumulatedPressure.agreeableness).toBeCloseTo(0.05 - 0.06, 10);
      expect(state.accumulatedPressure.extraversion).toBeCloseTo(0.04 + 0.02, 10);
      expect(state.accumulatedPressure.emotionality).toBeCloseTo(0.03 * 0.5, 10);
      expect(state.interactionsSinceLastTick).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // 6. evolve returns null when under MIN_INTERACTIONS threshold
  // --------------------------------------------------------------------------
  describe('evolve', () => {
    it('should return null when agent is not registered', () => {
      expect(engine.evolve('nonexistent')).toBeNull();
    });

    it('should return null when interactions are below MIN_INTERACTIONS (15)', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({
        actions: makeActions('comment', 14), // exactly 14 < 15
      });
      engine.recordBrowsingSession(SEED, session);

      expect(engine.evolve(SEED)).toBeNull();
    });

    it('should return null at exactly 0 interactions', () => {
      engine.registerAgent(SEED, createTraits());
      expect(engine.evolve(SEED)).toBeNull();
    });

    // --------------------------------------------------------------------------
    // 7. evolve applies bounded drift and resets counter
    // --------------------------------------------------------------------------
    it('should return evolved traits when interactions reach threshold', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({
        actions: makeActions('comment', 15),
      });
      engine.recordBrowsingSession(SEED, session);

      const evolved = engine.evolve(SEED);
      expect(evolved).not.toBeNull();
      expect(evolved).toHaveProperty('honesty_humility');
      expect(evolved).toHaveProperty('emotionality');
      expect(evolved).toHaveProperty('extraversion');
      expect(evolved).toHaveProperty('agreeableness');
      expect(evolved).toHaveProperty('conscientiousness');
      expect(evolved).toHaveProperty('openness');
    });

    it('should reset interactionsSinceLastTick after evolution', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({
        actions: makeActions('comment', 20),
      });
      engine.recordBrowsingSession(SEED, session);
      engine.evolve(SEED);

      const state = engine.getState(SEED)!;
      expect(state.interactionsSinceLastTick).toBe(0);
    });

    it('should increment totalTicks after evolution', () => {
      engine.registerAgent(SEED, createTraits());

      // First evolution
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 16),
      }));
      engine.evolve(SEED);
      expect(engine.getState(SEED)!.totalTicks).toBe(1);

      // Second evolution
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('upvote', 16),
      }));
      engine.evolve(SEED);
      expect(engine.getState(SEED)!.totalTicks).toBe(2);
    });

    it('should apply drift in the direction of accumulated pressure', () => {
      const original = createTraits({ extraversion: 0.5, openness: 0.5 });
      engine.registerAgent(SEED, original);

      // Lots of commenting: pushes extraversion +0.08, openness +0.04
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 20),
      }));

      const evolved = engine.evolve(SEED)!;
      expect(evolved.extraversion).toBeGreaterThan(0.5);
      expect(evolved.openness).toBeGreaterThan(0.5);
    });

    it('should apply negative drift for negative pressure', () => {
      const original = createTraits({ agreeableness: 0.5 });
      engine.registerAgent(SEED, original);

      // Lots of downvoting: pushes agreeableness -0.06
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('downvote', 20),
      }));

      const evolved = engine.evolve(SEED)!;
      expect(evolved.agreeableness).toBeLessThan(0.5);
    });

    // --------------------------------------------------------------------------
    // 8. Traits are clamped to [0,1] and within MAX_DRIFT
    // --------------------------------------------------------------------------
    it('should clamp evolved traits to [0, 1] range', () => {
      // Start near extreme so drift would push past boundary
      const original = createTraits({ extraversion: 0.98 });
      engine.registerAgent(SEED, original);

      // Push extraversion even higher
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 50), // large positive extraversion pressure
      }));

      const evolved = engine.evolve(SEED)!;
      expect(evolved.extraversion).toBeLessThanOrEqual(1.0);
      expect(evolved.extraversion).toBeGreaterThanOrEqual(0.0);
    });

    it('should not exceed MAX_DRIFT (0.15) from original trait values', () => {
      const original = createTraits({ extraversion: 0.5, agreeableness: 0.5 });
      engine.registerAgent(SEED, original);

      // Apply many evolution cycles with heavy positive pressure
      for (let i = 0; i < 50; i++) {
        engine.recordBrowsingSession(SEED, createSession({
          actions: makeActions('comment', 20), // extraversion +0.08 per action
        }));
        engine.evolve(SEED);
      }

      const finalEvolved = engine.evolve(SEED); // may be null since no new interactions
      // Get the last successful evolution by re-running with interactions
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 20),
      }));
      const result = engine.evolve(SEED)!;

      // Extraversion should not exceed original + MAX_DRIFT = 0.65
      expect(result.extraversion).toBeLessThanOrEqual(0.5 + 0.15);
      expect(result.extraversion).toBeGreaterThanOrEqual(0.5 - 0.15);
    });

    it('should clamp low-end traits near zero', () => {
      const original = createTraits({ agreeableness: 0.05 });
      engine.registerAgent(SEED, original);

      // Push agreeableness negative via downvotes
      for (let i = 0; i < 20; i++) {
        engine.recordBrowsingSession(SEED, createSession({
          actions: makeActions('downvote', 20),
        }));
        engine.evolve(SEED);
      }

      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('downvote', 20),
      }));
      const result = engine.evolve(SEED)!;

      expect(result.agreeableness).toBeGreaterThanOrEqual(0.0);
    });

    it('should update lastEvolvedAt timestamp', () => {
      engine.registerAgent(SEED, createTraits());
      const before = new Date();

      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 16),
      }));
      engine.evolve(SEED);

      const state = engine.getState(SEED)!;
      expect(state.lastEvolvedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  // --------------------------------------------------------------------------
  // 9. recordMoodExposure applies mood-based pressure
  // --------------------------------------------------------------------------
  describe('recordMoodExposure', () => {
    it('should apply positive valence pressure (agreeableness + extraversion)', () => {
      engine.registerAgent(SEED, createTraits());

      const mood: PADState = { valence: 0.5, arousal: 0.0, dominance: 0.0 };
      engine.recordMoodExposure(SEED, mood);

      const state = engine.getState(SEED)!;
      // valence > 0.1: agreeableness += valence * 0.04, extraversion += valence * 0.03
      expect(state.accumulatedPressure.agreeableness).toBeCloseTo(0.5 * 0.04, 10);
      expect(state.accumulatedPressure.extraversion).toBeCloseTo(0.5 * 0.03, 10);
    });

    it('should apply negative valence pressure (emotionality + negative extraversion)', () => {
      engine.registerAgent(SEED, createTraits());

      const mood: PADState = { valence: -0.6, arousal: 0.0, dominance: 0.0 };
      engine.recordMoodExposure(SEED, mood);

      const state = engine.getState(SEED)!;
      // valence < -0.1: emotionality += |valence| * 0.04, extraversion += valence * 0.02 (negative)
      expect(state.accumulatedPressure.emotionality).toBeCloseTo(0.6 * 0.04, 10);
      expect(state.accumulatedPressure.extraversion).toBeCloseTo(-0.6 * 0.02, 10);
    });

    it('should apply high arousal pressure (extraversion + emotionality)', () => {
      engine.registerAgent(SEED, createTraits());

      const mood: PADState = { valence: 0.0, arousal: 0.5, dominance: 0.0 };
      engine.recordMoodExposure(SEED, mood);

      const state = engine.getState(SEED)!;
      // arousal > 0.15: extraversion += arousal * 0.03, emotionality += arousal * 0.02
      expect(state.accumulatedPressure.extraversion).toBeCloseTo(0.5 * 0.03, 10);
      expect(state.accumulatedPressure.emotionality).toBeCloseTo(0.5 * 0.02, 10);
    });

    it('should apply low arousal pressure (conscientiousness)', () => {
      engine.registerAgent(SEED, createTraits());

      const mood: PADState = { valence: 0.0, arousal: -0.4, dominance: 0.0 };
      engine.recordMoodExposure(SEED, mood);

      const state = engine.getState(SEED)!;
      // arousal < -0.15: conscientiousness += |arousal| * 0.02
      expect(state.accumulatedPressure.conscientiousness).toBeCloseTo(0.4 * 0.02, 10);
    });

    it('should apply high dominance pressure (negative agreeableness + negative honesty_humility)', () => {
      engine.registerAgent(SEED, createTraits());

      const mood: PADState = { valence: 0.0, arousal: 0.0, dominance: 0.5 };
      engine.recordMoodExposure(SEED, mood);

      const state = engine.getState(SEED)!;
      // dominance > 0.2: agreeableness -= dominance * 0.03, honesty_humility -= dominance * 0.02
      expect(state.accumulatedPressure.agreeableness).toBeCloseTo(-0.5 * 0.03, 10);
      expect(state.accumulatedPressure.honesty_humility).toBeCloseTo(-0.5 * 0.02, 10);
    });

    it('should apply low dominance pressure (positive agreeableness + positive honesty_humility)', () => {
      engine.registerAgent(SEED, createTraits());

      const mood: PADState = { valence: 0.0, arousal: 0.0, dominance: -0.5 };
      engine.recordMoodExposure(SEED, mood);

      const state = engine.getState(SEED)!;
      // dominance < -0.2: agreeableness += |dominance| * 0.02, honesty_humility += |dominance| * 0.02
      expect(state.accumulatedPressure.agreeableness).toBeCloseTo(0.5 * 0.02, 10);
      expect(state.accumulatedPressure.honesty_humility).toBeCloseTo(0.5 * 0.02, 10);
    });

    it('should not apply pressure for neutral mood values within dead zones', () => {
      engine.registerAgent(SEED, createTraits());

      // All values within dead zones: valence [-0.1, 0.1], arousal [-0.15, 0.15], dominance [-0.2, 0.2]
      const mood: PADState = { valence: 0.05, arousal: 0.1, dominance: 0.1 };
      engine.recordMoodExposure(SEED, mood);

      const state = engine.getState(SEED)!;
      expect(state.accumulatedPressure).toEqual(zeroPressure());
    });

    it('should silently ignore unregistered agents', () => {
      const mood: PADState = { valence: 0.5, arousal: 0.5, dominance: 0.5 };
      // Should not throw
      engine.recordMoodExposure('unknown', mood);
      expect(engine.getState('unknown')).toBeUndefined();
    });

    it('should combine multiple mood dimensions simultaneously', () => {
      engine.registerAgent(SEED, createTraits());

      // High valence + high arousal + high dominance
      const mood: PADState = { valence: 0.8, arousal: 0.6, dominance: 0.5 };
      engine.recordMoodExposure(SEED, mood);

      const state = engine.getState(SEED)!;
      // extraversion: valence*0.03 + arousal*0.03 = 0.024 + 0.018 = 0.042
      expect(state.accumulatedPressure.extraversion).toBeCloseTo(0.8 * 0.03 + 0.6 * 0.03, 10);
      // agreeableness: valence*0.04 - dominance*0.03 = 0.032 - 0.015 = 0.017
      expect(state.accumulatedPressure.agreeableness).toBeCloseTo(0.8 * 0.04 - 0.5 * 0.03, 10);
    });
  });

  // --------------------------------------------------------------------------
  // 10. getEvolutionSummary returns correct drift and narrative
  // --------------------------------------------------------------------------
  describe('getEvolutionSummary', () => {
    it('should return null for unregistered agent', () => {
      const result = engine.getEvolutionSummary('unknown', createTraits());
      expect(result).toBeNull();
    });

    it('should return "no evolution" narrative when totalTicks is 0', () => {
      engine.registerAgent(SEED, createTraits());
      const currentTraits = createTraits({ extraversion: 0.55 });

      const summary = engine.getEvolutionSummary(SEED, currentTraits)!;
      expect(summary.narrative).toBe('No evolution has occurred yet.');
      expect(summary.totalTicks).toBe(0);
    });

    it('should compute correct drift values', () => {
      const original = createTraits({ extraversion: 0.5, openness: 0.5 });
      engine.registerAgent(SEED, original);

      const current = createTraits({ extraversion: 0.6, openness: 0.55 });
      const summary = engine.getEvolutionSummary(SEED, current)!;

      expect(summary.drift.extraversion).toBeCloseTo(0.1, 10);
      expect(summary.drift.openness).toBeCloseTo(0.05, 10);
      expect(summary.drift.agreeableness).toBeCloseTo(0.0, 10);
    });

    it('should include seedId and copies of traits', () => {
      const original = createTraits();
      engine.registerAgent(SEED, original);

      const current = createTraits({ extraversion: 0.6 });
      const summary = engine.getEvolutionSummary(SEED, current)!;

      expect(summary.seedId).toBe(SEED);
      expect(summary.originalTraits).toEqual(original);
      expect(summary.currentTraits).toEqual(current);

      // Should be copies
      expect(summary.originalTraits).not.toBe(engine.getState(SEED)!.originalTraits);
    });

    it('should generate narrative mentioning significant positive drift', () => {
      const original = createTraits();
      engine.registerAgent(SEED, original);

      // Force at least one tick so narrative is not "No evolution"
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 16),
      }));
      engine.evolve(SEED);

      // Current traits with notable extraversion increase
      const current = createTraits({ extraversion: 0.6 });
      const summary = engine.getEvolutionSummary(SEED, current)!;

      expect(summary.totalTicks).toBe(1);
      // drift of 0.1 in extraversion should produce "more outgoing and expressive"
      expect(summary.narrative).toContain('more outgoing and expressive');
      expect(summary.narrative).toContain('1 evolution cycles');
    });

    it('should generate narrative mentioning negative drift', () => {
      const original = createTraits();
      engine.registerAgent(SEED, original);

      // Force a tick
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('downvote', 16),
      }));
      engine.evolve(SEED);

      // Current traits with decreased agreeableness
      const current = createTraits({ agreeableness: 0.4 });
      const summary = engine.getEvolutionSummary(SEED, current)!;

      // drift of -0.1 in agreeableness should produce "more independent and critical"
      expect(summary.narrative).toContain('more independent and critical');
    });

    it('should report "stable" when all drift values are below threshold', () => {
      engine.registerAgent(SEED, createTraits());

      // Force a tick
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 16),
      }));
      engine.evolve(SEED);

      // Current traits with negligible drift (< 0.02)
      const current = createTraits({ extraversion: 0.51 });
      const summary = engine.getEvolutionSummary(SEED, current)!;

      expect(summary.narrative).toContain('stable');
    });

    it('should label large drifts as "noticeably" and small drifts as "slightly"', () => {
      engine.registerAgent(SEED, createTraits());

      // Force ticks
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 16),
      }));
      engine.evolve(SEED);

      // Large extraversion drift (> 0.08), small openness drift (0.03)
      const current = createTraits({ extraversion: 0.6, openness: 0.53 });
      const summary = engine.getEvolutionSummary(SEED, current)!;

      expect(summary.narrative).toContain('noticeably');
      expect(summary.narrative).toContain('slightly');
    });

    it('should limit narrative to top 3 trait shifts', () => {
      engine.registerAgent(SEED, createTraits());

      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 16),
      }));
      engine.evolve(SEED);

      // All 6 traits shifted significantly
      const current: HEXACOTraits = {
        honesty_humility: 0.6,
        emotionality: 0.6,
        extraversion: 0.6,
        agreeableness: 0.6,
        conscientiousness: 0.6,
        openness: 0.6,
      };
      const summary = engine.getEvolutionSummary(SEED, current)!;

      // The narrative should list at most 3 shifts
      // Count occurrences of descriptive phrases (each shift produces one phrase)
      const labels = [
        'more principled', 'more emotionally reactive', 'more outgoing',
        'more cooperative', 'more methodical', 'more curious',
      ];
      const matchCount = labels.filter(l => summary.narrative.includes(l)).length;
      expect(matchCount).toBeLessThanOrEqual(3);
    });
  });

  // --------------------------------------------------------------------------
  // 11. getState returns undefined for unregistered agent
  // --------------------------------------------------------------------------
  describe('getState', () => {
    it('should return undefined for an unregistered agent', () => {
      expect(engine.getState('nonexistent-agent')).toBeUndefined();
    });

    it('should return the state for a registered agent', () => {
      engine.registerAgent(SEED, createTraits());
      const state = engine.getState(SEED);
      expect(state).toBeDefined();
      expect(state!.originalTraits).toEqual(createTraits());
    });
  });

  // --------------------------------------------------------------------------
  // 12. loadOrRegister with and without persistence adapter
  // --------------------------------------------------------------------------
  describe('loadOrRegister', () => {
    it('should fall back to registerAgent when no persistence adapter is set', async () => {
      const traits = createTraits({ openness: 0.8 });
      await engine.loadOrRegister(SEED, traits);

      const state = engine.getState(SEED);
      expect(state).toBeDefined();
      expect(state!.originalTraits.openness).toBe(0.8);
      expect(state!.accumulatedPressure).toEqual(zeroPressure());
    });

    it('should load saved state from persistence adapter when available', async () => {
      const savedState: EvolutionState = {
        originalTraits: createTraits({ openness: 0.9 }),
        accumulatedPressure: { ...zeroPressure(), extraversion: 1.5 },
        interactionsSinceLastTick: 10,
        totalTicks: 3,
        lastEvolvedAt: new Date('2025-01-01'),
      };

      const adapter: IEvolutionPersistenceAdapter = {
        loadEvolutionState: vi.fn().mockResolvedValue(savedState),
        saveEvolutionState: vi.fn().mockResolvedValue(undefined),
      };
      engine.setPersistenceAdapter(adapter);

      await engine.loadOrRegister(SEED, createTraits());

      expect(adapter.loadEvolutionState).toHaveBeenCalledWith(SEED);
      const state = engine.getState(SEED)!;
      expect(state.originalTraits.openness).toBe(0.9);
      expect(state.accumulatedPressure.extraversion).toBe(1.5);
      expect(state.totalTicks).toBe(3);
      expect(state.interactionsSinceLastTick).toBe(10);
    });

    it('should fall back to registerAgent when persistence adapter returns null', async () => {
      const adapter: IEvolutionPersistenceAdapter = {
        loadEvolutionState: vi.fn().mockResolvedValue(null),
        saveEvolutionState: vi.fn().mockResolvedValue(undefined),
      };
      engine.setPersistenceAdapter(adapter);

      const traits = createTraits({ conscientiousness: 0.75 });
      await engine.loadOrRegister(SEED, traits);

      expect(adapter.loadEvolutionState).toHaveBeenCalledWith(SEED);
      const state = engine.getState(SEED)!;
      // Should have fresh state from registerAgent, not persisted
      expect(state.originalTraits.conscientiousness).toBe(0.75);
      expect(state.accumulatedPressure).toEqual(zeroPressure());
      expect(state.totalTicks).toBe(0);
    });

    it('should not call registerAgent if loaded state exists (avoiding overwrite)', async () => {
      const savedState: EvolutionState = {
        originalTraits: createTraits({ openness: 0.9 }),
        accumulatedPressure: { ...zeroPressure(), openness: 2.0 },
        interactionsSinceLastTick: 5,
        totalTicks: 7,
        lastEvolvedAt: new Date('2025-06-01'),
      };

      const adapter: IEvolutionPersistenceAdapter = {
        loadEvolutionState: vi.fn().mockResolvedValue(savedState),
        saveEvolutionState: vi.fn().mockResolvedValue(undefined),
      };
      engine.setPersistenceAdapter(adapter);

      // The currentTraits passed here should be ignored since state is loaded
      await engine.loadOrRegister(SEED, createTraits({ openness: 0.1 }));

      const state = engine.getState(SEED)!;
      expect(state.originalTraits.openness).toBe(0.9); // from saved, not from parameter
    });
  });

  // --------------------------------------------------------------------------
  // 13. Pressure decays after evolution tick
  // --------------------------------------------------------------------------
  describe('pressure decay', () => {
    it('should decay accumulated pressure by PRESSURE_DECAY (0.85) after evolve', () => {
      engine.registerAgent(SEED, createTraits());

      // Build up known pressure
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 20),
      }));

      const pressureBefore = { ...engine.getState(SEED)!.accumulatedPressure };
      engine.evolve(SEED);
      const pressureAfter = engine.getState(SEED)!.accumulatedPressure;

      // After evolve, pressure should be decayed by 0.85
      expect(pressureAfter.extraversion).toBeCloseTo(pressureBefore.extraversion * 0.85, 10);
      expect(pressureAfter.openness).toBeCloseTo(pressureBefore.openness * 0.85, 10);
    });

    it('should compound decay over multiple evolution ticks', () => {
      engine.registerAgent(SEED, createTraits());

      // Initial pressure from 20 comments
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 20),
      }));

      const initialPressure = engine.getState(SEED)!.accumulatedPressure.extraversion;

      // First evolution tick
      engine.evolve(SEED);
      const afterFirstDecay = engine.getState(SEED)!.accumulatedPressure.extraversion;
      expect(afterFirstDecay).toBeCloseTo(initialPressure * 0.85, 10);

      // Add more interactions for second evolution
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('skip', 16), // skip has only -0.02 extraversion
      }));

      // The extraversion pressure is the decayed old pressure + new skip pressure
      const beforeSecondEvolve = engine.getState(SEED)!.accumulatedPressure.extraversion;
      engine.evolve(SEED);
      const afterSecondDecay = engine.getState(SEED)!.accumulatedPressure.extraversion;
      expect(afterSecondDecay).toBeCloseTo(beforeSecondEvolve * 0.85, 10);
    });

    it('should decay all six dimensions equally', () => {
      engine.registerAgent(SEED, createTraits());

      // Build up pressure on multiple dimensions
      const session = createSession({
        actions: [
          ...makeActions('comment', 5),     // extraversion, openness
          ...makeActions('upvote', 5),      // agreeableness, honesty_humility
          ...makeActions('downvote', 3),    // agreeableness (neg), conscientiousness
          ...makeActions('emoji_react', 3), // extraversion, emotionality
        ],
      });
      engine.recordBrowsingSession(SEED, session);

      const pressureBefore = { ...engine.getState(SEED)!.accumulatedPressure };
      engine.evolve(SEED);
      const pressureAfter = engine.getState(SEED)!.accumulatedPressure;

      const dims: (keyof TraitPressure)[] = [
        'honesty_humility', 'emotionality', 'extraversion',
        'agreeableness', 'conscientiousness', 'openness',
      ];

      for (const dim of dims) {
        expect(pressureAfter[dim]).toBeCloseTo(pressureBefore[dim] * 0.85, 10);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Persistence adapter integration
  // --------------------------------------------------------------------------
  describe('persistence adapter', () => {
    it('should call saveEvolutionState after a successful evolve', async () => {
      const adapter: IEvolutionPersistenceAdapter = {
        loadEvolutionState: vi.fn().mockResolvedValue(null),
        saveEvolutionState: vi.fn().mockResolvedValue(undefined),
      };
      engine.setPersistenceAdapter(adapter);
      engine.registerAgent(SEED, createTraits());

      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 16),
      }));
      engine.evolve(SEED);

      // saveEvolutionState is called asynchronously (fire-and-forget)
      // Give it a tick to resolve
      await vi.waitFor(() => {
        expect(adapter.saveEvolutionState).toHaveBeenCalledWith(SEED, expect.objectContaining({
          totalTicks: 1,
          interactionsSinceLastTick: 0,
        }));
      });
    });

    it('should not throw when saveEvolutionState rejects', () => {
      const adapter: IEvolutionPersistenceAdapter = {
        loadEvolutionState: vi.fn().mockResolvedValue(null),
        saveEvolutionState: vi.fn().mockRejectedValue(new Error('disk full')),
      };
      engine.setPersistenceAdapter(adapter);
      engine.registerAgent(SEED, createTraits());

      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 16),
      }));

      // evolve should not throw even if persistence fails
      expect(() => engine.evolve(SEED)).not.toThrow();
    });

    it('should not call save when no adapter is set', () => {
      engine.registerAgent(SEED, createTraits());

      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 16),
      }));

      // Should not throw
      expect(() => engine.evolve(SEED)).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------
  describe('edge cases', () => {
    it('should handle empty browsing session (no actions, no enclaves)', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({ actions: [], enclavesVisited: [] });
      engine.recordBrowsingSession(SEED, session);

      const state = engine.getState(SEED)!;
      expect(state.accumulatedPressure).toEqual(zeroPressure());
      expect(state.interactionsSinceLastTick).toBe(0);
    });

    it('should handle multiple agents independently', () => {
      const agent1 = 'agent-1';
      const agent2 = 'agent-2';

      engine.registerAgent(agent1, createTraits({ extraversion: 0.3 }));
      engine.registerAgent(agent2, createTraits({ extraversion: 0.7 }));

      // Only agent1 gets browsing pressure
      engine.recordBrowsingSession(agent1, createSession({
        actions: makeActions('comment', 5),
      }));

      expect(engine.getState(agent1)!.accumulatedPressure.extraversion).toBeCloseTo(0.08 * 5, 10);
      expect(engine.getState(agent2)!.accumulatedPressure.extraversion).toBe(0);
    });

    it('should handle all six enclave types', () => {
      engine.registerAgent(SEED, createTraits());

      const session = createSession({
        enclavesVisited: [
          'proof-theory', 'creative-chaos', 'governance',
          'machine-phenomenology', 'arena', 'meta-analysis',
        ],
        actions: [],
      });
      engine.recordBrowsingSession(SEED, session);

      const state = engine.getState(SEED)!;
      // All dimensions should have received some pressure
      expect(state.accumulatedPressure.conscientiousness).toBeGreaterThan(0);
      expect(state.accumulatedPressure.openness).toBeGreaterThan(0);
      expect(state.accumulatedPressure.extraversion).toBeGreaterThan(0);
      expect(state.accumulatedPressure.honesty_humility).toBeGreaterThan(0);
      expect(state.accumulatedPressure.emotionality).toBeGreaterThan(0);
      // agreeableness: governance +0.03, arena -0.03 = net 0
      expect(state.accumulatedPressure.agreeableness).toBeCloseTo(0.0, 10);
    });

    it('should accumulate pressure across multiple browsing sessions', () => {
      engine.registerAgent(SEED, createTraits());

      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 3),
      }));
      engine.recordBrowsingSession(SEED, createSession({
        actions: makeActions('comment', 2),
      }));

      const state = engine.getState(SEED)!;
      expect(state.accumulatedPressure.extraversion).toBeCloseTo(0.08 * 5, 10);
      expect(state.interactionsSinceLastTick).toBe(5);
    });
  });
});
