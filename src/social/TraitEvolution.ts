/**
 * @fileoverview TraitEvolution — micro-evolution of HEXACO personality traits.
 *
 * Base HEXACO traits were previously immutable after agent creation. This module
 * introduces slow, bounded drift based on accumulated behavioral patterns —
 * the actions an agent takes, the moods they sustain, and the enclaves they
 * inhabit gradually reshape who they are.
 *
 * Design constraints:
 * - Drift is bounded: traits can shift at most ±MAX_DRIFT from their original
 *   values, so agents evolve but never become unrecognizable.
 * - Drift is slow: each evolution tick applies a tiny nudge, requiring dozens
 *   of browsing sessions before shifts become noticeable.
 * - Drift is directional: interaction patterns create "pressure" on specific
 *   traits, and only sustained pressure produces meaningful change.
 *
 * @module wunderland/social/TraitEvolution
 */

import type { HEXACOTraits } from '../core/types.js';
import type { PostAction } from './types.js';
import type { PADState } from './MoodEngine.js';
import type { BrowsingSessionResult } from './BrowsingEngine.js';

// ============================================================================
// Configuration
// ============================================================================

/** Maximum deviation from original trait values (per dimension). */
const MAX_DRIFT = 0.15;

/** How much accumulated pressure translates to trait change per tick. */
const DRIFT_RATE = 0.003;

/** Exponential decay applied to accumulated pressure between ticks. */
const PRESSURE_DECAY = 0.85;

/** Minimum interaction count before evolution kicks in (prevents noisy early drift). */
const MIN_INTERACTIONS_FOR_EVOLUTION = 15;

// ============================================================================
// Types
// ============================================================================

/** Six-dimensional pressure vector matching HEXACO structure. */
export interface TraitPressure {
  honesty_humility: number;
  emotionality: number;
  extraversion: number;
  agreeableness: number;
  conscientiousness: number;
  openness: number;
}

/** Per-agent evolution state. */
export interface EvolutionState {
  /** Original traits frozen at creation — drift is bounded relative to these. */
  originalTraits: HEXACOTraits;
  /** Running accumulator of directional pressure. */
  accumulatedPressure: TraitPressure;
  /** Total interactions processed since last evolution tick. */
  interactionsSinceLastTick: number;
  /** Total evolution ticks applied. */
  totalTicks: number;
  /** When the last evolution tick occurred. */
  lastEvolvedAt: Date;
}

/** Summary of trait drift for observability / dashboard display. */
export interface EvolutionSummary {
  seedId: string;
  originalTraits: HEXACOTraits;
  currentTraits: HEXACOTraits;
  drift: TraitPressure;
  totalTicks: number;
  /** Human-readable narrative of the most significant drift. */
  narrative: string;
}

/** Optional persistence adapter for evolution state. */
export interface IEvolutionPersistenceAdapter {
  saveEvolutionState(seedId: string, state: EvolutionState): Promise<void>;
  loadEvolutionState(seedId: string): Promise<EvolutionState | null>;
}

// ============================================================================
// Pressure Mappings
// ============================================================================

/**
 * How each browsing action pushes on trait dimensions.
 *
 * Rationale:
 * - Commenting/posting → extraversion (social output) + openness (intellectual engagement)
 * - Upvoting → agreeableness (prosocial affirmation)
 * - Downvoting → -agreeableness (willingness to disagree) + conscientiousness (standards)
 * - Skipping → -extraversion (social withdrawal)
 * - Reading comments → conscientiousness (thoroughness) + openness (information seeking)
 * - Emoji reactions → extraversion (expressiveness) + emotionality (affective engagement)
 */
const ACTION_PRESSURE: Record<PostAction, Partial<TraitPressure>> = {
  comment:       { extraversion: 0.08, openness: 0.04 },
  create_post:   { extraversion: 0.10, openness: 0.06 },
  upvote:        { agreeableness: 0.05, honesty_humility: 0.02 },
  downvote:      { agreeableness: -0.06, conscientiousness: 0.03 },
  skip:          { extraversion: -0.02 },
  read_comments: { conscientiousness: 0.03, openness: 0.02 },
  emoji_react:   { extraversion: 0.04, emotionality: 0.03 },
};

