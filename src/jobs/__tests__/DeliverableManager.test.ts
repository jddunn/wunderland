/**
 * @file DeliverableManager.test.ts
 * @description Unit tests for DeliverableManager — storage, hashing, and submission.
 */

import { describe, it, expect, vi } from 'vitest';
import { DeliverableManager } from '../DeliverableManager.js';
import type { Deliverable } from '../QualityChecker.js';
import type { StoredDeliverable, SubmissionResult } from '../DeliverableManager.js';

describe('DeliverableManager', () => {
  const testDeliverable: Deliverable = {
    type: 'code',
    content: 'function hello() { return "world"; }',
  };

  describe('storeDeliverable', () => {
    it('should store a deliverable and return an ID', async () => {
      const manager = new DeliverableManager();
      const id = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);

      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('should store deliverable retrievable by ID', async () => {
      const manager = new DeliverableManager();
      const id = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);

      const stored = manager.getDeliverable(id);
      expect(stored).toBeDefined();
      expect(stored!.jobId).toBe('job-1');
      expect(stored!.agentId).toBe('agent-1');
      expect(stored!.deliverable.content).toBe(testDeliverable.content);
      expect(stored!.status).toBe('pending');
    });

    it('should generate a valid SHA-256 submission hash', async () => {
      const manager = new DeliverableManager();
      const id = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);

      const stored = manager.getDeliverable(id);
      expect(stored!.submissionHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should generate a valid SHA-256 content hash', async () => {
      const manager = new DeliverableManager();
      const id = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);

      const stored = manager.getDeliverable(id);
      expect(stored!.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should calculate correct file size', async () => {
      const manager = new DeliverableManager();
      const id = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);

      const stored = manager.getDeliverable(id);
      expect(stored!.fileSize).toBe(
        Buffer.byteLength(testDeliverable.content, 'utf8'),
      );
    });

    it('should call onPersist callback when provided', async () => {
      const onPersist = vi.fn().mockResolvedValue(undefined);
      const manager = new DeliverableManager({ onPersist });

      await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);

      expect(onPersist).toHaveBeenCalledTimes(1);
      expect(onPersist).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-1',
          agentId: 'agent-1',
          status: 'pending',
        }),
      );
    });

    it('should not throw if onPersist callback fails', async () => {
      const onPersist = vi.fn().mockRejectedValue(new Error('DB error'));
      const manager = new DeliverableManager({ onPersist });

      // Should not throw
      const id = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);
      expect(id).toBeTruthy();
    });

    it('should generate unique IDs for different deliverables', async () => {
      const manager = new DeliverableManager();
      const id1 = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);
      const id2 = await manager.storeDeliverable('job-2', 'agent-1', testDeliverable);

      expect(id1).not.toBe(id2);
    });
  });

  describe('submitJob', () => {
    it('should return mock success when no onSubmit callback', async () => {
      const manager = new DeliverableManager();
      const deliverableId = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);

      const result = await manager.submitJob('agent-1', 'job-1', deliverableId);

      expect(result.success).toBe(true);
      expect(result.deliverableId).toBe(deliverableId);
      expect(result.submissionHash).toBeTruthy();
      expect(result.signature).toBe('mock-signature');
    });

    it('should update status to submitted on success', async () => {
      const manager = new DeliverableManager();
      const deliverableId = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);

      await manager.submitJob('agent-1', 'job-1', deliverableId);

      const stored = manager.getDeliverable(deliverableId);
      expect(stored!.status).toBe('submitted');
    });

    it('should return error if deliverable not found', async () => {
      const manager = new DeliverableManager();
      const result = await manager.submitJob('agent-1', 'job-1', 'nonexistent-id');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Deliverable not found');
    });

    it('should use onSubmit callback when provided', async () => {
      const onSubmit = vi.fn().mockResolvedValue({
        success: true,
        signature: 'real-sig-123',
      } as SubmissionResult);

      const manager = new DeliverableManager({ onSubmit });
      const deliverableId = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);

      const result = await manager.submitJob('agent-1', 'job-1', deliverableId);

      expect(result.success).toBe(true);
      expect(result.signature).toBe('real-sig-123');
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          jobId: 'job-1',
        }),
      );
    });

    it('should handle onSubmit callback failure', async () => {
      const onSubmit = vi.fn().mockRejectedValue(new Error('Solana error'));
      const manager = new DeliverableManager({ onSubmit });
      const deliverableId = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);

      const result = await manager.submitJob('agent-1', 'job-1', deliverableId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Solana error');
    });

    it('should handle onSubmit returning failure', async () => {
      const onSubmit = vi.fn().mockResolvedValue({
        success: false,
        error: 'Insufficient funds',
      } as SubmissionResult);

      const manager = new DeliverableManager({ onSubmit });
      const deliverableId = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);

      const result = await manager.submitJob('agent-1', 'job-1', deliverableId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Insufficient funds');
    });
  });

  describe('getDeliverablesForJob', () => {
    it('should return all deliverables for a specific job', async () => {
      const manager = new DeliverableManager();

      await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);
      await manager.storeDeliverable('job-1', 'agent-2', {
        type: 'report',
        content: 'Another deliverable',
      });
      await manager.storeDeliverable('job-2', 'agent-1', testDeliverable);

      const job1Deliverables = manager.getDeliverablesForJob('job-1');
      expect(job1Deliverables).toHaveLength(2);

      const job2Deliverables = manager.getDeliverablesForJob('job-2');
      expect(job2Deliverables).toHaveLength(1);
    });

    it('should return empty array for unknown job', () => {
      const manager = new DeliverableManager();
      expect(manager.getDeliverablesForJob('nonexistent')).toHaveLength(0);
    });
  });

  describe('Hash determinism', () => {
    it('should generate different submission hashes for different jobs', async () => {
      const manager = new DeliverableManager();

      const id1 = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);
      const id2 = await manager.storeDeliverable('job-2', 'agent-1', testDeliverable);

      const stored1 = manager.getDeliverable(id1);
      const stored2 = manager.getDeliverable(id2);

      expect(stored1!.submissionHash).not.toBe(stored2!.submissionHash);
    });

    it('should generate same content hash for same content', async () => {
      const manager = new DeliverableManager();

      const id1 = await manager.storeDeliverable('job-1', 'agent-1', testDeliverable);
      const id2 = await manager.storeDeliverable('job-2', 'agent-1', testDeliverable);

      const stored1 = manager.getDeliverable(id1);
      const stored2 = manager.getDeliverable(id2);

      expect(stored1!.contentHash).toBe(stored2!.contentHash);
    });
  });
});
