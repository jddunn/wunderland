/**
 * @file CronScheduler.test.ts
 * @description Comprehensive unit tests for the CronScheduler class.
 *
 * Covers: constructor defaults, CRUD (addJob/getJob/removeJob/updateJob/listJobs),
 * pauseJob/resumeJob, computeNextRunAtMs for all three schedule kinds,
 * lifecycle start/stop, onJobDue handler registration and unsubscription,
 * one-shot 'at' job auto-disable, handler error isolation, and the built-in
 * cron expression parser (wildcards, ranges, steps, lists, day-of-week).
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

/** Reusable stimulus payload for tests that don't care about payload specifics. */
const stubPayload: CronPayload = {
  kind: 'stimulus',
  stimulusType: 'test',
  data: { foo: 'bar' },
};

/** Build a CreateCronJobInput with sensible defaults and optional overrides. */
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
  // 1. Constructor defaults
  // =========================================================================

  describe('constructor defaults', () => {
    it('should default tickMs to 10_000 when no options provided', () => {
      // We cannot directly read the private tickMs, but we can verify
      // the scheduler creates an interval with the expected tick rate by
      // observing when the tick fires.
      const defaultScheduler = new CronScheduler();
      const handler = vi.fn();
      defaultScheduler.onJobDue(handler);

      defaultScheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 1 }, // due immediately after first tick
          enabled: true,
        }),
      );

      defaultScheduler.start();

      // At 9_999ms the second tick (10s interval) has not fired yet.
      // But the immediate first tick in start() already fires, so handler
      // is called once from that immediate tick once the job is due.
      // The job's nextRunAtMs is Date.now() + 1ms (from 'every' with everyMs:1),
      // so the immediate tick at time 0 will not fire it (nextRunAtMs = 1).
      // Advance 1ms so the job is due, then 10_000ms for the next tick.
      vi.advanceTimersByTime(10_000);

      // After 10s the second tick should fire and the handler should be called
      expect(handler).toHaveBeenCalled();

      defaultScheduler.stop();
    });

    it('should accept a custom tickMs', () => {
      const customScheduler = new CronScheduler({ tickMs: 500 });
      const handler = vi.fn();
      customScheduler.onJobDue(handler);

      customScheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 1 },
          enabled: true,
        }),
      );

      customScheduler.start();
      // The immediate tick at t=0: job's nextRunAtMs is 1, and now is 0, so not due.
      // After 500ms the interval tick fires, and now >= 1, so handler fires.
      vi.advanceTimersByTime(500);

      expect(handler).toHaveBeenCalled();

      customScheduler.stop();
    });

    it('should start with no jobs', () => {
      expect(scheduler.listJobs()).toHaveLength(0);
    });

    it('should start in non-running state', () => {
      expect(scheduler.running).toBe(false);
    });
  });

  // =========================================================================
  // 2. addJob creates job with UUID and computed nextRunAtMs
  // =========================================================================

  describe('addJob', () => {
    it('should return a job with a UUID-format id', () => {
      const job = scheduler.addJob(makeJobInput());
      // UUID v4 format: 8-4-4-4-12 hex digits
      expect(job.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('should generate unique IDs for each job', () => {
      const job1 = scheduler.addJob(makeJobInput());
      const job2 = scheduler.addJob(makeJobInput());
      expect(job1.id).not.toBe(job2.id);
    });

    it('should copy name, seedId, description, enabled, schedule, and payload from input', () => {
      const input = makeJobInput({
        name: 'My Job',
        seedId: 'seed-42',
        description: 'Does stuff',
        enabled: true,
        schedule: { kind: 'every', everyMs: 5_000 },
      });

      const job = scheduler.addJob(input);

      expect(job.name).toBe('My Job');
      expect(job.seedId).toBe('seed-42');
      expect(job.description).toBe('Does stuff');
      expect(job.enabled).toBe(true);
      expect(job.schedule).toEqual({ kind: 'every', everyMs: 5_000 });
      expect(job.payload).toEqual(stubPayload);
    });

    it('should initialise state with runCount 0 and no lastRunAtMs', () => {
      const job = scheduler.addJob(makeJobInput());
      expect(job.state.runCount).toBe(0);
      expect(job.state.lastRunAtMs).toBeUndefined();
      expect(job.state.lastStatus).toBeUndefined();
      expect(job.state.lastError).toBeUndefined();
    });

    it('should compute nextRunAtMs for an enabled job', () => {
      const job = scheduler.addJob(makeJobInput({ enabled: true }));
      expect(job.state.nextRunAtMs).toBeDefined();
      expect(typeof job.state.nextRunAtMs).toBe('number');
    });

    it('should NOT compute nextRunAtMs for a disabled job', () => {
      const job = scheduler.addJob(makeJobInput({ enabled: false }));
      expect(job.state.nextRunAtMs).toBeUndefined();
    });

    it('should set createdAt and updatedAt to the current time', () => {
      const now = Date.now();
      const job = scheduler.addJob(makeJobInput());
      expect(job.createdAt).toBe(now);
      expect(job.updatedAt).toBe(now);
    });

    it('should compute correct nextRunAtMs for an "every" schedule', () => {
      const now = Date.now();
      const job = scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 30_000 },
          enabled: true,
        }),
      );
      expect(job.state.nextRunAtMs).toBe(now + 30_000);
    });

    it('should compute nextRunAtMs for an "at" schedule in the future', () => {
      const futureDate = new Date(Date.now() + 3_600_000).toISOString();
      const job = scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'at', at: futureDate },
          enabled: true,
        }),
      );
      expect(job.state.nextRunAtMs).toBe(new Date(futureDate).getTime());
    });

    it('should set nextRunAtMs to undefined for an "at" schedule in the past', () => {
      const pastDate = new Date(Date.now() - 3_600_000).toISOString();
      const job = scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'at', at: pastDate },
          enabled: true,
        }),
      );
      expect(job.state.nextRunAtMs).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. getJob returns clone (not original)
  // =========================================================================

  describe('getJob returns a clone', () => {
    it('should return a deep copy, not the internal reference', () => {
      const job = scheduler.addJob(makeJobInput());
      const fetched = scheduler.getJob(job.id)!;

      // Mutate the returned object
      fetched.name = 'MUTATED';
      fetched.state.runCount = 999;

      // The internal state should be unaffected
      const fetchedAgain = scheduler.getJob(job.id)!;
      expect(fetchedAgain.name).toBe('Test Job');
      expect(fetchedAgain.state.runCount).toBe(0);
    });

    it('should return undefined for a non-existent job', () => {
      expect(scheduler.getJob('does-not-exist')).toBeUndefined();
    });

    it('should return distinct object references on subsequent calls', () => {
      const job = scheduler.addJob(makeJobInput());
      const a = scheduler.getJob(job.id);
      const b = scheduler.getJob(job.id);
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  // =========================================================================
  // 4. removeJob returns true/false
  // =========================================================================

  describe('removeJob', () => {
    it('should return true when removing an existing job', () => {
      const job = scheduler.addJob(makeJobInput());
      expect(scheduler.removeJob(job.id)).toBe(true);
    });

    it('should make the job inaccessible via getJob after removal', () => {
      const job = scheduler.addJob(makeJobInput());
      scheduler.removeJob(job.id);
      expect(scheduler.getJob(job.id)).toBeUndefined();
    });

    it('should return false when the job does not exist', () => {
      expect(scheduler.removeJob('nonexistent-id')).toBe(false);
    });

    it('should return false on a second removal of the same job', () => {
      const job = scheduler.addJob(makeJobInput());
      expect(scheduler.removeJob(job.id)).toBe(true);
      expect(scheduler.removeJob(job.id)).toBe(false);
    });

    it('should reduce the listJobs count', () => {
      const job1 = scheduler.addJob(makeJobInput({ name: 'A' }));
      scheduler.addJob(makeJobInput({ name: 'B' }));
      expect(scheduler.listJobs()).toHaveLength(2);

      scheduler.removeJob(job1.id);
      expect(scheduler.listJobs()).toHaveLength(1);
    });
  });

  // =========================================================================
  // 5. listJobs with no filter, seedId filter, enabled filter
  // =========================================================================

  describe('listJobs', () => {
    it('should return all jobs when called with no filter', () => {
      scheduler.addJob(makeJobInput({ name: 'A' }));
      scheduler.addJob(makeJobInput({ name: 'B' }));
      scheduler.addJob(makeJobInput({ name: 'C' }));

      const jobs = scheduler.listJobs();
      expect(jobs).toHaveLength(3);
    });

    it('should return an empty array when no jobs exist', () => {
      expect(scheduler.listJobs()).toEqual([]);
    });

    it('should filter by seedId', () => {
      scheduler.addJob(makeJobInput({ name: 'A', seedId: 'seed-1' }));
      scheduler.addJob(makeJobInput({ name: 'B', seedId: 'seed-2' }));
      scheduler.addJob(makeJobInput({ name: 'C', seedId: 'seed-1' }));

      const filtered = scheduler.listJobs({ seedId: 'seed-1' });
      expect(filtered).toHaveLength(2);
      expect(filtered.every((j) => j.seedId === 'seed-1')).toBe(true);
    });

    it('should return empty when no jobs match seedId', () => {
      scheduler.addJob(makeJobInput({ seedId: 'seed-1' }));
      expect(scheduler.listJobs({ seedId: 'seed-99' })).toHaveLength(0);
    });

    it('should filter by enabled: true', () => {
      scheduler.addJob(makeJobInput({ name: 'Enabled', enabled: true }));
      scheduler.addJob(makeJobInput({ name: 'Disabled', enabled: false }));

      const result = scheduler.listJobs({ enabled: true });
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('Enabled');
    });

    it('should filter by enabled: false', () => {
      scheduler.addJob(makeJobInput({ name: 'Enabled', enabled: true }));
      scheduler.addJob(makeJobInput({ name: 'Disabled', enabled: false }));

      const result = scheduler.listJobs({ enabled: false });
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('Disabled');
    });

    it('should combine seedId and enabled filters', () => {
      scheduler.addJob(makeJobInput({ seedId: 'x', enabled: true }));
      scheduler.addJob(makeJobInput({ seedId: 'x', enabled: false }));
      scheduler.addJob(makeJobInput({ seedId: 'y', enabled: true }));

      const result = scheduler.listJobs({ seedId: 'x', enabled: true });
      expect(result).toHaveLength(1);
    });

    it('should return clones, not internal references', () => {
      scheduler.addJob(makeJobInput({ name: 'Original' }));

      const list = scheduler.listJobs();
      list[0]!.name = 'MUTATED';

      const listAgain = scheduler.listJobs();
      expect(listAgain[0]!.name).toBe('Original');
    });
  });

  // =========================================================================
  // 6. updateJob updates fields and recomputes schedule
  // =========================================================================

  describe('updateJob', () => {
    it('should update the name', () => {
      const job = scheduler.addJob(makeJobInput());
      const updated = scheduler.updateJob(job.id, { name: 'New Name' });
      expect(updated!.name).toBe('New Name');
    });

    it('should update the description', () => {
      const job = scheduler.addJob(makeJobInput());
      const updated = scheduler.updateJob(job.id, { description: 'A new description' });
      expect(updated!.description).toBe('A new description');
    });

    it('should update the payload', () => {
      const job = scheduler.addJob(makeJobInput());
      const newPayload: CronPayload = {
        kind: 'webhook',
        url: 'https://example.com',
        method: 'POST',
      };
      const updated = scheduler.updateJob(job.id, { payload: newPayload });
      expect(updated!.payload).toEqual(newPayload);
    });

    it('should update the schedule and recompute nextRunAtMs', () => {
      const now = Date.now();
      const job = scheduler.addJob(makeJobInput({
        schedule: { kind: 'every', everyMs: 60_000 },
        enabled: true,
      }));
      expect(job.state.nextRunAtMs).toBe(now + 60_000);

      const updated = scheduler.updateJob(job.id, {
        schedule: { kind: 'every', everyMs: 120_000 },
      });
      expect(updated!.schedule).toEqual({ kind: 'every', everyMs: 120_000 });
      expect(updated!.state.nextRunAtMs).toBe(now + 120_000);
    });

    it('should clear nextRunAtMs when schedule updated and job is disabled', () => {
      const job = scheduler.addJob(makeJobInput({ enabled: false }));

      const updated = scheduler.updateJob(job.id, {
        schedule: { kind: 'every', everyMs: 5_000 },
      });
      expect(updated!.state.nextRunAtMs).toBeUndefined();
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

    it('should bump updatedAt', () => {
      const job = scheduler.addJob(makeJobInput());
      const original = job.updatedAt;

      vi.advanceTimersByTime(5_000);
      const updated = scheduler.updateJob(job.id, { name: 'Later' });
      expect(updated!.updatedAt).toBeGreaterThan(original);
    });

    it('should return a clone (not the internal reference)', () => {
      const job = scheduler.addJob(makeJobInput());
      const updated = scheduler.updateJob(job.id, { name: 'Updated' })!;
      updated.name = 'MUTATED';

      const fetched = scheduler.getJob(job.id)!;
      expect(fetched.name).toBe('Updated');
    });
  });

  // =========================================================================
  // 7. updateJob returns undefined for non-existent job
  // =========================================================================

  describe('updateJob — non-existent job', () => {
    it('should return undefined for a non-existent job ID', () => {
      expect(scheduler.updateJob('ghost-id', { name: 'x' })).toBeUndefined();
    });

    it('should return undefined after a job has been removed', () => {
      const job = scheduler.addJob(makeJobInput());
      scheduler.removeJob(job.id);
      expect(scheduler.updateJob(job.id, { name: 'x' })).toBeUndefined();
    });
  });

  // =========================================================================
  // 8. pauseJob / resumeJob
  // =========================================================================

  describe('pauseJob / resumeJob', () => {
    it('should pause a job: set enabled to false and clear nextRunAtMs', () => {
      const job = scheduler.addJob(makeJobInput({ enabled: true }));
      expect(job.state.nextRunAtMs).toBeDefined();

      scheduler.pauseJob(job.id);
      const paused = scheduler.getJob(job.id)!;

      expect(paused.enabled).toBe(false);
      expect(paused.state.nextRunAtMs).toBeUndefined();
    });

    it('should resume a paused job: set enabled to true and compute nextRunAtMs', () => {
      const job = scheduler.addJob(makeJobInput({ enabled: false }));
      expect(job.state.nextRunAtMs).toBeUndefined();

      scheduler.resumeJob(job.id);
      const resumed = scheduler.getJob(job.id)!;

      expect(resumed.enabled).toBe(true);
      expect(resumed.state.nextRunAtMs).toBeDefined();
    });

    it('should be a no-op for non-existent job IDs (no throw)', () => {
      expect(() => scheduler.pauseJob('ghost')).not.toThrow();
      expect(() => scheduler.resumeJob('ghost')).not.toThrow();
    });

    it('should update updatedAt on pause', () => {
      const job = scheduler.addJob(makeJobInput());
      const t0 = job.updatedAt;

      vi.advanceTimersByTime(1_000);
      scheduler.pauseJob(job.id);

      const paused = scheduler.getJob(job.id)!;
      expect(paused.updatedAt).toBeGreaterThan(t0);
    });

    it('should update updatedAt on resume', () => {
      const job = scheduler.addJob(makeJobInput({ enabled: false }));
      const t0 = job.updatedAt;

      vi.advanceTimersByTime(1_000);
      scheduler.resumeJob(job.id);

      const resumed = scheduler.getJob(job.id)!;
      expect(resumed.updatedAt).toBeGreaterThan(t0);
    });

    it('should recompute nextRunAtMs from the current time on resume', () => {
      const job = scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 60_000 },
          enabled: true,
        }),
      );

      scheduler.pauseJob(job.id);

      vi.advanceTimersByTime(30_000);
      const resumeTime = Date.now();

      scheduler.resumeJob(job.id);
      const resumed = scheduler.getJob(job.id)!;

      // nextRunAtMs should be relative to the resume time, not the original addJob time
      expect(resumed.state.nextRunAtMs).toBe(resumeTime + 60_000);
    });
  });

  // =========================================================================
  // 9. computeNextRunAtMs — 'at' schedule
  // =========================================================================

  describe('computeNextRunAtMs — at schedule', () => {
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

    it('should return undefined when the target time equals afterMs exactly', () => {
      const now = Date.now();
      const schedule: CronSchedule = { kind: 'at', at: new Date(now).toISOString() };

      // targetMs is not > after, so should be undefined
      expect(scheduler.computeNextRunAtMs(schedule, now)).toBeUndefined();
    });

    it('should return undefined for an invalid date string', () => {
      const schedule: CronSchedule = { kind: 'at', at: 'not-a-date' };
      expect(scheduler.computeNextRunAtMs(schedule)).toBeUndefined();
    });

    it('should default afterMs to Date.now() when not provided', () => {
      const futureIso = '2099-12-31T23:59:59Z';
      const schedule: CronSchedule = { kind: 'at', at: futureIso };

      // Since we use fake timers, Date.now() returns the fake time
      const next = scheduler.computeNextRunAtMs(schedule);
      expect(next).toBe(new Date(futureIso).getTime());
    });
  });

  // =========================================================================
  // 10. computeNextRunAtMs — 'every' schedule
  // =========================================================================

  describe('computeNextRunAtMs — every schedule', () => {
    it('should return afterMs + everyMs when no anchor is set', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 60_000 };
      const after = 1_000_000;
      expect(scheduler.computeNextRunAtMs(schedule, after)).toBe(1_060_000);
    });

    it('should return anchorMs when afterMs is before the anchor', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 60_000, anchorMs: 2_000_000 };
      const after = 1_000_000;
      expect(scheduler.computeNextRunAtMs(schedule, after)).toBe(2_000_000);
    });

    it('should align to the anchor grid when afterMs is past the anchor', () => {
      // anchor=0, every=100, after=250 -> elapsed=250, intervals=floor(250/100)+1=3
      // next = 0 + 3*100 = 300
      const schedule: CronSchedule = { kind: 'every', everyMs: 100, anchorMs: 0 };
      expect(scheduler.computeNextRunAtMs(schedule, 250)).toBe(300);
    });

    it('should align to anchor grid exactly on boundary', () => {
      // anchor=0, every=100, after=200 -> elapsed=200, intervals=floor(200/100)+1=3
      // next = 0 + 3*100 = 300
      const schedule: CronSchedule = { kind: 'every', everyMs: 100, anchorMs: 0 };
      expect(scheduler.computeNextRunAtMs(schedule, 200)).toBe(300);
    });

    it('should handle anchor in the past with large interval', () => {
      // anchor=1000, every=500, after=2100
      // elapsed = 2100 - 1000 = 1100, intervals = floor(1100/500)+1 = 3
      // next = 1000 + 3*500 = 2500
      const schedule: CronSchedule = { kind: 'every', everyMs: 500, anchorMs: 1_000 };
      expect(scheduler.computeNextRunAtMs(schedule, 2_100)).toBe(2_500);
    });

    it('should return undefined when everyMs is 0', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 0 };
      expect(scheduler.computeNextRunAtMs(schedule, 1_000)).toBeUndefined();
    });

    it('should return undefined when everyMs is negative', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: -100 };
      expect(scheduler.computeNextRunAtMs(schedule, 1_000)).toBeUndefined();
    });

    it('should default afterMs to Date.now() when not provided', () => {
      const schedule: CronSchedule = { kind: 'every', everyMs: 5_000 };
      const now = Date.now();
      expect(scheduler.computeNextRunAtMs(schedule)).toBe(now + 5_000);
    });
  });

  // =========================================================================
  // 11. computeNextRunAtMs — 'cron' schedule
  // =========================================================================

  describe('computeNextRunAtMs — cron schedule', () => {
    it('should return the next minute for "* * * * *"', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '* * * * *' };
      const after = new Date('2030-06-15T12:00:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBe(new Date('2030-06-15T12:01:00Z').getTime());
    });

    it('should find Monday 9am for "0 9 * * 1"', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * 1' };
      // Jan 2, 2030 is a Wednesday
      const after = new Date('2030-01-02T10:00:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      expect(d.getUTCDay()).toBe(1); // Monday
      expect(d.getUTCHours()).toBe(9);
      expect(d.getUTCMinutes()).toBe(0);
    });

    it('should handle "*/5 * * * *" (every 5 minutes)', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '*/5 * * * *' };
      const after = new Date('2030-06-15T12:03:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      expect(d.getUTCMinutes() % 5).toBe(0);
      expect(next!).toBeGreaterThan(after);
    });

    it('should compute "0 0 1 1 *" (midnight Jan 1) crossing year boundary', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 0 1 1 *' };
      const after = new Date('2030-01-02T00:00:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      expect(d.getUTCFullYear()).toBe(2031);
      expect(d.getUTCMonth()).toBe(0);
      expect(d.getUTCDate()).toBe(1);
      expect(d.getUTCHours()).toBe(0);
      expect(d.getUTCMinutes()).toBe(0);
    });

    it('should handle specific time "30 12 * * *"', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '30 12 * * *' };
      const after = new Date('2030-06-15T11:00:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      expect(d.getUTCHours()).toBe(12);
      expect(d.getUTCMinutes()).toBe(30);
    });

    it('should handle ranges "0 9-17 * * *"', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 9-17 * * *' };
      // After 18:30 — next match should be 9:00 the following day
      const after = new Date('2030-06-15T18:30:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      expect(d.getUTCHours()).toBe(9);
      expect(d.getUTCDate()).toBe(16);
    });

    it('should handle step values "*/15 * * * *"', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '*/15 * * * *' };
      const after = new Date('2030-06-15T12:01:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      expect([0, 15, 30, 45]).toContain(d.getUTCMinutes());
    });

    it('should handle lists "0 8,12,18 * * *"', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 8,12,18 * * *' };
      const after = new Date('2030-06-15T09:00:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      expect(d.getUTCHours()).toBe(12);
    });

    it('should handle range with step "1-30/10 * * * *"', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '1-30/10 * * * *' };
      const after = new Date('2030-06-15T12:00:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      expect([1, 11, 21]).toContain(d.getUTCMinutes());
    });

    it('should handle day-of-week "0 10 * * 0,6" (weekends)', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 10 * * 0,6' };
      // 2030-06-17 is Monday
      const after = new Date('2030-06-17T11:00:00Z').getTime();
      const next = scheduler.computeNextRunAtMs(schedule, after);

      expect(next).toBeDefined();
      const d = new Date(next!);
      expect([0, 6]).toContain(d.getUTCDay());
    });

    it('should return undefined for an invalid cron expression', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: 'bad cron' };
      expect(scheduler.computeNextRunAtMs(schedule)).toBeUndefined();
    });

    it('should return undefined for a cron expression with wrong field count', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '* * *' };
      expect(scheduler.computeNextRunAtMs(schedule)).toBeUndefined();
    });

    it('should return undefined for 6-field cron (seconds field not supported)', () => {
      const schedule: CronSchedule = { kind: 'cron', expr: '0 * * * * *' };
      expect(scheduler.computeNextRunAtMs(schedule)).toBeUndefined();
    });
  });

  // =========================================================================
  // 12. onJobDue handler called when job is due
  // =========================================================================

  describe('onJobDue — handler invocation', () => {
    it('should call the handler when a job becomes due', async () => {
      const handler = vi.fn();
      scheduler.onJobDue(handler);

      scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 1_000 },
          enabled: true,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(handler).toHaveBeenCalled();
    });

    it('should pass a clone of the job to the handler', async () => {
      const handler = vi.fn();
      scheduler.onJobDue(handler);

      const job = scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 1_000 },
          enabled: true,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_000);

      const calledWith: CronJob = handler.mock.calls[0]![0];
      expect(calledWith.id).toBe(job.id);
      expect(calledWith.name).toBe('Test Job');

      // Mutating the passed clone should not affect internal state
      calledWith.name = 'TAMPERED';
      const internal = scheduler.getJob(job.id)!;
      expect(internal.name).toBe('Test Job');
    });

    it('should call multiple handlers for the same job', async () => {
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

    it('should not call the handler for disabled jobs', async () => {
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

    it('should update runCount after handler is called', async () => {
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

    it('should set lastStatus to "ok" when handler succeeds', async () => {
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
      expect(afterJob.state.lastStatus).toBe('ok');
      expect(afterJob.state.lastError).toBeUndefined();
    });

    it('should set lastStatus to "error" and record lastError when handler throws', async () => {
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

    it('should set lastRunAtMs after execution', async () => {
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
      expect(afterJob.state.lastRunAtMs).toBeDefined();
    });

    it('should recompute nextRunAtMs for recurring jobs after execution', async () => {
      const handler = vi.fn();
      scheduler.onJobDue(handler);

      const job = scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 5_000 },
          enabled: true,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(6_000);

      const afterJob = scheduler.getJob(job.id)!;
      // Should have a nextRunAtMs in the future
      expect(afterJob.state.nextRunAtMs).toBeDefined();
      expect(afterJob.state.nextRunAtMs!).toBeGreaterThan(afterJob.state.lastRunAtMs!);
    });
  });

  // =========================================================================
  // 13. onJobDue returns unsubscribe function
  // =========================================================================

  describe('onJobDue — unsubscribe', () => {
    it('should return a function', () => {
      const unsub = scheduler.onJobDue(vi.fn());
      expect(typeof unsub).toBe('function');
    });

    it('should prevent the handler from being called after unsubscribe', async () => {
      const handler = vi.fn();
      const unsub = scheduler.onJobDue(handler);

      scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 500 },
          enabled: true,
        }),
      );

      unsub();

      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not affect other registered handlers', async () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      const unsubA = scheduler.onJobDue(handlerA);
      scheduler.onJobDue(handlerB);

      scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 500 },
          enabled: true,
        }),
      );

      unsubA();

      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(handlerA).not.toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalled();
    });

    it('should be safe to call unsubscribe multiple times', () => {
      const handler = vi.fn();
      const unsub = scheduler.onJobDue(handler);

      unsub();
      expect(() => unsub()).not.toThrow();
    });
  });

  // =========================================================================
  // 14. start/stop lifecycle and running getter
  // =========================================================================

  describe('start / stop lifecycle', () => {
    it('should set running to true after start()', () => {
      expect(scheduler.running).toBe(false);
      scheduler.start();
      expect(scheduler.running).toBe(true);
    });

    it('should set running to false after stop()', () => {
      scheduler.start();
      expect(scheduler.running).toBe(true);

      scheduler.stop();
      expect(scheduler.running).toBe(false);
    });

    it('should be idempotent: start() called twice does not error', () => {
      scheduler.start();
      expect(() => scheduler.start()).not.toThrow();
      expect(scheduler.running).toBe(true);
    });

    it('should be idempotent: stop() called when not running does not error', () => {
      expect(() => scheduler.stop()).not.toThrow();
      expect(scheduler.running).toBe(false);
    });

    it('should perform an immediate first tick on start()', async () => {
      const handler = vi.fn();
      scheduler.onJobDue(handler);

      // Job that is already due: nextRunAtMs is in the past
      const now = Date.now();
      const pastIso = new Date(now + 1).toISOString(); // 1ms in the future
      scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'at', at: pastIso },
          enabled: true,
        }),
      );

      // Advance 1ms so the job is in the past relative to Date.now()
      vi.advanceTimersByTime(2);

      scheduler.start();
      // The immediate tick is `void this.tick()` — it's async, so we need a microtask flush
      await vi.advanceTimersByTimeAsync(0);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should not fire handlers after stop()', async () => {
      const handler = vi.fn();
      scheduler.onJobDue(handler);

      scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 500 },
          enabled: true,
        }),
      );

      scheduler.start();
      // Let the first tick execute
      await vi.advanceTimersByTimeAsync(1_000);

      const callCountBeforeStop = handler.mock.calls.length;
      scheduler.stop();

      // Advance a lot more time — no new ticks should fire
      await vi.advanceTimersByTimeAsync(10_000);
      expect(handler.mock.calls.length).toBe(callCountBeforeStop);
    });

    it('should support restart after stop', async () => {
      const handler = vi.fn();
      scheduler.onJobDue(handler);

      scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 500 },
          enabled: true,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      scheduler.stop();

      const countAfterFirstRun = handler.mock.calls.length;

      scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(handler.mock.calls.length).toBeGreaterThan(countAfterFirstRun);
    });
  });

  // =========================================================================
  // 15. One-shot 'at' job disables after execution
  // =========================================================================

  describe('one-shot "at" job auto-disable', () => {
    it('should disable the job after it fires', async () => {
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

      const afterJob = scheduler.getJob(job.id)!;
      expect(afterJob.enabled).toBe(false);
      expect(afterJob.state.nextRunAtMs).toBeUndefined();
    });

    it('should fire exactly once', async () => {
      const handler = vi.fn();
      scheduler.onJobDue(handler);

      const futureMs = Date.now() + 500;
      scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'at', at: new Date(futureMs).toISOString() },
          enabled: true,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(10_000);

      // Only one execution despite many ticks
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should set runCount to 1 after one-shot execution', async () => {
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

      const afterJob = scheduler.getJob(job.id)!;
      expect(afterJob.state.runCount).toBe(1);
    });

    it('should set lastStatus after one-shot execution', async () => {
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

      const afterJob = scheduler.getJob(job.id)!;
      expect(afterJob.state.lastStatus).toBe('ok');
    });

    it('should not prevent recurring jobs from continuing', async () => {
      const handler = vi.fn();
      scheduler.onJobDue(handler);

      // Add both an 'at' job and an 'every' job
      const futureMs = Date.now() + 500;
      scheduler.addJob(
        makeJobInput({
          name: 'One-shot',
          schedule: { kind: 'at', at: new Date(futureMs).toISOString() },
          enabled: true,
        }),
      );

      const recurring = scheduler.addJob(
        makeJobInput({
          name: 'Recurring',
          schedule: { kind: 'every', everyMs: 1_000 },
          enabled: true,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(5_000);

      // The recurring job should have been executed multiple times
      const recurringJob = scheduler.getJob(recurring.id)!;
      expect(recurringJob.enabled).toBe(true);
      expect(recurringJob.state.runCount).toBeGreaterThan(1);
    });
  });

  // =========================================================================
  // 16. Handler errors don't prevent other handlers from running
  // =========================================================================

  describe('handler error isolation', () => {
    it('should call the second handler even when the first throws', async () => {
      const failingHandler = vi.fn().mockRejectedValue(new Error('handler 1 fail'));
      const succeedingHandler = vi.fn();

      scheduler.onJobDue(failingHandler);
      scheduler.onJobDue(succeedingHandler);

      scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 500 },
          enabled: true,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(failingHandler).toHaveBeenCalled();
      expect(succeedingHandler).toHaveBeenCalled();
    });

    it('should call all three handlers when the middle one throws', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn().mockRejectedValue(new Error('middle fail'));
      const handler3 = vi.fn();

      scheduler.onJobDue(handler1);
      scheduler.onJobDue(handler2);
      scheduler.onJobDue(handler3);

      scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 500 },
          enabled: true,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
      expect(handler3).toHaveBeenCalled();
    });

    it('should record lastError from the failing handler', async () => {
      const failingHandler = vi.fn().mockRejectedValue(new Error('oops'));
      const okHandler = vi.fn();

      scheduler.onJobDue(failingHandler);
      scheduler.onJobDue(okHandler);

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
      expect(afterJob.state.lastError).toBe('oops');
    });

    it('should stringify non-Error thrown values', async () => {
      const handler = vi.fn().mockRejectedValue('string error');
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
      expect(afterJob.state.lastError).toBe('string error');
    });

    it('should still increment runCount even when handlers error', async () => {
      const failingHandler = vi.fn().mockRejectedValue(new Error('fail'));
      scheduler.onJobDue(failingHandler);

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

    it('should still recompute nextRunAtMs for recurring jobs even after error', async () => {
      const failingHandler = vi.fn().mockRejectedValue(new Error('fail'));
      scheduler.onJobDue(failingHandler);

      const job = scheduler.addJob(
        makeJobInput({
          schedule: { kind: 'every', everyMs: 5_000 },
          enabled: true,
        }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(6_000);

      const afterJob = scheduler.getJob(job.id)!;
      expect(afterJob.enabled).toBe(true);
      expect(afterJob.state.nextRunAtMs).toBeDefined();
    });
  });
});
