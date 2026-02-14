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

  /** Recent mood deltas per agent for trajectory computation (newest first, max 16). */
  private recentDeltas: Map<string, Array<{ valence: number; arousal: number; dominance: number }>> = new Map();

  /** Per-agent count of consecutive ticks spent in a sustained mood deviation. */
  private sustainedMoodTicks: Map<string, number> = new Map();

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

    // Mood inertia: if the agent has sustained a mood deviation for many ticks,
    // opposing deltas (ones that push back toward baseline) are dampened.
    // Aligned deltas (pushing further from baseline) are not dampened.
    const baseline = this.baselines.get(seedId);
    const sustainedTicks = this.sustainedMoodTicks.get(seedId) ?? 0;
    const inertiaDampen = sustainedTicks > 3 ? Math.min(0.35, (sustainedTicks - 3) * 0.05) : 0;

    const applyInertia = (currentVal: number, baseVal: number, deltaVal: number): number => {
      if (inertiaDampen === 0 || !baseline) return deltaVal * sensitivity;
      // Is this delta pushing TOWARD baseline (opposing current deviation)?
      const deviation = currentVal - baseVal;
      const pushingBack = (deviation > 0 && deltaVal < 0) || (deviation < 0 && deltaVal > 0);
      if (pushingBack) {
        // Dampen opposing stimuli — sustained moods resist reversal
        return deltaVal * sensitivity * (1 - inertiaDampen);
      }
      return deltaVal * sensitivity;
    };

    const newState: PADState = {
      valence: clamp(current.valence + applyInertia(current.valence, baseline?.valence ?? 0, delta.valence)),
      arousal: clamp(current.arousal + applyInertia(current.arousal, baseline?.arousal ?? 0, delta.arousal)),
      dominance: clamp(current.dominance + applyInertia(current.dominance, baseline?.dominance ?? 0, delta.dominance)),
    };

    this.states.set(seedId, newState);

    // Record delta for trajectory computation (ring buffer, newest first)
    let history = this.recentDeltas.get(seedId);
    if (!history) {
      history = [];
      this.recentDeltas.set(seedId, history);
    }
    history.unshift({ valence: delta.valence, arousal: delta.arousal, dominance: delta.dominance });
    if (history.length > 16) history.length = 16;

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
   * Directly set (patch) an agent's current PAD state.
   *
   * This is primarily intended for tests, admin tooling, and state restoration
   * flows where you want to bypass emotionality-scaled deltas.
   */
  updateMood(
    seedId: string,
    patch: Partial<PADState>,
    opts?: { trigger?: string },
  ): void {
    const current = this.states.get(seedId);
    if (!current) return;

    const next: PADState = {
      valence: clamp(patch.valence ?? current.valence),
      arousal: clamp(patch.arousal ?? current.arousal),
      dominance: clamp(patch.dominance ?? current.dominance),
    };

    const delta: MoodDelta = {
      valence: next.valence - current.valence,
      arousal: next.arousal - current.arousal,
      dominance: next.dominance - current.dominance,
      trigger: opts?.trigger ?? 'manual_update',
    };

    this.states.set(seedId, next);

    this.emit('mood_change', {
      seedId,
      state: next,
      delta,
      trigger: delta.trigger,
    });

    if (this.persistenceAdapter) {
      const label = this.getMoodLabel(seedId);
      this.persistenceAdapter.saveMoodSnapshot(seedId, next, label).catch(() => {});
      this.persistenceAdapter.appendMoodDelta(seedId, delta, next, label).catch(() => {});
    }
  }

  /**
   * Exponentially decay the agent's current mood toward their personality baseline.
   *
   * Decay rate is personality-driven:
   * - High emotionality → faster recovery (bounce back quickly)
   * - High conscientiousness → slower decay (ruminate longer, hold moods)
   * - Base rate: 0.05, effective range: ~0.025 (ruminative) to ~0.09 (resilient)
   *
   * Mood inertia: sustained mood states (5+ ticks in same region) resist change,
   * reducing decay by up to 40%. This creates emotional momentum — agents don't
   * snap back to baseline after one interaction.
   *
   * @param seedId  Agent identifier.
   * @param deltaTime  Time elapsed since last decay tick (arbitrary unit; 1 = one tick).
   */
  decayToBaseline(seedId: string, deltaTime: number): void {
    const current = this.states.get(seedId);
    const baseline = this.baselines.get(seedId);
    if (!current || !baseline) return;

    const agentTraits = this.traits.get(seedId);
    const E = agentTraits?.emotionality ?? 0.5;
    const C = agentTraits?.conscientiousness ?? 0.5;

    // Personality-driven decay rate:
    // High E → faster recovery (E * 0.5 boost)
    // High C → slower decay (C * 0.3 reduction)
    // Effective range: ~0.025 (low E, high C) to ~0.09 (high E, low C)
    const baseDecayRate = 0.05;
    const personalityDecayRate = baseDecayRate * (0.6 + E * 0.5 + (1 - C) * 0.3);

    // Mood inertia: how far from baseline on each dimension?
    // Sustained deviations resist decay (emotional momentum).
    const deviationMagnitude = Math.sqrt(
      (current.valence - baseline.valence) ** 2 +
      (current.arousal - baseline.arousal) ** 2 +
      (current.dominance - baseline.dominance) ** 2,
    );

    // Track sustained mood ticks for inertia buildup
    let sustainedTicks = this.sustainedMoodTicks.get(seedId) ?? 0;
    if (deviationMagnitude > 0.08) {
      sustainedTicks = Math.min(sustainedTicks + 1, 20);
    } else {
      sustainedTicks = Math.max(0, sustainedTicks - 2);
    }
    this.sustainedMoodTicks.set(seedId, sustainedTicks);

    // Inertia dampens decay: up to 40% reduction after 10+ sustained ticks
    const inertiaFactor = 1 - Math.min(0.4, sustainedTicks * 0.04);

    const effectiveDecayRate = personalityDecayRate * inertiaFactor;
    const factor = 1 - Math.exp(-effectiveDecayRate * deltaTime);

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
   * Get recent mood deltas for trajectory computation (newest first).
   * Returns up to 16 most recent deltas.
   */
  getRecentDeltas(seedId: string): Array<{ valence: number; arousal: number; dominance: number }> {
    return this.recentDeltas.get(seedId) ?? [];
  }

  /**
   * Update an agent's base HEXACO traits and recompute their mood baseline.
   *
   * Unlike initializeAgent(), this does NOT reset the current mood state —
   * the agent's accumulated emotional experience is preserved. Only the
   * baseline (the "resting mood" they decay toward) shifts.
   *
   * Used by TraitEvolution to apply personality drift.
   */
  updateBaseTraits(seedId: string, newTraits: HEXACOTraits): void {
    if (!this.states.has(seedId)) return;

    // Update cached traits
    this.traits.set(seedId, newTraits);

    // Recompute baseline from new traits (same formula as initializeAgent)
    const baseline: PADState = {
      valence: clamp(newTraits.agreeableness * 0.4 + newTraits.honesty_humility * 0.2 - 0.1),
      arousal: clamp(newTraits.emotionality * 0.3 + newTraits.extraversion * 0.3 - 0.1),
      dominance: clamp(newTraits.extraversion * 0.4 - newTraits.agreeableness * 0.2),
    };

    this.baselines.set(seedId, baseline);
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
