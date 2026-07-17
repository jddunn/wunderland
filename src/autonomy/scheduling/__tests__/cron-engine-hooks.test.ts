import { describe, it, expect, vi } from 'vitest';
import { CronScheduler } from '../CronScheduler.js';
import type { CronJob, CreateCronJobInput } from '../types.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function everyInput(over: Partial<CreateCronJobInput> = {}): CreateCronJobInput {
  return {
    name: 'job',
    enabled: true,
    schedule: { kind: 'every', everyMs: 60_000 },
    payload: { kind: 'stimulus', stimulusType: 'ping', data: {} },
    ...over,
  } as CreateCronJobInput;
}

describe('CronScheduler engine hooks (W1.0a)', () => {
  it('runJobNow executes handlers AND advances state (runCount/lastRun/nextRun)', async () => {
    const scheduler = new CronScheduler();
    const seen: string[] = [];
    scheduler.onJobDue((j) => { seen.push(j.id); });
    const job = scheduler.addJob(everyInput());

    const before = scheduler.getJob(job.id)!;
    expect(before.state.runCount).toBe(0);

    await scheduler.runJobNow(job.id);

    const after = scheduler.getJob(job.id)!;
    expect(seen).toEqual([job.id]);
    expect(after.state.runCount).toBe(1);
    expect(after.state.lastRunAtMs).toBeTypeOf('number');
    expect(after.state.nextRunAtMs).toBeTypeOf('number');
  });

  it('runJobNow on a one-shot "at" job disables it after running', async () => {
    const scheduler = new CronScheduler();
    const job = scheduler.addJob(everyInput({ schedule: { kind: 'at', at: new Date(Date.now() + 1000).toISOString() } }));
    await scheduler.runJobNow(job.id);
    const after = scheduler.getJob(job.id)!;
    expect(after.enabled).toBe(false);
    expect(after.state.nextRunAtMs).toBeUndefined();
    expect(after.state.runCount).toBe(1);
  });

  it('onJobSettled fires AFTER state advances, carrying the updated job', async () => {
    const scheduler = new CronScheduler();
    const settled: Array<{ id: string; runCount: number }> = [];
    scheduler.onJobSettled((j: CronJob) => {
      settled.push({ id: j.id, runCount: j.state.runCount });
    });
    const job = scheduler.addJob(everyInput());
    await scheduler.runJobNow(job.id);
    // settlement sees runCount already incremented (post-state-advance)
    expect(settled).toEqual([{ id: job.id, runCount: 1 }]);
  });

  it('restoreJob reinstates a persisted job preserving id/state/timestamps', () => {
    const scheduler = new CronScheduler();
    const persisted: CronJob = {
      id: 'fixed-id',
      name: 'restored',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'stimulus', stimulusType: 'ping', data: {} },
      state: { runCount: 7, lastRunAtMs: 111, nextRunAtMs: 222 },
      createdAt: 100,
      updatedAt: 200,
    };
    scheduler.restoreJob(persisted);
    const got = scheduler.getJob('fixed-id')!;
    expect(got.id).toBe('fixed-id');
    expect(got.state.runCount).toBe(7);
    expect(got.createdAt).toBe(100);
  });

  it('restoreJob rejects a duplicate id', () => {
    const scheduler = new CronScheduler();
    const job = scheduler.addJob(everyInput());
    const dup: CronJob = { ...scheduler.getJob(job.id)! };
    expect(() => scheduler.restoreJob(dup)).toThrow(/exists|duplicate/i);
  });

  it('a slow tick does not overlap the next (re-entrancy guard)', async () => {
    const scheduler = new CronScheduler({ tickMs: 10 });
    let active = 0;
    let maxConcurrent = 0;
    scheduler.onJobDue(async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await tick(35);
      active -= 1;
    });
    // Due-now job so every tick would fire it.
    scheduler.addJob(everyInput({ schedule: { kind: 'every', everyMs: 1 } }));
    scheduler.start();
    await tick(80); // several tick intervals elapse while a handler is mid-flight
    scheduler.stop();
    expect(maxConcurrent).toBe(1);
  });
});