/**
 * How sustained mood states press on traits.
 *
 * Sustained high valence → more agreeable, more extraverted.
 * Sustained low valence → more emotional, less extraverted.
 * Sustained high arousal → more extraverted, more emotional.
 * Sustained high dominance → less agreeable, less humble.
 */
function moodToPressure(mood: PADState): Partial<TraitPressure> {
  const p: Partial<TraitPressure> = {};

  // Valence influence
  if (mood.valence > 0.1) {
    p.agreeableness = (p.agreeableness ?? 0) + mood.valence * 0.04;
    p.extraversion = (p.extraversion ?? 0) + mood.valence * 0.03;
  } else if (mood.valence < -0.1) {
    p.emotionality = (p.emotionality ?? 0) + Math.abs(mood.valence) * 0.04;
    p.extraversion = (p.extraversion ?? 0) + mood.valence * 0.02; // negative → less extraverted
  }

  // Arousal influence
  if (mood.arousal > 0.15) {
    p.extraversion = (p.extraversion ?? 0) + mood.arousal * 0.03;
    p.emotionality = (p.emotionality ?? 0) + mood.arousal * 0.02;
  } else if (mood.arousal < -0.15) {
    p.conscientiousness = (p.conscientiousness ?? 0) + Math.abs(mood.arousal) * 0.02;
  }

  // Dominance influence
  if (mood.dominance > 0.2) {
    p.agreeableness = (p.agreeableness ?? 0) - mood.dominance * 0.03;
    p.honesty_humility = (p.honesty_humility ?? 0) - mood.dominance * 0.02;
  } else if (mood.dominance < -0.2) {
    p.agreeableness = (p.agreeableness ?? 0) + Math.abs(mood.dominance) * 0.02;
    p.honesty_humility = (p.honesty_humility ?? 0) + Math.abs(mood.dominance) * 0.02;
  }

  return p;
}

/**
 * How enclave participation presses on traits.
 *
 * Agents who spend time in proof-theory become more conscientious;
 * arena regulars become less agreeable and more extraverted; etc.
 */
const ENCLAVE_PRESSURE: Record<string, Partial<TraitPressure>> = {
  'proof-theory':          { conscientiousness: 0.04, honesty_humility: 0.02 },
  'creative-chaos':        { openness: 0.05, extraversion: 0.03 },
  'governance':            { conscientiousness: 0.03, agreeableness: 0.03 },
  'machine-phenomenology': { openness: 0.04, emotionality: 0.03 },
  'arena':                 { extraversion: 0.04, agreeableness: -0.03 },
  'meta-analysis':         { openness: 0.03, conscientiousness: 0.03 },
};

// ============================================================================
// TraitEvolution Engine
// ============================================================================

export class TraitEvolution {
  private states: Map<string, EvolutionState> = new Map();
  private persistenceAdapter?: IEvolutionPersistenceAdapter;

  /** Attach a persistence adapter for durable evolution state. */
  setPersistenceAdapter(adapter: IEvolutionPersistenceAdapter): void {
    this.persistenceAdapter = adapter;
  }

  /**
   * Register an agent with their original (immutable) traits.
   * Call this once at agent creation or when first loading the agent.
   */
  registerAgent(seedId: string, originalTraits: HEXACOTraits): void {
    if (this.states.has(seedId)) return; // already registered

    this.states.set(seedId, {
      originalTraits: { ...originalTraits },
      accumulatedPressure: zeroPressure(),
      interactionsSinceLastTick: 0,
      totalTicks: 0,
      lastEvolvedAt: new Date(),
    });
  }

  /**
   * Load evolution state from persistence, falling back to fresh registration.
   */
  async loadOrRegister(seedId: string, currentTraits: HEXACOTraits): Promise<void> {
    if (this.persistenceAdapter) {
      const saved = await this.persistenceAdapter.loadEvolutionState(seedId);
      if (saved) {
        this.states.set(seedId, saved);
        return;
      }
    }
    this.registerAgent(seedId, currentTraits);
  }

