/**
 * Unit tests for the CronScheduler class.
 *
 * Tests cover CRUD operations, schedule computation for all three schedule
 * kinds ('at', 'every', 'cron'), lifecycle start/stop, pause/resume, and
 * the built-in cron expression parser.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronScheduler } from '../CronScheduler.js';
import type {
  CronSchedule,
  CronJob,
  CronPayload,
  CreateCronJobInput,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A simple stimulus payload used across tests. */
const stubPayload: CronPayload = {
  kind: 'stimulus',
  stimulusType: 'test',
  data: { foo: 'bar' },
};

function makeJobInput(overrides: Partial<CreateCronJobInput> = {}): CreateCronJobInput {
  return {
    name: 'Test Job',
    enabled: true,
    schedule: { kind: 'every', everyMs: 60_000 },
    payload: stubPayload,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CronScheduler', () => {
  let scheduler: CronScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new CronScheduler({ tickMs: 1_000 });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  // =========================================================================
  // addJob
  // =========================================================================

  describe('addJob', () => {
    it('should add a job and return it with a generated id', () => {
      const job = scheduler.addJob(makeJobInput());

      expect(job.id).toBeDefined();
      expect(typeof job.id).toBe('string');
      expect(job.id.length).toBeGreaterThan(0);
      expect(job.name).toBe('Test Job');
      expect(job.enabled).toBe(true);
    });

    it('should initialise state with runCount 0', () => {
      const job = scheduler.addJob(makeJobInput());
      expect(job.state.runCount).toBe(0);
    });

    it('should compute nextRunAtMs when enabled', () => {
      const job = scheduler.addJob(makeJobInput({ enabled: true }));
      expect(job.state.nextRunAtMs).toBeDefined();
      expect(typeof job.state.nextRunAtMs).toBe('number');
    });

    it('should NOT compute nextRunAtMs when disabled', () => {
      const job = scheduler.addJob(makeJobInput({ enabled: false }));
      expect(job.state.nextRunAtMs).toBeUndefined();
    });

    it('should set createdAt and updatedAt to the current time', () => {
      const now = Date.now();
      const job = scheduler.addJob(makeJobInput());

      expect(job.createdAt).toBe(now);
      expect(job.updatedAt).toBe(now);
    });

    it('should return a structuredClone (not a reference to internal state)', () => {
      const job = scheduler.addJob(makeJobInput());
      job.name = 'mutated';

      const fetched = scheduler.getJob(job.id);
      expect(fetched!.name).toBe('Test Job');
    });
  });

  // =========================================================================
  // removeJob
  // =========================================================================

  describe('removeJob', () => {
    it('should remove an existing job and return true', () => {
      const job = scheduler.addJob(makeJobInput());
      expect(scheduler.removeJob(job.id)).toBe(true);
      expect(scheduler.getJob(job.id)).toBeUndefined();
    });

    it('should return false when the job does not exist', () => {
      expect(scheduler.removeJob('nonexistent-id')).toBe(false);
    });
  });

  // =========================================================================
  // updateJob
  // =========================================================================

  describe('updateJob', () => {
    it('should update the name of an existing job', () => {
      const job = scheduler.addJob(makeJobInput());
      const updated = scheduler.updateJob(job.id, { name: 'Updated Name' });

      expect(updated).toBeDefined();
      expect(updated!.name).toBe('Updated Name');
    });

    it('should update the description', () => {
      const job = scheduler.addJob(makeJobInput());
      const updated = scheduler.updateJob(job.id, { description: 'A description' });

      expect(updated!.description).toBe('A description');
    });

    it('should update the schedule and recompute nextRunAtMs', () => {
      const job = scheduler.addJob(makeJobInput());
      const originalNext = job.state.nextRunAtMs;

      const updated = scheduler.updateJob(job.id, {
        schedule: { kind: 'every', everyMs: 120_000 },
      });

      // The next run should be recalculated based on the new interval
      expect(updated!.schedule).toEqual({ kind: 'every', everyMs: 120_000 });
      expect(updated!.state.nextRunAtMs).toBeDefined();
    });

    it('should re-enable a disabled job and compute nextRunAtMs', () => {
      const job = scheduler.addJob(makeJobInput({ enabled: false }));
      expect(job.state.nextRunAtMs).toBeUndefined();

      const updated = scheduler.updateJob(job.id, { enabled: true });
      expect(updated!.enabled).toBe(true);
      expect(updated!.state.nextRunAtMs).toBeDefined();
    });

    it('should disable a job and clear nextRunAtMs', () => {
      const job = scheduler.addJob(makeJobInput({ enabled: true }));
      expect(job.state.nextRunAtMs).toBeDefined();

      const updated = scheduler.updateJob(job.id, { enabled: false });
      expect(updated!.enabled).toBe(false);
      expect(updated!.state.nextRunAtMs).toBeUndefined();
    });

    it('should return undefined for a non-existent job', () => {
      expect(scheduler.updateJob('nonexistent', { name: 'x' })).toBeUndefined();
    });

    it('should bump updatedAt on update', () => {
      const job = scheduler.addJob(makeJobInput());
      const original = job.updatedAt;

      vi.advanceTimersByTime(5_000);
      const updated = scheduler.updateJob(job.id, { name: 'Later' });

      expect(updated!.updatedAt).toBeGreaterThan(original);
    });
  });

  // =========================================================================
  // getJob / listJobs
  // =========================================================================

  describe('getJob / listJobs', () => {
    it('should retrieve a single job by ID', () => {
      const job = scheduler.addJob(makeJobInput());
      const fetched = scheduler.getJob(job.id);

      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(job.id);
    });

    it('should return undefined for unknown IDs', () => {
      expect(scheduler.getJob('does-not-exist')).toBeUndefined();
    });

    it('should list all jobs', () => {
      scheduler.addJob(makeJobInput({ name: 'Job A' }));
      scheduler.addJob(makeJobInput({ name: 'Job B' }));

      const jobs = scheduler.listJobs();
      expect(jobs).toHaveLength(2);
    });

    it('should filter by seedId', () => {
      scheduler.addJob(makeJobInput({ name: 'A', seedId: 'seed-1' }));
      scheduler.addJob(makeJobInput({ name: 'B', seedId: 'seed-2' }));
      scheduler.addJob(makeJobInput({ name: 'C', seedId: 'seed-1' }));

      const filtered = scheduler.listJobs({ seedId: 'seed-1' });
      expect(filtered).toHaveLength(2);
      expect(filtered.every((j) => j.seedId === 'seed-1')).toBe(true);
    });

    it('should filter by enabled', () => {
      scheduler.addJob(makeJobInput({ name: 'Enabled', enabled: true }));
      scheduler.addJob(makeJobInput({ name: 'Disabled', enabled: false }));

      expect(scheduler.listJobs({ enabled: true })).toHaveLength(1);
      expect(scheduler.listJobs({ enabled: false })).toHaveLength(1);
    });
  });

  // =========================================================================
  // pauseJob / resumeJob
  // =========================================================================

  describe('pauseJob / resumeJob', () => {
    it('should pause a job (set enabled=false, clear nextRunAtMs)', () => {
      const job = scheduler.addJob(makeJobInput({ enabled: true }));
      expect(job.state.nextRunAtMs).toBeDefined();

      scheduler.pauseJob(job.id);
      const paused = scheduler.getJob(job.id)!;

      expect(paused.enabled).toBe(false);
      expect(paused.state.nextRunAtMs).toBeUndefined();
    });

    it('should resume a paused job (set enabled=true, compute nextRunAtMs)', () => {
      const job = scheduler.addJob(makeJobInput({ enabled: false }));

      scheduler.resumeJob(job.id);
      const resumed = scheduler.getJob(job.id)!;

      expect(resumed.enabled).toBe(true);
      expect(resumed.state.nextRunAtMs).toBeDefined();
    });

    it('should be a no-op for non-existent job IDs', () => {
      // Should not throw
      scheduler.pauseJob('ghost');
      scheduler.resumeJob('ghost');
    });

    it('should update updatedAt on pause and resume', () => {
      const job = scheduler.addJob(makeJobInput());
      const t0 = job.updatedAt;

      vi.advanceTimersByTime(1_000);
      scheduler.pauseJob(job.id);
      const t1 = scheduler.getJob(job.id)!.updatedAt;
      expect(t1).toBeGreaterThan(t0);

      vi.advanceTimersByTime(1_000);
      scheduler.resumeJob(job.id);
      const t2 = scheduler.getJob(job.id)!.updatedAt;
      expect(t2).toBeGreaterThan(t1);
    });
  });

  // =========================================================================
  // computeNextRunAtMs — 'at' schedule
  // =========================================================================

  describe('computeNextRunAtMs — at', () => {
    it('should return the target time when it is in the future', () => {
      const futureIso = '2030-01-01T00:00:00Z';
      const schedule: CronSchedule = { kind: 'at', at: futureIso };

      const next = scheduler.computeNextRunAtMs(schedule, Date.now());
      expect(next).toBe(new Date(futureIso).getTime());
    });

    it('should return undefined when the target time is in the past', () => {
      const pastIso = '2000-01-01T00:00:00Z';
      const schedule: CronSchedule = { kind: 'at', at: pastIso };

      expect(scheduler.computeNextRunAtMs(schedule, Date.now())).toBeUndefined();
    });

    it('should return undefined for an invalid date string', () => {
      const schedule: CronSchedule = { kind: 'at', at: 'not-a-date' };
      expect(scheduler.computeNextRunAtMs(schedule)).toBeUndefined();
    });
  });

  // =========================================================================
  // computeNextRunAtMs — 'every' schedule
  // =========================================================================

  describe('computeNextRunAtMs — every', () => {
    it('should return afterMs + everyMs when no anchor is set', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 60_000 };
      const after = 1_000_000;

      expect(scheduler.computeNextRunAtMs(schedule, after)).toBe(after + 60_000);
    });

    it('should return anchorMs when afterMs is before the anchor', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 60_000, anchorMs: 2_000_000 };
      const after = 1_000_000;

      expect(scheduler.computeNextRunAtMs(schedule, after)).toBe(2_000_000);
    });

    it('should align to the anchor grid when afterMs is past the anchor', () => {
      // anchor=0, every=100, after=250 -> next should be 300
      const schedule: CronSchedule = { kind: 'every', everyMs: 100, anchorMs: 0 };
      const after = 250;

      expect(scheduler.computeNextRunAtMs(schedule, after)).toBe(300);
    });

    it('should return undefined when everyMs is 0', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 0 };
      expect(scheduler.computeNextRunAtMs(schedule, 1000)).toBeUndefined();
    });

    it('should return undefined when everyMs is negative', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: -1 };
      expect(scheduler.computeNextRunAtMs(schedule, 1000)).toBeUndefined();
    });
  });

  // =========================================================================
  // computeNextRunAtMs — 'cron' schedule
  // =========================================================================

  describe('computeNextRunAtMs — cron', () => {
    it('should compute next run for "every minute" expression', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '* * * * *' };
      // Set a specific time so we can reason about the result
      const after = new Date('2030-06-15T12:00:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      // Should be the very next minute
      expect(next).toBe(new Date('2030-06-15T12:01:00Z').getTime());
    });

    it('should compute next run for "0 9 * * 1" (Monday 9am UTC)', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * 1' };
      // Start from a known Wednesday
      const wednesday = new Date('2030-01-02T10:00:00Z').getTime(); // Jan 2, 2030 is a Wednesday

      const next = scheduler.computeNextRunAtMs(schedule, wednesday);
      expect(next).toBeDefined();

      // The next Monday after Jan 2 (Wed) is Jan 7
      const nextDate = new Date(next!);
      expect(nextDate.getUTCDay()).toBe(1); // Monday
      expect(nextDate.getUTCHours()).toBe(9);
      expect(nextDate.getUTCMinutes()).toBe(0);
    });

    it('should compute next run for "*/5 * * * *" (every 5 minutes)', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '*/5 * * * *' };
      const after = new Date('2030-06-15T12:03:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const nextDate = new Date(next!);
      // Should land on the next :05 minute mark (or :00, :10, :15, etc.)
      expect(nextDate.getUTCMinutes() % 5).toBe(0);
      expect(next!).toBeGreaterThan(after);
    });

    it('should compute next run for "0 0 1 1 *" (midnight Jan 1st)', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 0 1 1 *' };
      const after = new Date('2030-01-02T00:00:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const nextDate = new Date(next!);
      expect(nextDate.getUTCMonth()).toBe(0); // January
      expect(nextDate.getUTCDate()).toBe(1);
      expect(nextDate.getUTCHours()).toBe(0);
      expect(nextDate.getUTCMinutes()).toBe(0);
      // Should be Jan 1 of the following year
      expect(nextDate.getUTCFullYear()).toBe(2031);
    });

    it('should return undefined for an invalid cron expression', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: 'bad cron' };
      expect(scheduler.computeNextRunAtMs(schedule)).toBeUndefined();
    });

    it('should return undefined for cron expressions with wrong field count', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '* * *' };
      expect(scheduler.computeNextRunAtMs(schedule)).toBeUndefined();
    });
  });

  // =========================================================================
  // parseCronField (exercised through computeNextRunAtMs)
  // =========================================================================

  describe('cron parser — field patterns', () => {
    it('should handle wildcard (*)', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '* * * * *' };
      const after = new Date('2030-06-15T00:00:00Z').getTime();
      // Every minute should match, so next should be 1 min later
      const next = scheduler.computeNextRunAtMs(schedule, after);
      expect(next).toBe(after + 60_000);
    });

    it('should handle specific values (30 12 * * *)', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '30 12 * * *' };
      const after = new Date('2030-06-15T11:00:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      expect(d.getUTCHours()).toBe(12);
      expect(d.getUTCMinutes()).toBe(30);
    });

    it('should handle ranges (0 9-17 * * *)', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 9-17 * * *' };
      // Starting at 18:30, next should be 9:00 the next day
      const after = new Date('2030-06-15T18:30:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      expect(d.getUTCHours()).toBe(9);
      expect(d.getUTCMinutes()).toBe(0);
      expect(d.getUTCDate()).toBe(16); // next day
    });

    it('should handle step values (*/15 * * * *)', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '*/15 * * * *' };
      const after = new Date('2030-06-15T12:01:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      // Minutes should be one of 0, 15, 30, 45
      expect([0, 15, 30, 45]).toContain(d.getUTCMinutes());
    });

    it('should handle lists (0 8,12,18 * * *)', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 8,12,18 * * *' };
      const after = new Date('2030-06-15T09:00:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      expect(d.getUTCHours()).toBe(12);
      expect(d.getUTCMinutes()).toBe(0);
    });

    it('should handle range with step (1-30/10 * * * *)', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '1-30/10 * * * *' };
      const after = new Date('2030-06-15T12:00:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      // Minutes should be 1, 11, or 21 (1-30 step 10)
      expect([1, 11, 21]).toContain(d.getUTCMinutes());
    });

    it('should handle day-of-week (0 10 * * 0,6) — weekends only', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 10 * * 0,6' };
      // 2030-06-17 is a Monday
      const after = new Date('2030-06-17T11:00:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      // Should be Saturday (6) or Sunday (0)
      expect([0, 6]).toContain(d.getUTCDay());
    });
  });

  // =========================================================================
  // start / stop lifecycle
  // =========================================================================

  describe('start / stop', () => {
    it('should set running to true after start()', () => {
      expect(scheduler.running).toBe(false);
      scheduler.start();
      expect(scheduler.running).toBe(true);
    });

    it('should set running to false after stop()', () => {
      scheduler.start();
      scheduler.stop();
      expect(scheduler.running).toBe(false);
    });

    it('should be idempotent — calling start() twice does not fail', () => {
      scheduler.start();
      scheduler.start(); // should not throw or create duplicate intervals
      expect(scheduler.running).toBe(true);
    });

    it('should be idempotent — calling stop() when not running does not fail', () => {
      scheduler.stop(); // should not throw
      expect(scheduler.running).toBe(false);
    });

    it('should fire handler when a job is due on tick', async () => {
      const handler = vi.fn();
      scheduler.onJobDue(handler);

      // Add a job that is due immediately (schedule: 1ms in the future-ish)
      scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 1_000 },
          enabled: true,
        }),
      );

      scheduler.start();

      // Advance time past the first due time
      await vi.advanceTimersByTimeAsync(2_000);

      expect(handler).toHaveBeenCalled();
      const calledJob: CronJob = handler.mock.calls[0][0];
      expect(calledJob.name).toBe('Test Job');
    });

    it('should not fire handler for disabled jobs', async () => {
      const handler = vi.fn();
      scheduler.onJobDue(handler);

      scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 500 },
          enabled: false,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should disable one-shot "at" jobs after execution', async () => {
      const handler = vi.fn();
      scheduler.onJobDue(handler);

      const futureMs = Date.now() + 500;
      const job = scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'at', at: new Date(futureMs).toISOString() },
          enabled: true,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(handler).toHaveBeenCalledTimes(1);

      const after = scheduler.getJob(job.id)!;
      expect(after.enabled).toBe(false);
      expect(after.state.nextRunAtMs).toBeUndefined();
    });
  });

  // =========================================================================
  // onJobDue handler registration
  // =========================================================================

  describe('onJobDue', () => {
    it('should allow registering multiple handlers', async () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();
      scheduler.onJobDue(handlerA);
      scheduler.onJobDue(handlerB);

      scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 500 },
          enabled: true,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(handlerA).toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalled();
    });

    it('should return an unsubscribe function', async () => {
      const handler = vi.fn();
      const unsub = scheduler.onJobDue(handler);

      scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 500 },
          enabled: true,
        }),
      );

      // Unsubscribe before starting
      unsub();

      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should record lastStatus as "error" when handler throws', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('boom'));
      scheduler.onJobDue(handler);

      const job = scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 500 },
          enabled: true,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_000);

      const afterJob = scheduler.getJob(job.id)!;
      expect(afterJob.state.lastStatus).toBe('error');
      expect(afterJob.state.lastError).toBe('boom');
    });

    it('should increment runCount after execution', async () => {
      const handler = vi.fn();
      scheduler.onJobDue(handler);

      const job = scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 500 },
          enabled: true,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_000);

      const afterJob = scheduler.getJob(job.id)!;
      expect(afterJob.state.runCount).toBeGreaterThan(0);
    });
  });
});
