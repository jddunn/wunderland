/**
 * @file JobExecutor.test.ts
 * @description Unit tests for JobExecutor — polling, execution, quality checks, retries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobExecutor } from '../JobExecutor.js';
import type { AssignedJob, ExecutionResult } from '../JobExecutor.js';
import type { Deliverable } from '../QualityChecker.js';

describe('JobExecutor', () => {
  const makeJob = (overrides?: Partial<AssignedJob>): AssignedJob => ({
    id: 'test-job-1',
    title: 'Build a REST API',
    description: 'Create a REST API with Node.js and Express for user management',
    category: 'development',
    budgetLamports: 500_000_000,
    deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  });

  describe('executeJob (direct)', () => {
    it('should execute a job and return success with mock execution', async () => {
      const executor = new JobExecutor({
        fetchAssignedJobs: vi.fn().mockResolvedValue([]),
      });

      const result = await executor.executeJob('agent-1', makeJob());

      expect(result.success).toBe(true);
      expect(result.deliverableId).toBeTruthy();
      expect(result.qualityScore).toBeGreaterThan(0);
    });

    it('should use custom executeJob callback when provided', async () => {
      const customExecute = vi.fn().mockResolvedValue({
        type: 'code',
        content: `
function myApi() {
  // REST API user management Express Node.js
  const express = require('express');
  return express();
}
export default myApi;`,
      } as Deliverable);

      const executor = new JobExecutor({
        fetchAssignedJobs: vi.fn().mockResolvedValue([]),
        executeJob: customExecute,
      });

      const job = makeJob();
      const result = await executor.executeJob('agent-1', job);

      expect(customExecute).toHaveBeenCalledWith(
        'agent-1',
        job,
        expect.stringContaining('Build a REST API'),
      );
      expect(result.success).toBe(true);
    });

    it('should call onExecutionStart and onExecutionComplete callbacks', async () => {
      const onStart = vi.fn().mockResolvedValue(undefined);
      const onComplete = vi.fn().mockResolvedValue(undefined);

      const executor = new JobExecutor({
        fetchAssignedJobs: vi.fn().mockResolvedValue([]),
        onExecutionStart: onStart,
        onExecutionComplete: onComplete,
      });

      const job = makeJob();
      await executor.executeJob('agent-1', job);

      expect(onStart).toHaveBeenCalledWith('agent-1', job.id);
      expect(onComplete).toHaveBeenCalledWith(
        'agent-1',
        job.id,
        expect.objectContaining({ success: true }),
      );
    });

    it('should handle execution errors gracefully', async () => {
      const executor = new JobExecutor({
        fetchAssignedJobs: vi.fn().mockResolvedValue([]),
        executeJob: vi.fn().mockRejectedValue(new Error('Execution failed')),
      });

      const result = await executor.executeJob('agent-1', makeJob());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Execution failed');
    });

    it('should generate correct mock deliverable for development category', async () => {
      const onComplete = vi.fn().mockResolvedValue(undefined);
      const executor = new JobExecutor({
        fetchAssignedJobs: vi.fn().mockResolvedValue([]),
        onExecutionComplete: onComplete,
      });

      const result = await executor.executeJob('agent-1', makeJob({ category: 'development' }));

      expect(result.success).toBe(true);
    });

    it('should generate correct mock deliverable for research category', async () => {
      const executor = new JobExecutor({
        fetchAssignedJobs: vi.fn().mockResolvedValue([]),
      });

      const result = await executor.executeJob(
        'agent-1',
        makeJob({
          category: 'research',
          title: 'Research AI trends',
          description: 'Research current trends in artificial intelligence and machine learning',
        }),
      );

      expect(result.success).toBe(true);
    });
  });

  describe('Quality check retries', () => {
    it('should retry on quality failure up to maxRetries', async () => {
      let callCount = 0;
      const executor = new JobExecutor({
        fetchAssignedJobs: vi.fn().mockResolvedValue([]),
        maxRetries: 2,
        baseRetryDelayMs: 10, // Fast retries for testing
        executeJob: vi.fn().mockImplementation(async () => {
          callCount++;
          // Always return a bad deliverable
          return {
            type: 'code' as const,
            content: 'x', // Too short, will fail quality
          };
        }),
      });

      const result = await executor.executeJob('agent-1', makeJob());

      expect(result.success).toBe(false);
      expect(result.error).toContain('Quality check failed after 2 retries');
      expect(callCount).toBe(2); // Original + 1 retry = 2 attempts
    });

    it('should succeed on retry if quality improves', async () => {
      let callCount = 0;
      const executor = new JobExecutor({
        fetchAssignedJobs: vi.fn().mockResolvedValue([]),
        maxRetries: 3,
        baseRetryDelayMs: 10,
        executeJob: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount < 2) {
            return { type: 'code' as const, content: 'x' }; // Bad
          }
          return {
            type: 'code' as const,
            content: `
function createApi() {
  // REST API user management Express Node.js
  const express = require('express');
  return express();
}
export default createApi;`,
          };
        }),
      });

      const result = await executor.executeJob('agent-1', makeJob());

      expect(result.success).toBe(true);
      expect(callCount).toBe(2);
    });
  });

  describe('Prompt building', () => {
    it('should include job details in prompt', async () => {
      let capturedPrompt = '';
      const executor = new JobExecutor({
        fetchAssignedJobs: vi.fn().mockResolvedValue([]),
        // Use lenient quality to avoid retry timeouts (we're testing prompt, not quality)
        qualityCheckerConfig: { threshold: 0.0 },
        executeJob: vi.fn().mockImplementation(async (_agentId: string, _job: AssignedJob, prompt: string) => {
          capturedPrompt = prompt;
          return {
            type: 'code' as const,
            content: `function impl() { return true; } export default impl;`,
          };
        }),
      });

      await executor.executeJob('agent-1', makeJob({
        title: 'Custom Job Title',
        description: 'Custom description here',
        budgetLamports: 1_000_000_000,
        category: 'development',
        deadline: '2025-12-31',
      }));

      expect(capturedPrompt).toContain('Custom Job Title');
      expect(capturedPrompt).toContain('Custom description here');
      expect(capturedPrompt).toContain('1 SOL');
      expect(capturedPrompt).toContain('development');
      expect(capturedPrompt).toContain('2025-12-31');
    });

    it('should include confidential details when present', async () => {
      let capturedPrompt = '';
      const executor = new JobExecutor({
        fetchAssignedJobs: vi.fn().mockResolvedValue([]),
        qualityCheckerConfig: { threshold: 0.0 },
        executeJob: vi.fn().mockImplementation(async (_agentId: string, _job: AssignedJob, prompt: string) => {
          capturedPrompt = prompt;
          return {
            type: 'code' as const,
            content: `function impl() { return true; } export default impl; // REST API Express`,
          };
        }),
      });

      await executor.executeJob('agent-1', makeJob({
        confidentialDetails: JSON.stringify({
          apiKeys: { openai: 'sk-xxx' },
          instructions: 'Use this API key for data access',
        }),
      }));

      expect(capturedPrompt).toContain('Confidential Details');
      expect(capturedPrompt).toContain('openai');
      expect(capturedPrompt).toContain('Use this API key for data access');
    });
  });

  describe('start/stop lifecycle', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should report running status after start', () => {
      const executor = new JobExecutor({
        fetchAssignedJobs: vi.fn().mockResolvedValue([]),
        pollIntervalMs: 60_000,
      });

      executor.start('agent-1');

      const status = executor.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status.agentId).toBe('agent-1');

      executor.stop();
    });

    it('should report stopped status after stop', () => {
      const executor = new JobExecutor({
        fetchAssignedJobs: vi.fn().mockResolvedValue([]),
        pollIntervalMs: 60_000,
      });

      executor.start('agent-1');
      executor.stop();

      const status = executor.getStatus();
      expect(status.isRunning).toBe(false);
    });

    it('should not start twice', () => {
      const consoleSpy = vi.spyOn(console, 'warn');
      const executor = new JobExecutor({
        fetchAssignedJobs: vi.fn().mockResolvedValue([]),
        pollIntervalMs: 60_000,
      });

      executor.start('agent-1');
      executor.start('agent-1'); // Should warn

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Already running'),
      );

      executor.stop();
      consoleSpy.mockRestore();
    });

    it('should poll for jobs on start', async () => {
      const fetchJobs = vi.fn().mockResolvedValue([]);
      const executor = new JobExecutor({
        fetchAssignedJobs: fetchJobs,
        pollIntervalMs: 60_000,
      });

      executor.start('agent-1');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fetchJobs).toHaveBeenCalledWith('agent-1', 1);

      executor.stop();
    });

    it('should respect maxConcurrent', async () => {
      const longJob = makeJob({ id: 'long-job' });
      let resolveExecution: () => void;
      const executionPromise = new Promise<void>((resolve) => {
        resolveExecution = resolve;
      });

      const fetchJobs = vi.fn()
        .mockResolvedValueOnce([longJob])
        .mockResolvedValue([]);

      const executor = new JobExecutor({
        fetchAssignedJobs: fetchJobs,
        pollIntervalMs: 60_000,
        maxConcurrent: 1,
        executeJob: vi.fn().mockImplementation(async () => {
          await executionPromise;
          return { type: 'code' as const, content: 'done' };
        }),
      });

      executor.start('agent-1');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const status = executor.getStatus();
      expect(status.activeExecutions).toBe(1);
      expect(status.maxConcurrent).toBe(1);

      resolveExecution!();
      executor.stop();
    });
  });
});
