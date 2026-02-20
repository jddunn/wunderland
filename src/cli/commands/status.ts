/**
 * @fileoverview `wunderland status` — agent & connection status overview.
 * @module wunderland/cli/commands/status
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, warn as wColor, muted, dim, info as iColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadConfig } from '../config/config-manager.js';
import { loadEnv, loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { checkEnvSecrets, getSecretsForPlatform } from '../config/secrets.js';
import { CHANNEL_PLATFORMS, PERSONALITY_PRESETS } from '../constants.js';
import { TokenUsageTracker, type TokenUsageSummary } from '../../core/TokenUsageTracker.js';

export default async function cmdStatus(
  _args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  // Load env files
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const config = await loadConfig(globals.config);
  const env = await loadEnv(globals.config);

  // Agent info
  fmt.section('Agent');
  const localConfig = path.resolve(process.cwd(), 'agent.config.json');
  if (existsSync(localConfig)) {
    try {
      const cfg = JSON.parse(await readFile(localConfig, 'utf8'));
      fmt.kvPair('Name', accent(cfg.displayName || 'Unknown'));
      fmt.kvPair('Seed ID', cfg.seedId || 'unknown');
      fmt.kvPair('Bio', dim(cfg.bio || ''));
    } catch {
      fmt.kvPair('Config', wColor('error reading agent.config.json'));
    }
  } else {
    fmt.kvPair('Project', muted('no agent.config.json in current directory'));
  }

  // Global config
  if (config.agentName) fmt.kvPair('Global Agent', config.agentName);
  if (config.llmProvider) fmt.kvPair('LLM Provider', config.llmProvider);
  if (config.llmModel) fmt.kvPair('LLM Model', config.llmModel);
  if (config.personalityPreset) {
    const preset = PERSONALITY_PRESETS.find((p) => p.id === config.personalityPreset);
    fmt.kvPair('Personality', preset ? preset.label : config.personalityPreset);
  }
  if (config.lastSetup) fmt.kvPair('Last Setup', dim(config.lastSetup));

  // LLM Keys
  fmt.section('LLM Keys');
  const secretStatus = checkEnvSecrets();
  const llmKeys = secretStatus.filter((s) => ['openai', 'anthropic', 'openrouter'].some((p) => s.providers.includes(p)));
  for (const s of llmKeys) {
    if (s.isSet) {
      fmt.ok(`${s.envVar.padEnd(24)} ${dim(s.maskedValue || 'set')}`);
    } else {
      fmt.skip(`${s.envVar.padEnd(24)} ${muted('not set')}`);
    }
  }

  // Channels
  fmt.section('Channels');
  const channels = config.channels || [];
  if (channels.length === 0) {
    fmt.skip('No channels configured');
  } else {
    for (const chId of channels) {
      const platform = CHANNEL_PLATFORMS.find((p) => p.id === chId);
      const label = platform ? `${platform.icon}  ${platform.label}` : chId;
      const secrets = getSecretsForPlatform(chId);
      const ready = secrets.length === 0 || secrets.every((s) => !!(env[s.envVar] || process.env[s.envVar]));
      fmt.channelName(label, ready ? 'active' : 'needs credentials');
    }
  }

  // Tools
  fmt.section('Tool Keys');
  const toolKeys = secretStatus.filter((s) => ['serper', 'serpapi', 'brave', 'elevenlabs', 'giphy', 'newsapi', 'pexels', 'unsplash'].some((p) => s.providers.includes(p)));
  for (const s of toolKeys) {
    if (s.isSet) {
      fmt.ok(`${s.envVar.padEnd(24)} ${dim(s.maskedValue || 'set')}`);
    } else {
      fmt.skip(`${s.envVar.padEnd(24)} ${muted('not set')}`);
    }
  }

  // Token Usage (from global tracker singleton if available)
  displayTokenUsage();

  fmt.blank();
}

// ── Token Usage Display ──────────────────────────────────────────────────────

/**
 * Global token usage tracker instance.
 * Other modules (e.g., chat, start) can import and record usage against this
 * singleton so that `wunderland status` reflects cumulative session usage.
 */
export const globalTokenTracker = new TokenUsageTracker();

/**
 * Format a USD cost to a human-readable string.
 */
function formatCost(usd: number | null): string {
  if (usd === null) return muted('unknown');
  if (usd < 0.01) return dim(`< $0.01`);
  return iColor(`$${usd.toFixed(4)}`);
}

/**
 * Format a token count with thousands separators.
 */
function formatTokenCount(count: number): string {
  return count.toLocaleString('en-US');
}

/**
 * Display token usage section in the status output.
 * Shows per-model breakdowns with cost estimates if usage has been recorded.
 */
function displayTokenUsage(): void {
  const usage: TokenUsageSummary = globalTokenTracker.getUsage();

  fmt.section('Token Usage');

  if (!globalTokenTracker.hasUsage()) {
    fmt.skip('No token usage recorded this session');
    fmt.note(
      `${muted('Token tracking activates when chat or start commands make LLM calls')}`,
    );
    return;
  }

  // Per-model breakdown
  for (const model of usage.perModel) {
    fmt.kvPair(
      model.model,
      `${accent(formatTokenCount(model.totalTokens))} tokens ${dim(`(${formatTokenCount(model.promptTokens)} prompt + ${formatTokenCount(model.completionTokens)} completion)`)}`,
    );
    fmt.kvPair(
      '',
      `${dim(`${model.callCount} call${model.callCount !== 1 ? 's' : ''}`)} ${dim('|')} est. ${formatCost(model.estimatedCostUSD)}`,
    );
  }

  // Totals
  if (usage.perModel.length > 1) {
    fmt.hr();
    fmt.kvPair('Total Prompt', accent(formatTokenCount(usage.totalPromptTokens)));
    fmt.kvPair('Total Completion', accent(formatTokenCount(usage.totalCompletionTokens)));
    fmt.kvPair('Total Combined', accent(formatTokenCount(usage.totalTokens)));
    fmt.kvPair('Total Calls', String(usage.totalCalls));
    fmt.kvPair('Estimated Cost', formatCost(usage.estimatedCostUSD));
  }
}
