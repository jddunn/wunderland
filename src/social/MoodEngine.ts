/**
 * @fileoverview MoodEngine — PAD (Pleasure-Arousal-Dominance) mood model for Wunderland agents.
 *
 * Maps HEXACO personality traits to baseline moods and applies real-time deltas
 * from social interactions, decaying back toward personality-derived baselines.
 *
 * @module wunderland/social/MoodEngine
 */

import { EventEmitter } from 'events';
import type { HEXACOTraits } from '../core/types.js';
import type { IMoodPersistenceAdapter } from './MoodPersistence.js';

// ============================================================================
// PAD Mood Types
// ============================================================================

/** Pleasure-Arousal-Dominance state vector. Each dimension ranges from -1 to 1. */
export interface PADState {
  /** Pleasure/displeasure dimension (-1 = miserable, 1 = elated) */
  valence: number;
  /** Arousal/sleepiness dimension (-1 = torpid, 1 = frenzied) */
  arousal: number;
  /** Dominance/submissiveness dimension (-1 = submissive, 1 = dominant) */
  dominance: number;
}

/** Discrete mood labels derived from PAD regions. */
export type MoodLabel =
  | 'excited'
  | 'serene'
  | 'contemplative'
  | 'frustrated'
  | 'curious'
  | 'assertive'
  | 'provocative'
  | 'analytical'
  | 'engaged'
  | 'bored';

/** A mood delta with a causal trigger annotation. */
export interface MoodDelta {
  valence: number;
  arousal: number;
  dominance: number;
  /** Human-readable cause, e.g. "received upvote on post-xyz" */
  trigger: string;
}

// ============================================================================
// MoodEngine
// ============================================================================

/**
 * Manages per-agent PAD mood states with personality-derived baselines,
 * event-driven deltas, and exponential decay.
 *
 * @example
 * ```typescript
 * const engine = new MoodEngine();
 * engine.initializeAgent('seed-1', traits);
 * engine.applyDelta('seed-1', { valence: 0.2, arousal: 0.1, dominance: 0, trigger: 'upvote received' });
 * const label = engine.getMoodLabel('seed-1'); // 'excited'
 * ```
 */
export class MoodEngine extends EventEmitter {
  /** Current PAD state per agent. */
  private states: Map<string, PADState> = new Map();

  /** Personality-derived baseline PAD state per agent. */
  private baselines: Map<string, PADState> = new Map();

  /** Cached HEXACO traits per agent (needed for mood label lookups). */
  private traits: Map<string, HEXACOTraits> = new Map();

  /** Optional persistence adapter for durable mood state. */
  private persistenceAdapter?: IMoodPersistenceAdapter;

  /** Set the persistence adapter for durable mood state. */
  setPersistenceAdapter(adapter: IMoodPersistenceAdapter): void {
    this.persistenceAdapter = adapter;
  }

  /**
   * Initialize an agent's mood state from their HEXACO personality traits.
   *
   * Baseline derivation:
   * - valence  = A * 0.4 + H * 0.2 - 0.1
   * - arousal  = E * 0.3 + X * 0.3 - 0.1
   * - dominance = X * 0.4 - A * 0.2
   */
  initializeAgent(seedId: string, traits: HEXACOTraits): void {
    const baseline: PADState = {
      valence: clamp(traits.agreeableness * 0.4 + traits.honesty_humility * 0.2 - 0.1),
      arousal: clamp(traits.emotionality * 0.3 + traits.extraversion * 0.3 - 0.1),
      dominance: clamp(traits.extraversion * 0.4 - traits.agreeableness * 0.2),
    };

    this.baselines.set(seedId, { ...baseline });
    this.states.set(seedId, { ...baseline });
    this.traits.set(seedId, traits);
  }

  /**
   * Apply a mood delta to an agent's current state.
   *
   * The effective delta is scaled by the agent's emotionality trait:
   *   effectiveDelta = delta * (0.5 + emotionality * 0.8)
   *
   * High-emotionality agents are more reactive to stimuli.
   */
  applyDelta(seedId: string, delta: MoodDelta): void {
    const current = this.states.get(seedId);
    if (!current) return;

    const agentTraits = this.traits.get(seedId);
    const sensitivity = 0.5 + (agentTraits?.emotionality ?? 0.5) * 0.8;

    const newState: PADState = {
      valence: clamp(current.valence + delta.valence * sensitivity),
      arousal: clamp(current.arousal + delta.arousal * sensitivity),
      dominance: clamp(current.dominance + delta.dominance * sensitivity),
    };

    this.states.set(seedId, newState);

    this.emit('mood_change', {
      seedId,
      state: newState,
      delta,
      trigger: delta.trigger,
    });

    if (this.persistenceAdapter) {
      const label = this.getMoodLabel(seedId);
      this.persistenceAdapter.saveMoodSnapshot(seedId, newState, label).catch(() => {});
      this.persistenceAdapter.appendMoodDelta(seedId, delta, newState, label).catch(() => {});
    }
  }

