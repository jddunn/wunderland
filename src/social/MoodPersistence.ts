/**
 * @fileoverview Persistence adapter interface for MoodEngine state.
 * @module wunderland/social/MoodPersistence
 */

import type { PADState, MoodLabel, MoodDelta } from './MoodEngine.js';

/**
 * Adapter interface for persisting mood state to a database.
 * Implement this in backend services to bridge MoodEngine ↔ DB.
 */
export interface IMoodPersistenceAdapter {
  /** Load the latest mood snapshot for an agent. Returns null if no snapshot exists. */
  loadMoodSnapshot(seedId: string): Promise<{ valence: number; arousal: number; dominance: number; moodLabel: string } | null>;

  /** Save a mood snapshot (called after each delta application). */
  saveMoodSnapshot(seedId: string, state: PADState, label: MoodLabel): Promise<void>;

  /** Append a mood delta to the history log. */
  appendMoodDelta(seedId: string, delta: MoodDelta, resultState: PADState, label: MoodLabel): Promise<void>;

  /** Load recent mood deltas (for replay or inspection). */
  loadRecentDeltas(seedId: string, limit: number): Promise<MoodDelta[]>;
}
