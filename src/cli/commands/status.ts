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
import type { TokenUsageSummary } from '../../core/TokenUsageTracker.js';
import { getRecordedWunderlandTokenUsage } from '../../observability/token-usage.js';
import { resolveAgentDisplayName } from '../../runtime/agent-identity.js';
import { resolveEffectiveAgentConfig } from '../../config/effective-agent-config.js';

const CHANNEL_ALIASES: Record<string, string> = {
  'blog-publisher': 'devto',
  'blog publisher': 'devto',
  'dev.to': 'devto',
  hashnode: 'devto',
  medium: 'devto',
  wordpress: 'devto',
};

function normalizeChannelId(channelId: string): string {
  const normalized = channelId.trim().toLowerCase();
  return CHANNEL_ALIASES[normalized] ?? normalized;
}

export default async function cmdStatus(
  _args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  // Load env files
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const format = typeof _flags['format'] === 'string' ? _flags['format'] : 'table';
  const config = await loadConfig(globals.config);
  const env = await loadEnv(globals.config);
  const ui = getUiRuntime();
  const g = glyphs();

  // ── JSON output ──────────────────────────────────────────────────────────
  if (format === 'json') {
    const localConfig = path.resolve(process.cwd(), 'agent.config.json');
    let agent: Record<string, unknown> = { hasConfig: false };
    if (existsSync(localConfig)) {
      try {
        const rawCfg = JSON.parse(await readFile(localConfig, 'utf8'));
        const { agentConfig: cfg, selectedPersona, availablePersonas } = await resolveEffectiveAgentConfig({
          agentConfig: rawCfg,
          workingDirectory: process.cwd(),
        });
        agent = {
          hasConfig: true,
          displayName: cfg.displayName,
          seedId: cfg.seedId,
          bio: cfg.bio,
          presetId: cfg.presetId,
          persona: selectedPersona ? { id: selectedPersona.id, name: selectedPersona.name } : null,
          personaCount: Array.isArray(availablePersonas) ? availablePersonas.length : 0,
          rag: cfg.rag ?? null,
          discovery: cfg.discovery ?? null,
        };
      } catch { agent = { hasConfig: true, error: 'failed to parse agent.config.json' }; }
    }

    const secretStatus = checkEnvSecrets();
    const llmKeys = secretStatus.filter((s) => ['openai', 'anthropic', 'openrouter'].some((p) => s.providers.includes(p)));
    const toolKeys = secretStatus.filter((s) => ['serper', 'serpapi', 'brave', 'elevenlabs', 'giphy', 'newsapi', 'pexels', 'unsplash'].some((p) => s.providers.includes(p)));

    const channels = (config.channels || []).map((chId: string) => {
      const normalizedChannelId = normalizeChannelId(chId);
      const secrets = getSecretsForPlatform(normalizedChannelId);
      const ready = secrets.length === 0 || secrets.every((s) => !!(env[s.envVar] || process.env[s.envVar]));
      return { id: chId, ready };
    });

    const usage = await getRecordedWunderlandTokenUsage(globals.config);

    console.log(JSON.stringify({
      agent,
      global: { agentName: config.agentName, llmProvider: config.llmProvider, llmModel: config.llmModel, lastSetup: config.lastSetup },
      llmKeys: llmKeys.map((s) => ({ envVar: s.envVar, isSet: s.isSet })),
      toolKeys: toolKeys.map((s) => ({ envVar: s.envVar, isSet: s.isSet })),
      channels,
      tokenUsage: usage.totalCalls > 0 ? usage : null,
    }, null, 2));
    return;
  }

  // ── Table output ─────────────────────────────────────────────────────────
  fmt.section('Wunderland Status');
  fmt.blank();

  // ── Agent Panel ────────────────────────────────────────────────────────
  const agentLines: string[] = [];
  const localConfig = path.resolve(process.cwd(), 'agent.config.json');
  if (existsSync(localConfig)) {
    try {
      const rawCfg = JSON.parse(await readFile(localConfig, 'utf8'));
      const { agentConfig: cfg, selectedPersona, availablePersonas } = await resolveEffectiveAgentConfig({
        agentConfig: rawCfg,
        workingDirectory: process.cwd(),
      });
      const resolvedName = resolveAgentDisplayName({
        displayName: cfg.displayName,
        agentName: cfg.agentName,
        seedId: cfg.seedId,
        globalAgentName: config.agentName,
        fallback: 'Unknown',
      });
      agentLines.push(`${muted('Name'.padEnd(20))} ${accent(resolvedName)}`);
      agentLines.push(`${muted('Seed ID'.padEnd(20))} ${cfg.seedId || 'unknown'}`);
      if (cfg.bio) agentLines.push(`${muted('Bio'.padEnd(20))} ${dim(cfg.bio)}`);
      if (cfg.presetId) agentLines.push(`${muted('Preset'.padEnd(20))} ${accent(cfg.presetId)}`);
      if (selectedPersona) {
        agentLines.push(`${muted('AgentOS Persona'.padEnd(20))} ${accent(selectedPersona.name)} ${dim(`(${selectedPersona.id})`)}`);
      }
      if (cfg.rag?.enabled) {
        agentLines.push(
          `${muted('RAG'.padEnd(20))} ${accent(cfg.rag.preset || 'balanced')}${cfg.rag.includeGraphRag ? dim(' + graph') : ''}`,
        );
      }
      if (cfg.discovery?.enabled) {
        agentLines.push(
          `${muted('Discovery'.padEnd(20))} ${accent(cfg.discovery.recallProfile || 'aggressive')}`,
        );
      }
      if (Array.isArray(availablePersonas) && availablePersonas.length > 0) {
        agentLines.push(`${muted('Persona Registry'.padEnd(20))} ${dim(`${availablePersonas.length} available`)}`);
      }

      // Memory & Cognitive Mechanisms
      const mem = cfg.memory as Record<string, any> | undefined;
      if (mem) {
        const memEnabled = mem.enabled !== false;
        agentLines.push(`${muted('Memory'.padEnd(20))} ${memEnabled ? sColor('enabled') : muted('disabled')}`);
        if (memEnabled) {
          agentLines.push(`${muted('  Budget'.padEnd(20))} ${mem.retrievalBudgetTokens ?? 4000} tokens`);
          agentLines.push(`${muted('  Infinite Context'.padEnd(20))} ${mem.infiniteContext?.enabled ? sColor('on') : muted('off')}${mem.infiniteContext?.strategy ? dim(` (${mem.infiniteContext.strategy})`) : ''}`);
          if (mem.cognitiveMechanisms) {
            const mechKeys = Object.keys(mem.cognitiveMechanisms);
            const activeCount = mechKeys.length === 0 ? 8 : mechKeys.filter(k => (mem.cognitiveMechanisms as any)[k]?.enabled !== false).length;
            agentLines.push(`${muted('  Mechanisms'.padEnd(20))} ${sColor(`${activeCount} active`)} ${dim('(HEXACO-modulated)')}`);
          } else {
            agentLines.push(`${muted('  Mechanisms'.padEnd(20))} ${muted('disabled')}`);
          }
        }
      }

      // HEXACO Personality Traits
      const traits = cfg.personality as Record<string, number> | undefined;
      if (traits && Object.keys(traits).length > 0) {
        const traitStr = Object.entries(traits)
          .filter(([, v]) => typeof v === 'number')
          .map(([k, v]) => `${k[0].toUpperCase()}=${v.toFixed(1)}`)
          .join(' ');
        agentLines.push(`${muted('HEXACO Traits'.padEnd(20))} ${dim(traitStr)}`);
      }
    } catch {
      agentLines.push(`${muted('Config'.padEnd(20))} ${wColor('error reading agent.config.json')}`);
    }
  } else {
    agentLines.push(`${muted('Project'.padEnd(20))} ${muted('no agent.config.json in current directory')}`);
  }

  if (config.agentName) agentLines.push(`${muted('Global Agent'.padEnd(20))} ${accent(config.agentName)}`);
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
      const normalizedChannelId = normalizeChannelId(chId);
      const platform = CHANNEL_PLATFORMS.find((p) => p.id === normalizedChannelId);
      const label = platform ? `${ui.ascii ? '' : `${platform.icon}  `}${platform.label}` : chId;
      const secrets = getSecretsForPlatform(normalizedChannelId);
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
  await displayTokenUsage(globals.config);

  fmt.blank();
}