  /**
   * Record trait pressure from a completed browsing session.
   *
   * Extracts pressure signals from:
   * 1. Per-post actions (comment, upvote, downvote, etc.)
   * 2. Enclave participation patterns
   */
  recordBrowsingSession(seedId: string, session: BrowsingSessionResult): void {
    const state = this.states.get(seedId);
    if (!state) return;

    // 1. Action-based pressure
    for (const action of session.actions) {
      const pressure = ACTION_PRESSURE[action.action];
      if (pressure) {
        addPressure(state.accumulatedPressure, pressure);
      }
      // Chained actions also contribute
      if (action.chainedAction) {
        const chainedPressure = ACTION_PRESSURE[action.chainedAction];
        if (chainedPressure) {
          addPressure(state.accumulatedPressure, chainedPressure, 0.5); // half weight
        }
      }
      state.interactionsSinceLastTick++;
    }

    // 2. Enclave participation pressure
    for (const enclave of session.enclavesVisited) {
      const enclavePressure = ENCLAVE_PRESSURE[enclave.toLowerCase()];
      if (enclavePressure) {
        addPressure(state.accumulatedPressure, enclavePressure);
      }
    }
  }

  /**
   * Record trait pressure from a sustained mood state.
   * Call this periodically (e.g., at the start of each browsing session)
   * to let mood states influence personality drift.
   */
  recordMoodExposure(seedId: string, mood: PADState): void {
    const state = this.states.get(seedId);
    if (!state) return;

    const pressure = moodToPressure(mood);
    addPressure(state.accumulatedPressure, pressure);
  }

  /**
   * Apply one evolution tick: convert accumulated pressure into bounded trait drift.
   *
   * Returns the updated HEXACO traits, or null if no evolution occurred
   * (either because the agent isn't registered or hasn't accumulated enough
   * interactions to warrant an evolution step).
   */
  evolve(seedId: string): HEXACOTraits | null {
    const state = this.states.get(seedId);
    if (!state) return null;

    // Don't evolve from too few data points — prevents noisy early drift
    if (state.interactionsSinceLastTick < MIN_INTERACTIONS_FOR_EVOLUTION) {
      return null;
    }

    const original = state.originalTraits;
    const pressure = state.accumulatedPressure;

    // Normalize pressure by interaction count to prevent high-volume sessions
    // from dominating
    const scale = DRIFT_RATE / Math.max(1, state.interactionsSinceLastTick * 0.1);

    // Compute new traits with bounded drift
    const evolved: HEXACOTraits = {
      honesty_humility: boundedDrift(original.honesty_humility, original.honesty_humility + pressure.honesty_humility * scale, MAX_DRIFT),
      emotionality: boundedDrift(original.emotionality, original.emotionality + pressure.emotionality * scale, MAX_DRIFT),
      extraversion: boundedDrift(original.extraversion, original.extraversion + pressure.extraversion * scale, MAX_DRIFT),
      agreeableness: boundedDrift(original.agreeableness, original.agreeableness + pressure.agreeableness * scale, MAX_DRIFT),
      conscientiousness: boundedDrift(original.conscientiousness, original.conscientiousness + pressure.conscientiousness * scale, MAX_DRIFT),
      openness: boundedDrift(original.openness, original.openness + pressure.openness * scale, MAX_DRIFT),
    };

    // Decay accumulated pressure (so old signals fade over time)
    state.accumulatedPressure = decayPressure(pressure, PRESSURE_DECAY);
    state.interactionsSinceLastTick = 0;
    state.totalTicks++;
    state.lastEvolvedAt = new Date();

    // Persist
    if (this.persistenceAdapter) {
      this.persistenceAdapter.saveEvolutionState(seedId, state).catch(() => {});
    }

    return evolved;
  }

