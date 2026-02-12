/**
 * @file DeliverableManager.ts
 * @description Manages job deliverables: in-memory storage, SHA-256 hash generation,
 * and submission via callbacks.
 *
 * This is a plain TypeScript class (no NestJS, no DB, no Solana direct imports).
 * External dependencies (persistence, Solana submission) are injected via callbacks
 * so the backend or CLI can wire them up as needed.
 */

import { createHash, randomUUID } from 'crypto';
import type { Deliverable } from './QualityChecker.js';

export interface SubmissionMetadata {
  jobId: string;
  agentId: string;
  deliverableId: string;
  timestamp: number;
  contentHash: string;
}

export interface StoredDeliverable {
  deliverableId: string;
  jobId: string;
  agentId: string;
  deliverable: Deliverable;
  submissionHash: string;
  contentHash: string;
  fileSize: number;
  createdAt: number;
  status: 'pending' | 'submitted' | 'accepted' | 'rejected';
}

export interface SubmissionResult {
  success: boolean;
  deliverableId?: string;
  submissionHash?: string;
  signature?: string;
  error?: string;
}

/**
 * Callback to persist a deliverable externally (DB, IPFS, etc.).
 */
export type PersistDeliverableCallback = (
  stored: StoredDeliverable,
) => Promise<void>;

/**
 * Callback to submit a job on-chain (Solana, etc.).
 */
export type SubmitJobCallback = (params: {
  agentId: string;
  jobId: string;
  submissionHash: string;
}) => Promise<SubmissionResult>;

export interface DeliverableManagerConfig {
  /**
   * Optional callback to persist deliverables externally.
   * If not provided, deliverables are stored in-memory only.
   */
  onPersist?: PersistDeliverableCallback;

  /**
   * Optional callback to submit a job on-chain.
   * If not provided, submission returns a mock success.
   */
  onSubmit?: SubmitJobCallback;
}

/**
 * Manages deliverable storage, hash generation, and submission.
 */
export class DeliverableManager {
  private readonly deliverables = new Map<string, StoredDeliverable>();
  private readonly onPersist?: PersistDeliverableCallback;
  private readonly onSubmit?: SubmitJobCallback;

  constructor(config?: DeliverableManagerConfig) {
    this.onPersist = config?.onPersist;
    this.onSubmit = config?.onSubmit;
  }

  /**
   * Store a deliverable and return its ID.
   */
  async storeDeliverable(
    jobId: string,
    agentId: string,
    deliverable: Deliverable,
  ): Promise<string> {
    const deliverableId = randomUUID();
    const now = Date.now();
    const fileSize = Buffer.byteLength(deliverable.content, 'utf8');

    const contentHash = createHash('sha256')
      .update(deliverable.content, 'utf8')
      .digest('hex');

    const submissionHash = this.generateSubmissionHash({
      jobId,
      agentId,
      deliverableId,
      timestamp: now,
      contentHash,
    });

    const stored: StoredDeliverable = {
      deliverableId,
      jobId,
      agentId,
      deliverable,
      submissionHash,
      contentHash,
      fileSize,
      createdAt: now,
      status: 'pending',
    };

    // Store in memory
    this.deliverables.set(deliverableId, stored);

    // Persist externally if callback provided
    if (this.onPersist) {
      try {
        await this.onPersist(stored);
      } catch (err) {
        console.error('[DeliverableManager] Persistence callback failed:', err);
      }
    }

    console.log(
      `[DeliverableManager] Stored deliverable ${deliverableId} for job ${jobId} (${fileSize} bytes)`,
    );

    return deliverableId;
  }

  /**
   * Submit a job deliverable via the on-chain callback.
   */
  async submitJob(
    agentId: string,
    jobId: string,
    deliverableId: string,
  ): Promise<SubmissionResult> {
    const stored = this.deliverables.get(deliverableId);

    if (!stored) {
      return { success: false, error: 'Deliverable not found' };
    }

    if (this.onSubmit) {
      try {
        const result = await this.onSubmit({
          agentId,
          jobId,
          submissionHash: stored.submissionHash,
        });

        if (result.success) {
          stored.status = 'submitted';
          console.log(
            `[DeliverableManager] Job ${jobId} submitted — deliverable: ${deliverableId}, signature: ${result.signature ?? 'n/a'}`,
          );
        } else {
          console.error(
            `[DeliverableManager] Failed to submit job ${jobId}: ${result.error}`,
          );
        }

        return result;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[DeliverableManager] Submission error for job ${jobId}:`, err);
        return { success: false, error: errorMsg };
      }
    }

    // No submit callback — return mock success
    stored.status = 'submitted';
    console.log(
      `[DeliverableManager] Job ${jobId} submitted (mock — no onSubmit callback)`,
    );
    return {
      success: true,
      deliverableId,
      submissionHash: stored.submissionHash,
      signature: 'mock-signature',
    };
  }

  /**
   * Retrieve a stored deliverable by ID.
   */
  getDeliverable(deliverableId: string): StoredDeliverable | undefined {
    return this.deliverables.get(deliverableId);
  }

  /**
   * Get all deliverables for a specific job.
   */
  getDeliverablesForJob(jobId: string): StoredDeliverable[] {
    return Array.from(this.deliverables.values()).filter(
      (d) => d.jobId === jobId,
    );
  }

  /**
   * Generate deterministic SHA-256 submission hash from metadata.
   */
  private generateSubmissionHash(metadata: SubmissionMetadata): string {
    const canonical = JSON.stringify(metadata, Object.keys(metadata).sort());
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }
}
