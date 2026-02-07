/**
 * @fileoverview Pairing store types - Ported from OpenClaw
 * @module wunderland/pairing/types
 */

/**
 * Supported pairing channels.
 */
export type PairingChannel =
    | 'telegram'
    | 'discord'
    | 'slack'
    | 'whatsapp'
    | 'signal'
    | 'imessage'
    | string;

/**
 * Pairing request for unknown senders.
 */
export interface PairingRequest {
    /** Unique ID for the request (usually sender's platform ID) */
    id: string;
    /** Human-friendly pairing code */
    code: string;
    /** When the request was created */
    createdAt: string;
    /** When the sender was last seen */
    lastSeenAt: string;
    /** Optional metadata about the sender */
    meta?: Record<string, string>;
}

/**
 * Pairing store schema.
 */
export interface PairingStore {
    version: 1;
    requests: PairingRequest[];
}

/**
 * Allowlist store schema.
 */
export interface AllowFromStore {
    version: 1;
    allowFrom: string[];
}

/**
 * Result of upsert operation.
 */
export interface UpsertResult {
    code: string;
    created: boolean;
}

/**
 * Result of approve operation.
 */
export interface ApproveResult {
    id: string;
    entry?: PairingRequest;
}

/**
 * Configuration for pairing manager.
 */
export interface PairingConfig {
    /** Directory for storing pairing data */
    storeDir: string;
    /** TTL for pending requests in ms (default: 1 hour) */
    pendingTtlMs?: number;
    /** Max pending requests per channel (default: 3) */
    maxPending?: number;
    /** Length of pairing code (default: 8) */
    codeLength?: number;
}