// ── Token Usage Display ──────────────────────────────────────────────────────

/**
 * In-process token tracker bridge.
 * Runtime writers still update this singleton for fast local state, but
 * `wunderland status` reads from the durable usage ledger on disk.
 */
export { globalTokenTracker } from '../../observability/token-usage.js';

function formatCost(usd: number | null): string {
  if (usd === null) return muted('unknown');
  if (usd < 0.01) return dim(`< $0.01`);
  return iColor(`$${usd.toFixed(4)}`);
}

function formatTokenCount(count: number): string {
  return count.toLocaleString('en-US');
}

async function displayTokenUsage(configDirOverride?: string): Promise<void> {
  const usage: TokenUsageSummary = await getRecordedWunderlandTokenUsage(configDirOverride);
  const g = glyphs();

  if (usage.totalCalls === 0) {
    const content = [
      `${muted(g.circle)} No LLM usage recorded yet`,
      `${dim('Usage appears here after chat, workflows, missions, image, or structured commands make model calls')}`,
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
      `${''.padEnd(24)} ${dim(`${model.callCount} call${model.callCount !== 1 ? 's' : ''}`)} ${dim('|')} cost ${formatCost(model.estimatedCostUSD)}`,
    );
  }

  if (usage.perModel.length > 1) {
    lines.push(dim(g.hr.repeat(56)));
    lines.push(`${muted('Total'.padEnd(24))} ${accent(formatTokenCount(usage.totalTokens))} tokens`);
    lines.push(`${''.padEnd(24)} ${dim(`${usage.totalCalls} calls`)} ${dim('|')} cost ${formatCost(usage.estimatedCostUSD)}`);
  }

  printPanel({ title: 'Token Usage', content: lines.join('\n'), style: 'brand' });
}
