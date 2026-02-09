/**
 * @fileoverview Cron Scheduler -- evaluates schedules, triggers job execution.
 *
 * Uses a built-in cron expression parser for standard 5-field cron expressions.
 * Supports three schedule kinds:
 * - 'at': one-shot at absolute time
 * - 'every': interval-based with optional anchor
 * - 'cron': standard cron expressions with optional timezone
 *
 * Modeled after OpenClaw's cron architecture.
 */

import { randomUUID } from 'node:crypto';
import type {
  CronJob,
  CronJobHandler,
  CronJobState,
  CronSchedule,
  CreateCronJobInput,
  UpdateCronJobInput,
} from './types.js';

// ---------------------------------------------------------------------------
// Minimal 5-field cron expression parser
// Fields: minute hour day-of-month month day-of-week
// Supports: *, number, ranges (1-5), steps (*/5, 1-10/2), lists (1,3,5)
// ---------------------------------------------------------------------------

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;   // 1-12
  daysOfWeek: Set<number>; // 0-6 (0=Sunday)
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  const parts = field.split(',');

  for (const part of parts) {
    // Handle step values: */5, 1-10/2
    const [rangeStr, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr, 10) : 1;

    if (rangeStr === '*') {
      for (let i = min; i <= max; i += step) {
        values.add(i);
      }
    } else if (rangeStr!.includes('-')) {
      const [startStr, endStr] = rangeStr!.split('-');
      const start = parseInt(startStr!, 10);
      const end = parseInt(endStr!, 10);
      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
    } else {
      values.add(parseInt(rangeStr!, 10));
    }
  }

  return values;
}

function parseCronExpression(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${expr}": expected 5 fields, got ${parts.length}`);
  }

  return {
    minutes: parseField(parts[0]!, 0, 59),
    hours: parseField(parts[1]!, 0, 23),
    daysOfMonth: parseField(parts[2]!, 1, 31),
    months: parseField(parts[3]!, 1, 12),
    daysOfWeek: parseField(parts[4]!, 0, 6),
  };
}

/**
 * Given a parsed cron expression, find the next matching time after `afterMs`.
 * Searches up to 366 days into the future before giving up.
 */
function nextCronMatch(fields: CronFields, afterMs: number, tz?: string): number | undefined {
  // Start from the minute after `afterMs`
  const start = new Date(afterMs);
  // Advance to the next whole minute
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const maxIterations = 366 * 24 * 60; // scan up to ~1 year of minutes
  const candidate = new Date(start);

  for (let i = 0; i < maxIterations; i++) {
    // If timezone is specified, convert to that timezone for matching.
    // For simplicity, we match in UTC or local depending on tz presence.
    let matchDate: { month: number; dayOfMonth: number; dayOfWeek: number; hour: number; minute: number };

    if (tz) {
      // Use Intl to get the time components in the target timezone
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
        }).formatToParts(candidate);

        const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
        matchDate = {
          month: get('month'),
          dayOfMonth: get('day'),
          dayOfWeek: new Date(
            `${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}T00:00:00`
          ).getDay(),
          hour: get('hour'),
          minute: get('minute'),
        };
      } catch {
        // Invalid timezone -- fall back to UTC
        matchDate = {
          month: candidate.getUTCMonth() + 1,
          dayOfMonth: candidate.getUTCDate(),
          dayOfWeek: candidate.getUTCDay(),
          hour: candidate.getUTCHours(),
          minute: candidate.getUTCMinutes(),
        };
      }
    } else {
      // Match in UTC
      matchDate = {
        month: candidate.getUTCMonth() + 1,
        dayOfMonth: candidate.getUTCDate(),
        dayOfWeek: candidate.getUTCDay(),
        hour: candidate.getUTCHours(),
        minute: candidate.getUTCMinutes(),
      };
    }

    if (
      fields.months.has(matchDate.month) &&
      fields.daysOfMonth.has(matchDate.dayOfMonth) &&
      fields.daysOfWeek.has(matchDate.dayOfWeek) &&
      fields.hours.has(matchDate.hour) &&
      fields.minutes.has(matchDate.minute)
    ) {
      return candidate.getTime();
    }

    // Advance by one minute
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  // No match found within the search window
  return undefined;
}

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

