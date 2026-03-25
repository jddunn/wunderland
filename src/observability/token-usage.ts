import { TokenUsageTracker, type TokenUsageSummary } from '../core/TokenUsageTracker.js';
import {
  clearWunderlandUsageLedger,
  getWunderlandTokenUsageSummary,
  recordWunderlandUsage,
} from './usage-ledger.js';

export const globalTokenTracker = new TokenUsageTracker();

export async function recordWunderlandTokenUsage(input: {
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
}): Promise<void> {
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const usage = input.usage;
  const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0;

  if (model && (promptTokens > 0 || completionTokens > 0)) {
    globalTokenTracker.record(model, promptTokens, completionTokens);
  }

  await recordWunderlandUsage(input);
}

export async function getRecordedWunderlandTokenUsage(configDirOverride?: string): Promise<TokenUsageSummary> {
  return getWunderlandTokenUsageSummary({ configDirOverride });
}

export async function getRecordedWunderlandSessionUsage(
  sessionId: string,
  configDirOverride?: string,
): Promise<TokenUsageSummary> {
  return getWunderlandTokenUsageSummary({ sessionId, configDirOverride });
}

export async function resetRecordedWunderlandTokenUsage(configDirOverride?: string): Promise<void> {
  globalTokenTracker.reset();
  await clearWunderlandUsageLedger(configDirOverride);
}
