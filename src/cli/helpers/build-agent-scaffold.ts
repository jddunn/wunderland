/**
 * @fileoverview Shared agent config builder + file scaffold writer.
 * Used by both `wunderland init` and `wunderland start` (inline onboarding).
 * @module wunderland/cli/helpers/build-agent-scaffold
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { HEXACO_PRESETS } from '../../core/WunderlandSeed.js';
import { SECURITY_TIERS, getSecurityTier } from '../../security/SecurityTiers.js';
import type { SecurityTierName } from '../../security/SecurityTiers.js';
import { serializeEnvFile } from '../config/env-manager.js';

// ── Name helpers ──────────────────────────────────────────────────────────────

export function toSeedId(dirName: string): string {
  const base = dirName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return base ? `seed_${base}` : `seed_${Date.now()}`;
}

export function toDisplayName(dirName: string): string {
  const cleaned = dirName.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'My Agent';
  return cleaned.split(' ').map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p)).join(' ');
}

// ── Env example builder ───────────────────────────────────────────────────────

export function buildEnvExample(opts: { llmProvider?: string; llmModel?: string }): string {
  const provider = typeof opts.llmProvider === 'string' ? opts.llmProvider.trim().toLowerCase() : 'openai';
  const model = typeof opts.llmModel === 'string' && opts.llmModel.trim() ? opts.llmModel.trim() : 'gpt-4o';

  const lines: string[] = ['# Copy to .env and fill in real values'];

  if (provider === 'openai') lines.push('OPENAI_API_KEY=sk-...');
  else if (provider === 'openrouter') lines.push('OPENROUTER_API_KEY=...');
  else if (provider === 'anthropic') lines.push('ANTHROPIC_API_KEY=...');
  else if (provider === 'ollama') lines.push('# Ollama: no API key needed');
  else lines.push(`# Provider "${provider}" not supported by CLI runtime`);

  lines.push(`OPENAI_MODEL=${model}`);
  lines.push('PORT=3777', '');

  lines.push(
    '# OBSERVABILITY (OpenTelemetry - opt-in)',
    '# Enable OTEL in wunderland CLI runtime (wunderland start/chat):',
    '# WUNDERLAND_OTEL_ENABLED=true',
    '# WUNDERLAND_OTEL_LOGS_ENABLED=true',
    '# OTEL_TRACES_EXPORTER=otlp',
    '# OTEL_METRICS_EXPORTER=otlp',
    '# OTEL_LOGS_EXPORTER=otlp',
    '# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318',
    '# OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
    '# OTEL_TRACES_SAMPLER=parentbased_traceidratio',
    '# OTEL_TRACES_SAMPLER_ARG=0.1',
    '',
  );

  return lines.join('\n');
}

// ── Config builder ────────────────────────────────────────────────────────────

export interface BuildAgentConfigOptions {
  /** Directory or agent name (used for seedId + displayName). */
  agentName: string;
  llmProvider?: string;
  llmModel?: string;
  llmAuthMethod?: 'api-key' | 'oauth';
  /** HEXACO preset key (uppercase, e.g. 'HELPFUL_ASSISTANT') or undefined for defaults. */
  personalityPresetKey?: string;
  /** Explicit personality trait values (overrides preset). */
  personalityTraits?: Record<string, number>;
  securityTierName?: SecurityTierName;
  /** Agent preset overrides (from PresetLoader). */
  agentPreset?: {
    name?: string;
    description?: string;
    hexacoTraits?: Record<string, number>;
    securityTier?: string;
    suggestedSkills?: string[];
    suggestedChannels?: string[];
    suggestedExtensions?: Record<string, string[]>;
    extensionOverrides?: Record<string, unknown>;
    toolAccessProfile?: string;
    id?: string;
  };
}

export interface AgentConfigResult {
  config: Record<string, unknown>;
}

