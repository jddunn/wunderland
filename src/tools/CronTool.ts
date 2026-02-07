/**
 * @fileoverview CronTool -- ITool implementation that allows agents to manage
 * their own cron jobs. Delegates to the CronScheduler for actual scheduling.
 *
 * Actions: create, list, get, update, pause, resume, delete.
 *
 * @module wunderland/tools/CronTool
 */

import type {
  ITool,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@framers/agentos';

import { CronScheduler } from '../scheduling/CronScheduler.js';
import type {
  CronSchedule,
  CronPayload,
  CreateCronJobInput,
  UpdateCronJobInput,
} from '../scheduling/types.js';

// ---------------------------------------------------------------------------
// Singleton scheduler instance shared by all CronTool invocations
// ---------------------------------------------------------------------------

let _scheduler: CronScheduler | undefined;

function getScheduler(): CronScheduler {
  if (!_scheduler) {
    _scheduler = new CronScheduler();
    _scheduler.start();
  }
  return _scheduler;
}

/**
 * Replace the singleton scheduler (useful for testing or custom configuration).
 */
export function setCronToolScheduler(scheduler: CronScheduler): void {
  _scheduler = scheduler;
}

// ---------------------------------------------------------------------------
// Helper: build CronSchedule from tool arguments
// ---------------------------------------------------------------------------

function buildSchedule(
  scheduleKind: string,
  scheduleValue: string,
  timezone?: string,
): CronSchedule {
  switch (scheduleKind) {
    case 'at':
      return { kind: 'at', at: scheduleValue };
    case 'every':
      return { kind: 'every', everyMs: parseInt(scheduleValue, 10) };
    case 'cron':
      return { kind: 'cron', expr: scheduleValue, tz: timezone };
    default:
      throw new Error(`Unknown scheduleKind: ${scheduleKind}`);
  }
}

// ---------------------------------------------------------------------------
// Helper: build CronPayload from tool arguments
// ---------------------------------------------------------------------------

function buildPayload(
  payloadKind: string,
  payloadConfig: Record<string, unknown>,
): CronPayload {
  switch (payloadKind) {
    case 'stimulus':
      return {
        kind: 'stimulus',
        stimulusType: (payloadConfig.stimulusType as string) ?? 'generic',
        data: (payloadConfig.data as Record<string, unknown>) ?? {},
      };
    case 'webhook':
      return {
        kind: 'webhook',
        url: payloadConfig.url as string,
        method: payloadConfig.method as string | undefined,
        headers: payloadConfig.headers as Record<string, string> | undefined,
        body: payloadConfig.body as string | undefined,
      };
    case 'message':
      return {
        kind: 'message',
        channelPlatform: (payloadConfig.channelPlatform as string) ?? 'unknown',
        conversationId: (payloadConfig.conversationId as string) ?? '',
        text: (payloadConfig.text as string) ?? '',
      };
    case 'custom':
      return {
        kind: 'custom',
        handler: (payloadConfig.handler as string) ?? 'default',
        args: payloadConfig.args as Record<string, unknown> | undefined,
      };
    default:
      throw new Error(`Unknown payloadKind: ${payloadKind}`);
  }
}

// ---------------------------------------------------------------------------
// Helper: success / error result builders
// ---------------------------------------------------------------------------

function ok(data: unknown): ToolExecutionResult {
  return {
    success: true,
    output: { result: JSON.stringify(data) },
  };
}

function fail(message: string): ToolExecutionResult {
  return {
    success: false,
    error: message,
    output: { error: message },
  };
}

// ---------------------------------------------------------------------------
// CronTool
// ---------------------------------------------------------------------------

export const CronTool: ITool = {
  id: 'cron_manage',
  name: 'cron_manage',
  displayName: 'Cron Manager',
  description:
    'Create, list, update, pause, resume, or delete scheduled cron jobs for the agent.',
  category: 'scheduling',
  hasSideEffects: true,

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'get', 'update', 'pause', 'resume', 'delete'],
        description: 'The cron management action to perform.',
      },
      jobId: {
        type: 'string',
        description: 'Job ID (required for get, update, pause, resume, delete).',
      },
      name: {
        type: 'string',
        description: 'Job name (required for create).',
      },
      description: {
        type: 'string',
        description: 'Job description (optional).',
      },
      scheduleKind: {
        type: 'string',
        enum: ['at', 'every', 'cron'],
        description:
          'Schedule type: "at" for one-shot, "every" for interval, "cron" for cron expression.',
      },
      scheduleValue: {
        type: 'string',
        description:
          'Schedule value: ISO timestamp for "at", milliseconds for "every", cron expression for "cron".',
      },
      timezone: {
        type: 'string',
        description:
          'Timezone for cron expressions (e.g., "America/New_York"). Optional.',
      },
      payloadKind: {
        type: 'string',
        enum: ['stimulus', 'webhook', 'message', 'custom'],
        description: 'What the job does when triggered.',
      },
      payloadConfig: {
        type: 'object',
        description: 'Payload configuration object.',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the job is enabled (for update).',
      },
    },
    required: ['action'],
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const scheduler = getScheduler();
    const action = args.action as string;

    try {
      switch (action) {
        // ── CREATE ──────────────────────────────────────────────────────
        case 'create': {
          const name = args.name as string | undefined;
          const scheduleKind = args.scheduleKind as string | undefined;
          const scheduleValue = args.scheduleValue as string | undefined;

          if (!name) return fail('Missing required field "name" for create.');
          if (!scheduleKind) return fail('Missing required field "scheduleKind" for create.');
          if (!scheduleValue) return fail('Missing required field "scheduleValue" for create.');

          const schedule = buildSchedule(scheduleKind, scheduleValue, args.timezone as string | undefined);

          // Payload is optional -- default to a stimulus with empty data
          let payload: CronPayload;
          if (args.payloadKind) {
            payload = buildPayload(
              args.payloadKind as string,
              (args.payloadConfig as Record<string, unknown>) ?? {},
            );
          } else {
            payload = { kind: 'stimulus', stimulusType: 'cron_tick', data: {} };
          }

          const input: CreateCronJobInput = {
            seedId: context.sessionData?.seedId as string | undefined,
            ownerUserId: context.userContext?.userId as string | undefined,
            name,
            description: args.description as string | undefined,
            enabled: true,
            schedule,
            payload,
          };

          const job = scheduler.addJob(input);
          return ok({ action: 'created', job });
        }

        // ── LIST ────────────────────────────────────────────────────────
        case 'list': {
          const seedId = context.sessionData?.seedId as string | undefined;
          const jobs = scheduler.listJobs({ seedId });
          const summary = jobs.map((j) => ({
            id: j.id,
            name: j.name,
            enabled: j.enabled,
            schedule: j.schedule,
            nextRunAtMs: j.state.nextRunAtMs,
            runCount: j.state.runCount,
            lastStatus: j.state.lastStatus,
          }));
          return ok({ action: 'list', count: jobs.length, jobs: summary });
        }

        // ── GET ─────────────────────────────────────────────────────────
        case 'get': {
          const jobId = args.jobId as string | undefined;
          if (!jobId) return fail('Missing required field "jobId" for get.');
          const job = scheduler.getJob(jobId);
          if (!job) return fail(`Job not found: ${jobId}`);
          return ok({ action: 'get', job });
        }

        // ── UPDATE ──────────────────────────────────────────────────────
        case 'update': {
          const jobId = args.jobId as string | undefined;
          if (!jobId) return fail('Missing required field "jobId" for update.');

          const updates: UpdateCronJobInput = {};

          if (args.name !== undefined) updates.name = args.name as string;
          if (args.description !== undefined) updates.description = args.description as string;
          if (args.enabled !== undefined) updates.enabled = args.enabled as boolean;
          if (args.scheduleKind && args.scheduleValue) {
            updates.schedule = buildSchedule(
              args.scheduleKind as string,
              args.scheduleValue as string,
              args.timezone as string | undefined,
            );
          }
          if (args.payloadKind) {
            updates.payload = buildPayload(
              args.payloadKind as string,
              (args.payloadConfig as Record<string, unknown>) ?? {},
            );
          }

          const updated = scheduler.updateJob(jobId, updates);
          if (!updated) return fail(`Job not found: ${jobId}`);
          return ok({ action: 'updated', job: updated });
        }

        // ── PAUSE ───────────────────────────────────────────────────────
        case 'pause': {
          const jobId = args.jobId as string | undefined;
          if (!jobId) return fail('Missing required field "jobId" for pause.');
          const existing = scheduler.getJob(jobId);
          if (!existing) return fail(`Job not found: ${jobId}`);
          scheduler.pauseJob(jobId);
          return ok({ action: 'paused', jobId });
        }

        // ── RESUME ──────────────────────────────────────────────────────
        case 'resume': {
          const jobId = args.jobId as string | undefined;
          if (!jobId) return fail('Missing required field "jobId" for resume.');
          const existing = scheduler.getJob(jobId);
          if (!existing) return fail(`Job not found: ${jobId}`);
          scheduler.resumeJob(jobId);
          return ok({ action: 'resumed', jobId });
        }

        // ── DELETE ──────────────────────────────────────────────────────
        case 'delete': {
          const jobId = args.jobId as string | undefined;
          if (!jobId) return fail('Missing required field "jobId" for delete.');
          const removed = scheduler.removeJob(jobId);
          if (!removed) return fail(`Job not found: ${jobId}`);
          return ok({ action: 'deleted', jobId });
        }

        default:
          return fail(`Unknown action: ${action}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(`CronTool error: ${message}`);
    }
  },
};
