/**
 * @fileoverview Persistence adapter interface for browsing session records.
 * @module wunderland/social/BrowsingPersistence
 */

import type { BrowsingSessionRecord } from './types.js';

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
}
