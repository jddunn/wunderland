/**
 * @fileoverview `wunderland status` — agent & connection status overview.
 * Uses bordered panels per section for a polished dashboard feel.
 * @module wunderland/cli/commands/status
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, warn as wColor, muted, dim, info as iColor, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { getUiRuntime } from '../ui/runtime.js';
import { printPanel } from '../ui/panel.js';
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
  const ui = getUiRuntime();
  const g = glyphs();

  fmt.section('Wunderland Status');
  fmt.blank();

  // ── Agent Panel ────────────────────────────────────────────────────────
  const agentLines: string[] = [];
  const localConfig = path.resolve(process.cwd(), 'agent.config.json');
  if (existsSync(localConfig)) {
    try {
      const cfg = JSON.parse(await readFile(localConfig, 'utf8'));
      agentLines.push(`${muted('Name'.padEnd(20))} ${accent(cfg.displayName || 'Unknown')}`);
      agentLines.push(`${muted('Seed ID'.padEnd(20))} ${cfg.seedId || 'unknown'}`);
      if (cfg.bio) agentLines.push(`${muted('Bio'.padEnd(20))} ${dim(cfg.bio)}`);
    } catch {
      agentLines.push(`${muted('Config'.padEnd(20))} ${wColor('error reading agent.config.json')}`);
    }
  } else {
    agentLines.push(`${muted('Project'.padEnd(20))} ${muted('no agent.config.json in current directory')}`);
  }

  if (config.agentName) agentLines.push(`${muted('Global Agent'.padEnd(20))} ${config.agentName}`);
  if (config.llmProvider) agentLines.push(`${muted('LLM Provider'.padEnd(20))} ${config.llmProvider}`);
  if (config.llmModel) agentLines.push(`${muted('LLM Model'.padEnd(20))} ${config.llmModel}`);
  if (config.personalityPreset) {
    const preset = PERSONALITY_PRESETS.find((p) => p.id === config.personalityPreset);
    agentLines.push(`${muted('Personality'.padEnd(20))} ${preset ? preset.label : config.personalityPreset}`);
  }
  if (config.lastSetup) agentLines.push(`${muted('Last Setup'.padEnd(20))} ${dim(config.lastSetup)}`);

  printPanel({ title: 'Agent', content: agentLines.join('\n'), style: 'brand' });
  console.log();

  // ── LLM Keys Panel ─────────────────────────────────────────────────────
  const secretStatus = checkEnvSecrets();
  const llmKeys = secretStatus.filter((s) => ['openai', 'anthropic', 'openrouter'].some((p) => s.providers.includes(p)));
  const keyLines = llmKeys.map((s) => {
    const icon = s.isSet ? sColor(g.ok) : muted(g.circle);
    const detail = s.isSet ? dim(s.maskedValue || 'set') : muted('not set');
    return `${icon} ${s.envVar.padEnd(24)} ${detail}`;
  });

  printPanel({ title: 'LLM Keys', content: keyLines.join('\n'), style: 'info' });
  console.log();

  // ── Channels Panel ─────────────────────────────────────────────────────
  const channels = config.channels || [];
  const channelLines: string[] = [];
  if (channels.length === 0) {
    channelLines.push(`${muted(g.circle)} ${muted('No channels configured')}`);
  } else {
    for (const chId of channels) {
      const platform = CHANNEL_PLATFORMS.find((p) => p.id === chId);
      const label = platform ? `${ui.ascii ? '' : `${platform.icon}  `}${platform.label}` : chId;
      const secrets = getSecretsForPlatform(chId);
      const ready = secrets.length === 0 || secrets.every((s) => !!(env[s.envVar] || process.env[s.envVar]));
      const icon = ready ? sColor(g.ok) : wColor(g.warn);
      const status = ready ? sColor('active') : wColor('needs credentials');
      channelLines.push(`${icon} ${label.padEnd(24)} ${status}`);
    }
  }

  printPanel({ title: 'Channels', content: channelLines.join('\n'), style: 'info' });
  console.log();

  // ── Tool Keys Panel ────────────────────────────────────────────────────
  const toolKeys = secretStatus.filter((s) => ['serper', 'serpapi', 'brave', 'elevenlabs', 'giphy', 'newsapi', 'pexels', 'unsplash'].some((p) => s.providers.includes(p)));
  const toolLines = toolKeys.map((s) => {
    const icon = s.isSet ? sColor(g.ok) : muted(g.circle);
    const detail = s.isSet ? dim(s.maskedValue || 'set') : muted('not set');
    return `${icon} ${s.envVar.padEnd(24)} ${detail}`;
  });

  printPanel({ title: 'Tool Keys', content: toolLines.join('\n'), style: 'info' });
  console.log();

  // ── Token Usage Panel ──────────────────────────────────────────────────
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

function formatCost(usd: number | null): string {
  if (usd === null) return muted('unknown');
  if (usd < 0.01) return dim(`< $0.01`);
  return iColor(`$${usd.toFixed(4)}`);
}

function formatTokenCount(count: number): string {
  return count.toLocaleString('en-US');
}

function displayTokenUsage(): void {
  const usage: TokenUsageSummary = globalTokenTracker.getUsage();
  const g = glyphs();

  if (!globalTokenTracker.hasUsage()) {
    const content = [
      `${muted(g.circle)} No token usage recorded this session`,
      `${dim('Token tracking activates when chat or start commands make LLM calls')}`,
    ].join('\n');
    printPanel({ title: 'Token Usage', content, style: 'brand' });
    return;
  }

  const lines: string[] = [];
  for (const model of usage.perModel) {
    lines.push(
      `${muted(model.model.padEnd(24))} ${accent(formatTokenCount(model.totalTokens))} tokens ${dim(`(${formatTokenCount(model.promptTokens)} in + ${formatTokenCount(model.completionTokens)} out)`)}`,
    );
    lines.push(
      `${''.padEnd(24)} ${dim(`${model.callCount} call${model.callCount !== 1 ? 's' : ''}`)} ${dim('|')} est. ${formatCost(model.estimatedCostUSD)}`,
    );
  }

  if (usage.perModel.length > 1) {
    lines.push(dim(g.hr.repeat(56)));
    lines.push(`${muted('Total'.padEnd(24))} ${accent(formatTokenCount(usage.totalTokens))} tokens`);
    lines.push(`${''.padEnd(24)} ${dim(`${usage.totalCalls} calls`)} ${dim('|')} est. ${formatCost(usage.estimatedCostUSD)}`);
  }

  printPanel({ title: 'Token Usage', content: lines.join('\n'), style: 'brand' });
}
