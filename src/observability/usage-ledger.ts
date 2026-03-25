import path from 'node:path';

// These usage-tracking functions are exported by @framers/agentos >=0.1.89
// but may not exist in older published versions. Graceful stubs for CI compat.
let clearRecordedAgentOSUsage: (ledgerPath: string) => void;
let getDefaultAgentOSUsageLedgerPath: () => string;
let readRecordedAgentOSUsageEvents: (ledgerPath: string) => any[];
let recordAgentOSUsage: (event: any, ledgerPath?: string) => void;
type AgentOSUsageEvent = { model?: string; provider?: string; promptTokens?: number; completionTokens?: number; timestamp?: number; [k: string]: unknown };

try {
  const mod = require('@framers/agentos');
  clearRecordedAgentOSUsage = mod.clearRecordedAgentOSUsage ?? (() => {});
  getDefaultAgentOSUsageLedgerPath = mod.getDefaultAgentOSUsageLedgerPath ?? (() => '');
  readRecordedAgentOSUsageEvents = mod.readRecordedAgentOSUsageEvents ?? (() => []);
  recordAgentOSUsage = mod.recordAgentOSUsage ?? (() => {});
} catch {
  clearRecordedAgentOSUsage = () => {};
  getDefaultAgentOSUsageLedgerPath = () => '';
  readRecordedAgentOSUsageEvents = () => [];
  recordAgentOSUsage = () => {};
}

import { getConfigDir } from '../cli/config/config-manager.js';
import { USAGE_LEDGER_FILE_NAME } from '../cli/constants.js';
import {
  MODEL_PRICING,
  type ModelTokenUsage,
  type TokenUsageSummary,
} from '../core/TokenUsageTracker.js';

export type WunderlandUsageEvent = AgentOSUsageEvent;

export interface RecordWunderlandUsageInput {
  sessionId?: string | null;
  personaId?: string | null;
  providerId?: string | null;
  model?: string | null;
  userId?: string | null;
  tenantId?: string | null;
  source?: string | null;
  configDirOverride?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    costUSD?: number;
    totalCostUSD?: number;
  } | null;
}

export interface WunderlandUsageSummaryBucket {
  sessionId: string;
  personaId?: string;
  providerId?: string;
  modelId?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD: number;
  calls: number;
}

function resolveUsageLedgerPath(configDirOverride?: string): string {
  const explicitPath = process.env['WUNDERLAND_USAGE_LEDGER_PATH'] || process.env['AGENTOS_USAGE_LEDGER_PATH'];
  if (typeof explicitPath === 'string' && explicitPath.trim()) {
    return path.resolve(explicitPath.trim());
  }
  if (configDirOverride) {
    return path.join(getConfigDir(configDirOverride), USAGE_LEDGER_FILE_NAME);
  }
  return getDefaultAgentOSUsageLedgerPath();
}

function estimateFallbackCost(event: WunderlandUsageEvent): number | undefined {
  if (!event.modelId) return undefined;
  const pricing = MODEL_PRICING[event.modelId as string];
  if (!pricing) return undefined;

  const promptTokens = event.promptTokens ?? 0;
  const completionTokens = event.completionTokens ?? 0;
  return ((promptTokens / 1_000_000) * pricing.promptPer1M)
    + ((completionTokens / 1_000_000) * pricing.completionPer1M);
}

function createEmptyUsageSummary(timestamp = new Date()): TokenUsageSummary {
  return {
    perModel: [],
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalCalls: 0,
    estimatedCostUSD: null,
    sessionStartedAt: timestamp,
    lastRecordedAt: null,
  };
}

function modelKeyForEvent(event: WunderlandUsageEvent): string {
  return (event.modelId as string) || (event.providerId as string) || 'unknown';
}

function hasKnownCost(event: WunderlandUsageEvent): boolean {
  if (typeof event.costUSD === 'number') return true;
  return !!(event.modelId && MODEL_PRICING[event.modelId as string]);
}

function bucketKey(event: WunderlandUsageEvent): string {
  return [
    event.sessionId,
    event.personaId || '-',
    event.providerId || '-',
    event.modelId || '-',
  ].join('|');
}

export async function readWunderlandUsageEvents(configDirOverride?: string): Promise<WunderlandUsageEvent[]> {
  return readRecordedAgentOSUsageEvents(resolveUsageLedgerPath(configDirOverride));
}

export async function listWunderlandUsageSummaries(opts?: {
  configDirOverride?: string;
  sessionId?: string;
}): Promise<WunderlandUsageSummaryBucket[]> {
  const events = await readWunderlandUsageEvents(opts?.configDirOverride);
  const relevantEvents = opts?.sessionId
    ? events.filter((event) => event.sessionId === opts.sessionId)
    : events;
  const buckets = new Map<string, WunderlandUsageSummaryBucket>();

  for (const event of relevantEvents) {
    const key = bucketKey(event);
    const existing = buckets.get(key);
    const promptTokens = event.promptTokens ?? 0;
    const completionTokens = event.completionTokens ?? 0;
    const totalTokens =
      typeof event.totalTokens === 'number'
        ? event.totalTokens
        : promptTokens + completionTokens;
    const costUSD =
      typeof event.costUSD === 'number'
        ? event.costUSD
        : estimateFallbackCost(event) ?? 0;

    if (existing) {
      existing.promptTokens += promptTokens;
      existing.completionTokens += completionTokens;
      existing.totalTokens += totalTokens;
      existing.costUSD += costUSD;
      existing.calls += 1;
      continue;
    }

    buckets.set(key, {
      sessionId: event.sessionId as string,
      personaId: event.personaId as string | undefined,
      providerId: event.providerId as string | undefined,
      modelId: event.modelId as string | undefined,
      promptTokens,
      completionTokens,
      totalTokens,
      costUSD,
      calls: 1,
    });
  }

  return [...buckets.values()];
}