export interface CronSchedulerOptions {
  /** Tick interval in milliseconds. Default: 10_000 (10s). */
  tickMs?: number;
}

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private handlers: CronJobHandler[] = [];
  private readonly tickMs: number;

  constructor(options?: CronSchedulerOptions) {
    this.tickMs = options?.tickMs ?? 10_000;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Start the scheduler tick loop. */
  start(): void {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => void this.tick(), this.tickMs);
    // Immediate first tick
    void this.tick();
  }

  /** Stop the scheduler tick loop. */
  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  /** Whether the scheduler is currently running. */
  get running(): boolean {
    return this.tickInterval !== null;
  }

  // ---------------------------------------------------------------------------
  // Handler registration
  // ---------------------------------------------------------------------------

  /**
   * Register a handler that is invoked when any job is due.
   * Returns an unsubscribe function.
   */
  onJobDue(handler: CronJobHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  // ---------------------------------------------------------------------------
  // CRUD operations
  // ---------------------------------------------------------------------------

  /** Create a new cron job and compute its first run time. */
  addJob(input: CreateCronJobInput): CronJob {
    const now = Date.now();
    const state: CronJobState = {
      runCount: 0,
    };

    const job: CronJob = {
      id: randomUUID(),
      ...input,
      state,
      createdAt: now,
      updatedAt: now,
    };

    // Compute initial next run
    if (job.enabled) {
      job.state.nextRunAtMs = this.computeNextRunAtMs(job.schedule, now);
    }

    this.jobs.set(job.id, job);
    return structuredClone(job);
  }

  /** Update an existing cron job. Returns the updated job, or undefined if not found. */
  updateJob(jobId: string, updates: UpdateCronJobInput): CronJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;

    const now = Date.now();

    if (updates.name !== undefined) job.name = updates.name;
    if (updates.description !== undefined) job.description = updates.description;
    if (updates.payload !== undefined) job.payload = updates.payload;

    if (updates.schedule !== undefined) {
      job.schedule = updates.schedule;
      // Recompute next run when schedule changes
      job.state.nextRunAtMs = job.enabled
        ? this.computeNextRunAtMs(job.schedule, now)
        : undefined;
    }

    if (updates.enabled !== undefined) {
      job.enabled = updates.enabled;
      if (job.enabled) {
        // Recompute next run when re-enabled
        job.state.nextRunAtMs = this.computeNextRunAtMs(job.schedule, now);
      } else {
        job.state.nextRunAtMs = undefined;
      }
    }

    job.updatedAt = now;
    return structuredClone(job);
  }

  /** Remove a cron job. Returns true if the job existed. */
  removeJob(jobId: string): boolean {
    return this.jobs.delete(jobId);
  }

  /** Get a single job by ID. */
  getJob(jobId: string): CronJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  /** List jobs with optional filters. */
  listJobs(filter?: { seedId?: string; enabled?: boolean }): CronJob[] {
    let result = Array.from(this.jobs.values());

    if (filter?.seedId !== undefined) {
      result = result.filter(j => j.seedId === filter.seedId);
    }
    if (filter?.enabled !== undefined) {
      result = result.filter(j => j.enabled === filter.enabled);
    }

    return result.map(j => structuredClone(j));
  }

  /** Pause a job (set enabled = false and clear nextRunAtMs). */
  pauseJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.enabled = false;
    job.state.nextRunAtMs = undefined;
    job.updatedAt = Date.now();
  }

  /** Resume a paused job (set enabled = true and recompute nextRunAtMs). */
  resumeJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const now = Date.now();
    job.enabled = true;
    job.state.nextRunAtMs = this.computeNextRunAtMs(job.schedule, now);
    job.updatedAt = now;
  }

  // ---------------------------------------------------------------------------
  // Core tick
  // ---------------------------------------------------------------------------

  /** Check all jobs and fire due ones. */
  private async tick(): Promise<void> {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (!job.enabled) continue;
      if (job.state.nextRunAtMs !== undefined && now >= job.state.nextRunAtMs) {
        await this.executeJob(job, now);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Job execution
  // ---------------------------------------------------------------------------

  /** Execute a single job: call all handlers, update state, compute next run. */
  private async executeJob(job: CronJob, now: number): Promise<void> {
    // Snapshot the run time before handlers execute
    const runAtMs = now;

    let status: 'ok' | 'error' = 'ok';
    let lastError: string | undefined;

    // Call all registered handlers
    for (const handler of this.handlers) {
      try {
        await handler(structuredClone(job));
      } catch (err: unknown) {
        status = 'error';
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    // Update state
    job.state.lastRunAtMs = runAtMs;
    job.state.lastStatus = status;
    job.state.lastError = lastError;
    job.state.runCount += 1;

    // For 'at' schedules, disable after execution (one-shot)
    if (job.schedule.kind === 'at') {
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
    } else {
      // Compute next run time
      job.state.nextRunAtMs = this.computeNextRunAtMs(job.schedule, runAtMs);
    }

    job.updatedAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Schedule computation
  // ---------------------------------------------------------------------------

  /**
   * Compute the next run time (in epoch ms) for a given schedule.
   *
   * @param schedule - The schedule definition.
   * @param afterMs  - The epoch ms to compute "next" from. Defaults to Date.now().
   * @returns The next run time in epoch ms, or undefined if the schedule has no future occurrence.
   */
  computeNextRunAtMs(schedule: CronSchedule, afterMs?: number): number | undefined {
    const after = afterMs ?? Date.now();

    switch (schedule.kind) {
      case 'at': {
        const targetMs = new Date(schedule.at).getTime();
        if (Number.isNaN(targetMs)) return undefined;
        return targetMs > after ? targetMs : undefined;
      }

      case 'every': {
        const { everyMs, anchorMs } = schedule;
        if (everyMs <= 0) return undefined;

        // If there's an anchor, align to it; otherwise, next tick is simply after + interval
        if (anchorMs !== undefined) {
          if (after < anchorMs) {
            // Haven't reached anchor yet -- first run at anchor
            return anchorMs;
          }
          // Number of complete intervals since anchor
          const elapsed = after - anchorMs;
          const intervals = Math.floor(elapsed / everyMs) + 1;
          return anchorMs + intervals * everyMs;
        }

        // No anchor -- next run is after + everyMs
        return after + everyMs;
      }

      case 'cron': {
        try {
          const fields = parseCronExpression(schedule.expr);
          return nextCronMatch(fields, after, schedule.tz);
        } catch {
          return undefined;
        }
      }

      default:
        return undefined;
    }
  }
}
