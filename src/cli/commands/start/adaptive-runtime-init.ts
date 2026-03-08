/**
 * @fileoverview Adaptive execution runtime, system prompt building.
 * Extracted from start.ts lines 938-962.
 */

import { WunderlandAdaptiveExecutionRuntime } from '../../../runtime/adaptive-execution.js';
import { buildAgenticSystemPrompt } from '../../../runtime/system-prompt-builder.js';

export async function initAdaptiveRuntime(ctx: any): Promise<void> {
  const { cfg, seed, policy, lazyTools, autoApproveToolCalls, skillsPrompt, turnApprovalMode } = ctx;

  const cliStorageDefaults = { quiet: true, priority: ['sqljs' as const] };
  const adaptiveRuntime = new WunderlandAdaptiveExecutionRuntime({
    toolFailureMode: cfg?.toolFailureMode,
    taskOutcomeTelemetry: {
      ...cfg?.taskOutcomeTelemetry,
      storage: { ...cliStorageDefaults, ...cfg?.taskOutcomeTelemetry?.storage },
    },
    adaptiveExecution: cfg?.adaptiveExecution,
    logger: console,
  });
  await adaptiveRuntime.initialize();
  const defaultTenantId =
    typeof (cfg as any)?.organizationId === 'string' && String((cfg as any).organizationId).trim()
      ? String((cfg as any).organizationId).trim()
      : undefined;

  const systemPrompt = buildAgenticSystemPrompt({
    seed,
    policy,
    mode: 'server',
    lazyTools,
    autoApproveToolCalls,
    skillsPrompt: skillsPrompt || undefined,
    turnApprovalMode,
  });

  const sessions = new Map<string, Array<Record<string, unknown>>>();
  const channelSessions = new Map<string, Array<Record<string, unknown>>>();
  const channelQueues = new Map<string, Promise<void>>();
  const channelUnsubs: Array<() => void> = [];

  ctx.adaptiveRuntime = adaptiveRuntime;
  ctx.systemPrompt = systemPrompt;
  ctx.defaultTenantId = defaultTenantId;
  ctx.sessions = sessions;
  ctx.channelSessions = channelSessions;
  ctx.channelQueues = channelQueues;
  ctx.channelUnsubs = channelUnsubs;
}
