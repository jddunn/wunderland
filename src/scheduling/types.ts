/**
 * @fileoverview Types for the Wunderland Cron Scheduler.
 * Modeled after OpenClaw's cron architecture.
 */

/** Schedule definition -- when a job should run. */
export type CronSchedule =
  | { kind: 'at'; at: string }                            // Absolute ISO timestamp
  | { kind: 'every'; everyMs: number; anchorMs?: number } // Interval with optional anchor
  | { kind: 'cron'; expr: string; tz?: string };          // Cron expression with timezone

/** What the job does when triggered. */
export type CronPayload =
  | { kind: 'stimulus'; stimulusType: string; data: Record<string, unknown> }
  | { kind: 'webhook'; url: string; method?: string; headers?: Record<string, string>; body?: string }
  | { kind: 'message'; channelPlatform: string; conversationId: string; text: string }
  | { kind: 'custom'; handler: string; args?: Record<string, unknown> };

/** State of a cron job's execution. */
export interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  runCount: number;
}

/** Full cron job definition. */
export interface CronJob {
  id: string;
  seedId?: string;
  ownerUserId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  state: CronJobState;
  createdAt: number;
  updatedAt: number;
}

/** Input for creating a new cron job. */
export type CreateCronJobInput = Omit<CronJob, 'id' | 'state' | 'createdAt' | 'updatedAt'>;

/** Input for updating an existing cron job. */
export type UpdateCronJobInput = Partial<Pick<CronJob, 'name' | 'description' | 'enabled' | 'schedule' | 'payload'>>;

/** Handler function invoked when a cron job is due for execution. */
export type CronJobHandler = (job: CronJob) => void | Promise<void>;