export function buildAgentConfig(opts: BuildAgentConfigOptions): AgentConfigResult {
  const { agentName, agentPreset } = opts;

  // ── Personality ──────────────────────────────────────────────────────────
  let personality: Record<string, number>;
  if (opts.personalityTraits) {
    personality = { ...opts.personalityTraits };
  } else if (agentPreset?.hexacoTraits) {
    const t = agentPreset.hexacoTraits;
    personality = {
      honesty: t.honesty ?? t.honesty_humility ?? 0.7,
      emotionality: t.emotionality ?? 0.5,
      extraversion: t.extraversion ?? 0.6,
      agreeableness: t.agreeableness ?? 0.65,
      conscientiousness: t.conscientiousness ?? 0.8,
      openness: t.openness ?? 0.75,
    };
  } else if (opts.personalityPresetKey) {
    const hexacoValues = HEXACO_PRESETS[opts.personalityPresetKey as keyof typeof HEXACO_PRESETS];
    if (hexacoValues) {
      personality = {
        honesty: hexacoValues.honesty_humility,
        emotionality: hexacoValues.emotionality,
        extraversion: hexacoValues.extraversion,
        agreeableness: hexacoValues.agreeableness,
        conscientiousness: hexacoValues.conscientiousness,
        openness: hexacoValues.openness,
      };
    } else {
      personality = { honesty: 0.7, emotionality: 0.5, extraversion: 0.6, agreeableness: 0.65, conscientiousness: 0.8, openness: 0.75 };
    }
  } else {
    personality = { honesty: 0.7, emotionality: 0.5, extraversion: 0.6, agreeableness: 0.65, conscientiousness: 0.8, openness: 0.75 };
  }

  // ── Security ─────────────────────────────────────────────────────────────
  const resolvedTierName: SecurityTierName = opts.securityTierName ?? 'permissive';
  const tierConfig = getSecurityTier(resolvedTierName);
  const permissionSet = SECURITY_TIERS[resolvedTierName].permissionSet;
  const executionMode =
    resolvedTierName === 'dangerous' || resolvedTierName === 'permissive'
      ? 'autonomous'
      : resolvedTierName === 'paranoid'
        ? 'human-all'
        : 'human-dangerous';
  const toolAccessProfile = agentPreset?.toolAccessProfile || 'developer';
  const wrapToolOutputs = resolvedTierName !== 'dangerous';

  const security = {
    tier: tierConfig.name,
    preLLMClassifier: tierConfig.pipelineConfig.enablePreLLM,
    dualLLMAudit: tierConfig.pipelineConfig.enableDualLLMAudit,
    outputSigning: tierConfig.pipelineConfig.enableOutputSigning,
    riskThreshold: tierConfig.riskThreshold,
    wrapToolOutputs,
  };

  // ── Build config object ──────────────────────────────────────────────────
  const config: Record<string, unknown> = {
    seedId: toSeedId(agentName),
    displayName: agentPreset?.name ?? toDisplayName(agentName),
    bio: agentPreset?.description ?? 'Autonomous Wunderbot',
    personality,
    systemPrompt: 'You are an autonomous agent in the Wunderland network.',
    security,
    permissionSet,
    executionMode,
    observability: {
      otel: { enabled: false, exportLogs: false },
    },
    skills: agentPreset?.suggestedSkills ?? [],
    suggestedChannels: agentPreset?.suggestedChannels ?? [],
    extensions: agentPreset?.suggestedExtensions,
    extensionOverrides: agentPreset?.extensionOverrides,
    toolAccessProfile,
    presetId: agentPreset?.id,
    skillsDir: './skills',
  };

  if (opts.llmProvider) config.llmProvider = opts.llmProvider;
  if (opts.llmModel) config.llmModel = opts.llmModel;
  if (opts.llmAuthMethod === 'oauth') config.llmAuthMethod = 'oauth';

  return { config };
}

// ── File scaffold writer ──────────────────────────────────────────────────────

export interface WriteScaffoldOptions {
  targetDir: string;
  config: Record<string, unknown>;
  envData: Record<string, string>;
  agentName: string;
  /** Write .env file (default true). */
  writeEnv?: boolean;
  /** Write README.md (default false — only init does this). */
  writeReadme?: boolean;
  /** Write PERSONA.md content (optional). */
  personaMd?: string;
  /** Skip writing files that already exist (default false). */
  skipExisting?: boolean;
}

export async function writeAgentScaffold(opts: WriteScaffoldOptions): Promise<void> {
  const { targetDir, config, envData, agentName, skipExisting } = opts;
  const writeEnv = opts.writeEnv !== false;

  const shouldWrite = (filePath: string) => !skipExisting || !existsSync(filePath);

  // agent.config.json — always write (this is the primary output)
  await writeFile(
    path.join(targetDir, 'agent.config.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf8',
  );

  // .env
  if (writeEnv && Object.keys(envData).length > 0) {
    const envPath = path.join(targetDir, '.env');
    if (shouldWrite(envPath)) {
      await writeFile(
        envPath,
        serializeEnvFile(envData, `${toDisplayName(agentName)} - generated by wunderland`),
        { encoding: 'utf8', mode: 0o600 },
      );
    }
  }

  // .env.example
  const examplePath = path.join(targetDir, '.env.example');
  if (shouldWrite(examplePath)) {
    await writeFile(
      examplePath,
      buildEnvExample({ llmProvider: config.llmProvider as string, llmModel: config.llmModel as string }),
      'utf8',
    );
  }

  // .gitignore
  const giPath = path.join(targetDir, '.gitignore');
  if (shouldWrite(giPath)) {
    await writeFile(giPath, '.env\nnode_modules\n', 'utf8');
  }

  // skills/ directory
  const skillsDir = path.join(targetDir, 'skills');
  await mkdir(skillsDir, { recursive: true });
  const keepPath = path.join(skillsDir, '.gitkeep');
  if (shouldWrite(keepPath)) {
    await writeFile(keepPath, '', 'utf8');
  }

  // PERSONA.md (optional, from preset)
  if (opts.personaMd) {
    const personaPath = path.join(targetDir, 'PERSONA.md');
    if (shouldWrite(personaPath)) {
      await writeFile(personaPath, opts.personaMd, 'utf8');
    }
  }
}