  /**
   * Exponentially decay the agent's current mood toward their personality baseline.
   *
   * @param seedId  Agent identifier.
   * @param deltaTime  Time elapsed since last decay tick (arbitrary unit; 1 = one tick).
   */
  decayToBaseline(seedId: string, deltaTime: number): void {
    const current = this.states.get(seedId);
    const baseline = this.baselines.get(seedId);
    if (!current || !baseline) return;

    const decayRate = 0.05;
    const factor = 1 - Math.exp(-decayRate * deltaTime);

    const newState: PADState = {
      valence: current.valence + (baseline.valence - current.valence) * factor,
      arousal: current.arousal + (baseline.arousal - current.arousal) * factor,
      dominance: current.dominance + (baseline.dominance - current.dominance) * factor,
    };

    this.states.set(seedId, newState);
  }

  /**
   * Map an agent's PAD state to a discrete mood label using region thresholds.
   *
   * Region priorities (first match wins):
   * 1. excited:        V > 0.3 && A > 0.3 && D > 0
   * 2. frustrated:     V < -0.2 && A > 0.2 && D < 0
   * 3. serene:         V > 0.2 && A < -0.1
   * 4. contemplative:  A < 0 && |V| < 0.3
   * 5. curious:        V > 0 && A > 0 && openness > 0.6
   * 6. assertive:      D > 0.3 && A > 0
   * 7. provocative:    A > 0.3 && D > 0.2 && V < 0
   * 8. analytical:     A < 0.1 && |V| < 0.2 && conscientiousness > 0.7
   * 9. engaged:        V > 0 && A > 0
   * 10. default:       bored
   */
  getMoodLabel(seedId: string): MoodLabel {
    const state = this.states.get(seedId);
    if (!state) return 'bored';

    const agentTraits = this.traits.get(seedId);
    const { valence, arousal, dominance } = state;

    if (valence > 0.3 && arousal > 0.3 && dominance > 0) return 'excited';
    if (valence < -0.2 && arousal > 0.2 && dominance < 0) return 'frustrated';
    if (valence > 0.2 && arousal < -0.1) return 'serene';
    if (arousal < 0 && Math.abs(valence) < 0.3) return 'contemplative';
    if (valence > 0 && arousal > 0 && (agentTraits?.openness ?? 0) > 0.6) return 'curious';
    if (dominance > 0.3 && arousal > 0) return 'assertive';
    if (arousal > 0.3 && dominance > 0.2 && valence < 0) return 'provocative';
    if (arousal < 0.1 && Math.abs(valence) < 0.2 && (agentTraits?.conscientiousness ?? 0) > 0.7) return 'analytical';
    if (valence > 0 && arousal > 0) return 'engaged';

    return 'bored';
  }

  /** Get an agent's current PAD state. */
  getState(seedId: string): PADState | undefined {
    const state = this.states.get(seedId);
    return state ? { ...state } : undefined;
  }

  /** Get an agent's baseline PAD state. */
  getBaseline(seedId: string): PADState | undefined {
    const baseline = this.baselines.get(seedId);
    return baseline ? { ...baseline } : undefined;
  }

  /** Get the cached HEXACO traits for an agent. */
  getTraits(seedId: string): HEXACOTraits | undefined {
    return this.traits.get(seedId);
  }

  /**
   * Load mood state from persistence adapter, falling back to HEXACO derivation.
   * Call this before initializeAgent() to restore state across restarts.
   */
  async loadFromPersistence(seedId: string, traits: HEXACOTraits): Promise<boolean> {
    if (!this.persistenceAdapter) return false;

    const snapshot = await this.persistenceAdapter.loadMoodSnapshot(seedId);
    if (!snapshot) return false;

    // Store traits
    this.traits.set(seedId, traits);

    // Compute baseline from traits (same formula as initializeAgent)
    const baseline: PADState = {
      valence: clamp(traits.agreeableness * 0.4 + traits.honesty_humility * 0.2 - 0.1),
      arousal: clamp(traits.emotionality * 0.3 + traits.extraversion * 0.3 - 0.1),
      dominance: clamp(traits.extraversion * 0.4 - traits.agreeableness * 0.2),
    };
    this.baselines.set(seedId, baseline);

    // Restore persisted state
    this.states.set(seedId, {
      valence: snapshot.valence,
      arousal: snapshot.arousal,
      dominance: snapshot.dominance,
    });

    return true;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Clamp a number to the [-1, 1] range. */
function clamp(value: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, value));
}
