/**
 * @fileoverview `wunderland init <dir>` — scaffold a new Wunderbot project.
 * @module wunderland/cli/commands/init
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { PERSONALITY_PRESETS } from '../constants.js';
import { accent, success as sColor, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { HEXACO_PRESETS } from '../../core/WunderlandSeed.js';
import { PresetLoader, type AgentPreset } from '../../core/PresetLoader.js';
import { SECURITY_TIERS, isValidSecurityTier, getSecurityTier } from '../../security/SecurityTiers.js';
import type { SecurityTierName } from '../../security/SecurityTiers.js';
import { loadDotEnvIntoProcessUpward, mergeEnv, serializeEnvFile } from '../config/env-manager.js';
import { runInitLlmStep } from '../wizards/init-llm-step.js';

function toSeedId(dirName: string): string {
  const base = dirName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return base ? `seed_${base}` : `seed_${Date.now()}`;
}

function toDisplayName(dirName: string): string {
  const cleaned = dirName.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'My Agent';
  return cleaned.split(' ').map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p)).join(' ');
}

function buildEnvExample(opts: { llmProvider?: string; llmModel?: string }): string {
  const provider = typeof opts.llmProvider === 'string' ? opts.llmProvider.trim().toLowerCase() : 'openai';
  const model = typeof opts.llmModel === 'string' && opts.llmModel.trim() ? opts.llmModel.trim() : 'gpt-4o-mini';

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

export default async function cmdInit(
  args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const dirName = args[0];
  if (!dirName) {
    fmt.errorBlock('Missing directory name', 'Usage: wunderland init <dir>');
    process.exitCode = 1;
    return;
  }

  const targetDir = path.resolve(process.cwd(), dirName);

  if (existsSync(targetDir)) {
    const entries = await readdir(targetDir).catch(() => []);
    if (entries.length > 0 && flags['force'] !== true) {
      fmt.errorBlock('Directory not empty', `${targetDir}\nRe-run with --force to write files anyway.`);
      process.exitCode = 1;
      return;
    }
  }

  await mkdir(targetDir, { recursive: true });

  // ── Load env vars so existing keys are discoverable ─────────────────────
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: _globals.config });

  // ── Resolve preset ────────────────────────────────────────────────────
  const presetFlag = typeof flags['preset'] === 'string' ? flags['preset'] : undefined;
  let agentPreset: AgentPreset | undefined;
  let hexacoValues: (typeof HEXACO_PRESETS)[keyof typeof HEXACO_PRESETS] | undefined;

  if (presetFlag) {
    // Try agent presets first (lowercase-hyphen IDs like "research-assistant")
    try {
      const loader = new PresetLoader();
      agentPreset = loader.loadPreset(presetFlag.toLowerCase().replace(/_/g, '-'));
    } catch {
      // Not an agent preset — try HEXACO personality presets
    }

    if (!agentPreset) {
      const key = presetFlag.toUpperCase().replace(/-/g, '_');
      hexacoValues = HEXACO_PRESETS[key as keyof typeof HEXACO_PRESETS];
    }

    if (!agentPreset && !hexacoValues) {
      fmt.warning(`Unknown preset "${presetFlag}". Using default personality values.`);
      fmt.note(`Run ${accent('wunderland list-presets')} to see available presets.`);
    }
  }

  // ── Personality ────────────────────────────────────────────────────────
  let personality: Record<string, number>;
  if (agentPreset) {
    const t = agentPreset.hexacoTraits;
    personality = {
      honesty: t.honesty,
      emotionality: t.emotionality,
      extraversion: t.extraversion,
      agreeableness: t.agreeableness,
      conscientiousness: t.conscientiousness,
      openness: t.openness,
    };
  } else if (hexacoValues) {
    personality = {
      honesty: hexacoValues.honesty_humility,
      emotionality: hexacoValues.emotionality,
      extraversion: hexacoValues.extraversion,
      agreeableness: hexacoValues.agreeableness,
      conscientiousness: hexacoValues.conscientiousness,
      openness: hexacoValues.openness,
    };
  } else {
    personality = {
      honesty: 0.7,
      emotionality: 0.5,
      extraversion: 0.6,
      agreeableness: 0.65,
      conscientiousness: 0.8,
      openness: 0.75,
    };
  }

  // ── Security ───────────────────────────────────────────────────────────
  const VALID_TIERS = ['dangerous', 'permissive', 'balanced', 'strict', 'paranoid'];
  const securityTierFlag = typeof flags['security-tier'] === 'string'
    ? flags['security-tier'].toLowerCase()
    : agentPreset?.securityTier?.toLowerCase();
  let securityTierName: SecurityTierName | undefined;

  if (securityTierFlag) {
    if (isValidSecurityTier(securityTierFlag)) {
      securityTierName = securityTierFlag;
    } else if (typeof flags['security-tier'] === 'string') {
      fmt.errorBlock(
        'Invalid security tier',
        `"${securityTierFlag}" is not a valid tier.\nValid tiers: ${VALID_TIERS.join(', ')}`,
      );
      process.exitCode = 1;
      return;
    }
  }

  // Default to a safe, production-ready tier when not explicitly specified.
  const resolvedTierName: SecurityTierName = securityTierName ?? 'balanced';
  const tierConfig = getSecurityTier(resolvedTierName);
  const permissionSet = SECURITY_TIERS[resolvedTierName].permissionSet;
  const executionMode =
    resolvedTierName === 'dangerous' || resolvedTierName === 'permissive'
      ? 'autonomous'
      : resolvedTierName === 'paranoid'
        ? 'human-all'
        : 'human-dangerous';
  const toolAccessProfile = (agentPreset as any)?.toolAccessProfile || 'assistant';
  const wrapToolOutputs = resolvedTierName !== 'dangerous';
  const security = {
    tier: tierConfig.name,
    preLLMClassifier: tierConfig.pipelineConfig.enablePreLLM,
    dualLLMAudit: tierConfig.pipelineConfig.enableDualLLMAudit,
    outputSigning: tierConfig.pipelineConfig.enableOutputSigning,
    riskThreshold: tierConfig.riskThreshold,
    wrapToolOutputs,
  };

  // ── Interactive LLM setup ──────────────────────────────────────────────
  const nonInteractive = _globals.yes || _globals.quiet || !process.stdin.isTTY || !process.stdout.isTTY;
  const skipKeys = flags['skip-keys'] === true || _globals.quiet;
  let llmProvider: string | undefined;
  let llmModel: string | undefined;
  let wroteEnv = false;

  if (!skipKeys) {
    const llmResult = await runInitLlmStep({ nonInteractive });
    if (llmResult) {
      llmProvider = llmResult.llmProvider;
      llmModel = llmResult.llmModel;

      // Write project .env with collected keys
      const envData: Record<string, string> = { ...llmResult.apiKeys };
      if (llmResult.llmModel) {
        envData['OPENAI_MODEL'] = llmResult.llmModel;
      }
      envData['PORT'] = '3777';

      await writeFile(
        path.join(targetDir, '.env'),
        serializeEnvFile(envData, `${agentPreset?.name ?? toDisplayName(dirName)} — generated by wunderland init`),
        { encoding: 'utf8', mode: 0o600 },
      );
      wroteEnv = true;

      // Also save to global ~/.wunderland/.env
      await mergeEnv(llmResult.apiKeys, _globals.config);
    }
  }

  // ── Build config ───────────────────────────────────────────────────────
  const config: Record<string, unknown> = {
    seedId: toSeedId(dirName),
    displayName: agentPreset?.name ?? toDisplayName(dirName),
    bio: agentPreset?.description ?? 'Autonomous Wunderbot',
    personality,
    systemPrompt: 'You are an autonomous agent in the Wunderland network.',
    security,
    permissionSet,
    executionMode,
    observability: {
      // Opt-in OpenTelemetry (OTEL) export. Host still controls exporters/sampling via OTEL_* env vars.
      otel: { enabled: false, exportLogs: false },
    },
    skills: agentPreset?.suggestedSkills ?? [],
    suggestedChannels: agentPreset?.suggestedChannels ?? [],
    extensions: (agentPreset as any)?.suggestedExtensions,
    extensionOverrides: (agentPreset as any)?.extensionOverrides,
    toolAccessProfile,
    presetId: agentPreset?.id,
    skillsDir: './skills',
  };

  // Include LLM provider/model in config if set
  if (llmProvider) config.llmProvider = llmProvider;
  if (llmModel) config.llmModel = llmModel;

  // Write files
  await writeFile(
    path.join(targetDir, 'agent.config.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf8',
  );

  await writeFile(
    path.join(targetDir, '.env.example'),
    buildEnvExample({ llmProvider, llmModel }),
    'utf8',
  );

  await writeFile(path.join(targetDir, '.gitignore'), '.env\nnode_modules\n', 'utf8');

  // Create skills directory
  const skillsDir = path.join(targetDir, 'skills');
  await mkdir(skillsDir, { recursive: true });
  await writeFile(path.join(skillsDir, '.gitkeep'), '', 'utf8');

  // Copy PERSONA.md from preset if available
  if (agentPreset?.persona) {
    await writeFile(path.join(targetDir, 'PERSONA.md'), agentPreset.persona, 'utf8');
  }

  await writeFile(
    path.join(targetDir, 'README.md'),
    `# ${config.displayName}\n\nScaffolded by the Wunderland CLI.\n\n## Run\n\n\`\`\`bash\n${wroteEnv ? '' : 'cp .env.example .env\n'}wunderland start\n\`\`\`\n\nAgent server:\n- GET http://localhost:3777/health\n- POST http://localhost:3777/chat { "message": "Hello", "sessionId": "local" }\n- HITL UI: http://localhost:3777/hitl\n\nNotes:\n- \`wunderland start\` prints an \`HITL Secret\` on startup. Paste it into the HITL UI, or run: \`wunderland hitl watch --server http://localhost:3777 --secret <token>\`.\n- Approvals are controlled by \`executionMode\` in \`agent.config.json\`:\n  - \`human-dangerous\`: approve Tier 3 tools only\n  - \`human-all\`: approve every tool call\n  - \`autonomous\` (or \`wunderland start --yes\`): auto-approve everything\n- Optional: set \`hitl.turnApprovalMode\` to \`after-each-round\` to require per-round checkpoints.\n- Disable shell safety checks with: \`wunderland start --dangerously-skip-command-safety --yes\` or \`wunderland start --dangerously-skip-permissions\`.\n\n## Observability (OpenTelemetry)\n\nWunderland supports opt-in OpenTelemetry (OTEL) export for auditing.\n\n- Enable via \`agent.config.json\`: set \`observability.otel.enabled=true\`.\n- Configure exporters via OTEL env vars in \`.env\` (see \`.env.example\`).\n\n## Skills\n\nAdd custom SKILL.md files to the \`skills/\` directory.\nEnable curated skills with: \`wunderland skills enable <name>\`\n`,
    'utf8',
  );

  // ── Output ─────────────────────────────────────────────────────────────
  fmt.section('Project Initialized');
  fmt.kvPair('Directory', accent(targetDir));
  fmt.kvPair('Seed ID', String(config.seedId));
  fmt.kvPair('Display Name', String(config.displayName));

  if (llmProvider) {
    fmt.kvPair('LLM Provider', accent(llmProvider));
    fmt.kvPair('Model', accent(llmModel || 'default'));
  }

  if (agentPreset) {
    fmt.kvPair('Preset', accent(agentPreset.id));
    fmt.kvPair('Security Tier', accent(agentPreset.securityTier));
    if (agentPreset.suggestedSkills.length > 0) {
      fmt.kvPair('Skills', agentPreset.suggestedSkills.join(', '));
    }
    if (agentPreset.suggestedChannels.length > 0) {
      fmt.kvPair('Channels', agentPreset.suggestedChannels.join(', '));
    }
    const presetExtensions = (agentPreset as any)?.suggestedExtensions;
    if (presetExtensions) {
      const extensionParts: string[] = [];
      if (presetExtensions.tools?.length) extensionParts.push(`tools: ${presetExtensions.tools.join(', ')}`);
      if (presetExtensions.voice?.length) extensionParts.push(`voice: ${presetExtensions.voice.join(', ')}`);
      if (presetExtensions.productivity?.length) extensionParts.push(`productivity: ${presetExtensions.productivity.join(', ')}`);
      if (extensionParts.length > 0) {
        fmt.kvPair('Extensions', extensionParts.join('; '));
      }
    }
  } else {
    const presetKey = presetFlag?.toUpperCase().replace(/-/g, '_');
    if (presetKey && hexacoValues) {
      const preset = PERSONALITY_PRESETS.find((p) => p.id === presetKey);
      fmt.kvPair('Personality', preset ? preset.label : presetKey);
    }
    if (securityTierName && tierConfig) {
      fmt.kvPair('Security Tier', accent(tierConfig.displayName));
      fmt.kvPair('', dim(tierConfig.description));
    }
  }

  fmt.kvPair('Skills Dir', dim('./skills'));
  fmt.blank();

  if (wroteEnv) {
    fmt.note(`Next: ${sColor(`cd ${dirName}`)} && ${sColor('wunderland start')}`);
  } else {
    fmt.note(`Next: ${sColor(`cd ${dirName}`)} && ${sColor('cp .env.example .env')} && ${sColor('wunderland start')}`);
  }
  fmt.blank();
}