export async function getWunderlandTokenUsageSummary(opts?: {
  configDirOverride?: string;
  sessionId?: string;
}): Promise<TokenUsageSummary> {
  const events = await readWunderlandUsageEvents(opts?.configDirOverride);
  const relevantEvents = opts?.sessionId
    ? events.filter((event) => event.sessionId === opts.sessionId)
    : events;

  if (relevantEvents.length === 0) {
    return createEmptyUsageSummary();
  }

  const summaries = await listWunderlandUsageSummaries(opts);
  const perModelMap = new Map<string, ModelTokenUsage>();
  const knownCostModels = new Set<string>();

  for (const event of relevantEvents) {
    if (hasKnownCost(event)) {
      knownCostModels.add(modelKeyForEvent(event));
    }
  }

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCalls = 0;
  let totalKnownCost = 0;
  let hasAnyKnownCost = false;

  for (const summary of summaries) {
    const key = summary.modelId || summary.providerId || 'unknown';
    const existing = perModelMap.get(key);
    const knownCost = knownCostModels.has(key);
    const costUSD = knownCost ? summary.costUSD : null;

    if (existing) {
      existing.promptTokens += summary.promptTokens;
      existing.completionTokens += summary.completionTokens;
      existing.totalTokens += summary.totalTokens;
      existing.callCount += summary.calls;
      if (existing.estimatedCostUSD !== null && costUSD !== null) {
        existing.estimatedCostUSD += costUSD;
      } else if (costUSD !== null) {
        existing.estimatedCostUSD = costUSD;
      }
    } else {
      perModelMap.set(key, {
        model: key,
        promptTokens: summary.promptTokens,
        completionTokens: summary.completionTokens,
        totalTokens: summary.totalTokens,
        callCount: summary.calls,
        estimatedCostUSD: costUSD,
      });
    }

    totalPromptTokens += summary.promptTokens;
    totalCompletionTokens += summary.completionTokens;
    totalCalls += summary.calls;
    if (costUSD !== null) {
      totalKnownCost += costUSD;
      hasAnyKnownCost = true;
    }
  }

  const timestamps = relevantEvents
    .map((event) => Date.parse(event.recordedAt as string))
    .filter((value) => Number.isFinite(value));
  const startedAt =
    timestamps.length > 0 ? new Date(Math.min(...timestamps)) : new Date();
  const lastRecordedAt =
    timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;

  const perModel = [...perModelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    perModel,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens: totalPromptTokens + totalCompletionTokens,
    totalCalls,
    estimatedCostUSD: hasAnyKnownCost ? totalKnownCost : null,
    sessionStartedAt: startedAt,
    lastRecordedAt,
  };
}

export async function recordWunderlandUsage(input: RecordWunderlandUsageInput): Promise<void> {
  const usage = input.usage;
  const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const totalTokens =
    typeof usage?.total_tokens === 'number'
      ? usage.total_tokens
      : promptTokens + completionTokens;
  const costUSD =
    typeof usage?.totalCostUSD === 'number'
      ? usage.totalCostUSD
      : typeof usage?.costUSD === 'number'
        ? usage.costUSD
        : undefined;

  if (promptTokens <= 0 && completionTokens <= 0 && totalTokens <= 0 && costUSD === undefined) {
    return;
  }

  const modelId = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined;
  const providerId = typeof input.providerId === 'string' && input.providerId.trim() ? input.providerId.trim() : undefined;
  if (!modelId && !providerId) {
    return;
  }
  const sessionId =
    typeof input.sessionId === 'string' && input.sessionId.trim()
      ? input.sessionId.trim()
      : `wunderland-${input.source || 'global'}`;

  await recordAgentOSUsage({
    providerId,
    modelId,
    userId: typeof input.userId === 'string' && input.userId.trim() ? input.userId.trim() : undefined,
    tenantId: typeof input.tenantId === 'string' && input.tenantId.trim() ? input.tenantId.trim() : undefined,
    usage: {
      promptTokens: promptTokens > 0 ? promptTokens : undefined,
      completionTokens: completionTokens > 0 ? completionTokens : undefined,
      totalTokens: totalTokens > 0 ? totalTokens : undefined,
      costUSD,
    },
    options: {
      path: resolveUsageLedgerPath(input.configDirOverride),
      sessionId,
      personaId: typeof input.personaId === 'string' && input.personaId.trim() ? input.personaId.trim() : undefined,
      source: typeof input.source === 'string' && input.source.trim() ? input.source.trim() : undefined,
    },
  });
}

export async function clearWunderlandUsageLedger(configDirOverride?: string): Promise<void> {
  await clearRecordedAgentOSUsage(resolveUsageLedgerPath(configDirOverride));
}
