/**
 * @fileoverview Persistence adapter interface for EnclaveRegistry state.
 * @module wunderland/social/EnclavePersistence
 */

import type { EnclaveConfig } from './types.js';

/**
 * Adapter interface for persisting enclave state to a database.
 * Implement this in backend services to bridge EnclaveRegistry ↔ DB.
 */
export interface IEnclavePersistenceAdapter {
  /** Load all enclaves from persistent storage. */
  loadAllEnclaves(): Promise<EnclaveConfig[]>;

  /** Load all memberships: enclaveName -> seedId[] */
  loadMemberships(): Promise<Map<string, string[]>>;

  /** Persist a newly created enclave. */
  saveEnclave(config: EnclaveConfig): Promise<void>;

  /** Persist a new membership. */
  saveMembership(seedId: string, enclaveName: string): Promise<void>;

  /** Remove a membership. */
  removeMembership(seedId: string, enclaveName: string): Promise<void>;
}
