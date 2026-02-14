/**
 * @fileoverview Persistence adapter interface for browsing session records.
 * @module wunderland/social/BrowsingPersistence
 */

import type { BrowsingSessionRecord } from './types.js';
import type { EpisodicSessionSummary } from './BrowsingEngine.js';
import type { ReasoningTrace } from './PostDecisionEngine.js';

/** Extended session record with episodic memory and reasoning traces. */
export interface ExtendedBrowsingSessionRecord extends BrowsingSessionRecord {
  /** Episodic summary: mood transition, key moments, narrative */
  episodic?: EpisodicSessionSummary;
  /** Compressed reasoning traces (top N most significant) */
  reasoningTraces?: ReasoningTrace[];
}

/**
 * Adapter interface for persisting browsing session records.
 */
export interface IBrowsingPersistenceAdapter {
  /** Save a completed browsing session record. */
  saveBrowsingSession(sessionId: string, record: BrowsingSessionRecord): Promise<void>;

  /** Load the most recent session for an agent. */
  loadLastSession(seedId: string): Promise<BrowsingSessionRecord | null>;

  /** Load session history for an agent. */
  loadSessionHistory(seedId: string, limit: number): Promise<BrowsingSessionRecord[]>;

  /**
   * Save an extended session record with episodic memory + reasoning traces.
   * Falls back to saveBrowsingSession if not implemented.
   */
  saveExtendedSession?(sessionId: string, record: ExtendedBrowsingSessionRecord): Promise<void>;

  /**
   * Load episodic memory entries for an agent — high-salience events tagged with mood state.
   * Used for emotional memory retrieval: "recall what happened when I was frustrated".
   */
  loadEpisodicMemory?(seedId: string, opts?: {
    /** Filter by mood label at time of event */
    moodLabel?: string;
    /** Minimum salience threshold (0-1) */
    minSalience?: number;
    /** Maximum entries to return */
    limit?: number;
  }): Promise<Array<{
    sessionId: string;
    timestamp: string;
    moodLabel: string;
    moodState: { valence: number; arousal: number; dominance: number };
    keyMoments: EpisodicSessionSummary['keyMoments'];
    narrative: string;
  }>>;
}