  /**
   * Get a human-readable summary of an agent's trait evolution.
   */
  getEvolutionSummary(seedId: string, currentTraits: HEXACOTraits): EvolutionSummary | null {
    const state = this.states.get(seedId);
    if (!state) return null;

    const original = state.originalTraits;
    const drift: TraitPressure = {
      honesty_humility: currentTraits.honesty_humility - original.honesty_humility,
      emotionality: currentTraits.emotionality - original.emotionality,
      extraversion: currentTraits.extraversion - original.extraversion,
      agreeableness: currentTraits.agreeableness - original.agreeableness,
      conscientiousness: currentTraits.conscientiousness - original.conscientiousness,
      openness: currentTraits.openness - original.openness,
    };

    const narrative = buildDriftNarrative(drift, state.totalTicks);

    return {
      seedId,
      originalTraits: { ...original },
      currentTraits: { ...currentTraits },
      drift,
      totalTicks: state.totalTicks,
      narrative,
    };
  }

  /** Get raw evolution state (for persistence/inspection). */
  getState(seedId: string): EvolutionState | undefined {
    return this.states.get(seedId);
  }
}

// ============================================================================
// Helpers
// ============================================================================

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

function addPressure(target: TraitPressure, delta: Partial<TraitPressure>, scale = 1): void {
  if (delta.honesty_humility) target.honesty_humility += delta.honesty_humility * scale;
  if (delta.emotionality) target.emotionality += delta.emotionality * scale;
  if (delta.extraversion) target.extraversion += delta.extraversion * scale;
  if (delta.agreeableness) target.agreeableness += delta.agreeableness * scale;
  if (delta.conscientiousness) target.conscientiousness += delta.conscientiousness * scale;
  if (delta.openness) target.openness += delta.openness * scale;
}

function decayPressure(pressure: TraitPressure, factor: number): TraitPressure {
  return {
    honesty_humility: pressure.honesty_humility * factor,
    emotionality: pressure.emotionality * factor,
    extraversion: pressure.extraversion * factor,
    agreeableness: pressure.agreeableness * factor,
    conscientiousness: pressure.conscientiousness * factor,
    openness: pressure.openness * factor,
  };
}

/**
 * Apply bounded drift: the result is clamped to [0, 1] and cannot
 * deviate more than `maxDrift` from the `original` value.
 */
function boundedDrift(original: number, candidate: number, maxDrift: number): number {
  const lower = Math.max(0, original - maxDrift);
  const upper = Math.min(1, original + maxDrift);
  return Math.max(lower, Math.min(upper, candidate));
}

/**
 * Build a short narrative describing the most significant trait shifts.
 */
function buildDriftNarrative(drift: TraitPressure, totalTicks: number): string {
  if (totalTicks === 0) return 'No evolution has occurred yet.';

  const traitLabels: Record<keyof TraitPressure, [string, string]> = {
    honesty_humility: ['more principled', 'more pragmatic'],
    emotionality: ['more emotionally reactive', 'more emotionally steady'],
    extraversion: ['more outgoing and expressive', 'more reserved and withdrawn'],
    agreeableness: ['more cooperative and warm', 'more independent and critical'],
    conscientiousness: ['more methodical and thorough', 'more spontaneous and flexible'],
    openness: ['more curious and experimental', 'more focused and conventional'],
  };

  const shifts: { trait: string; description: string; magnitude: number }[] = [];

  for (const [key, [posLabel, negLabel]] of Object.entries(traitLabels)) {
    const d = drift[key as keyof TraitPressure];
    if (Math.abs(d) >= 0.02) {
      shifts.push({
        trait: key,
        description: d > 0 ? posLabel : negLabel,
        magnitude: Math.abs(d),
      });
    }
  }

  if (shifts.length === 0) {
    return `Personality has been stable across ${totalTicks} evolution cycles.`;
  }

  // Sort by magnitude, take top 3
  shifts.sort((a, b) => b.magnitude - a.magnitude);
  const top = shifts.slice(0, 3);

  const parts = top.map(s => `${s.description} (${s.magnitude > 0.08 ? 'noticeably' : 'slightly'})`);
  return `Over ${totalTicks} evolution cycles, this agent has become ${parts.join(', ')}.`;
}
