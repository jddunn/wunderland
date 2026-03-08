/**
 * @fileoverview `wunderland init <dir>` — scaffold a new Wunderbot project.
 * @module wunderland/cli/commands/init
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { PERSONALITY_PRESETS } from '../constants.js';
import { accent, success as sColor, warn as wColor, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { HEXACO_PRESETS } from '../../core/WunderlandSeed.js';
import { PresetLoader, type AgentPreset } from '../../core/PresetLoader.js';
import { isValidSecurityTier, getSecurityTier } from '../../security/SecurityTiers.js';
import type { SecurityTierName } from '../../security/SecurityTiers.js';
import { loadDotEnvIntoProcessUpward, mergeEnv } from '../config/env-manager.js';
import { runInitLlmStep } from '../wizards/init-llm-step.js';
import { buildAgentConfig, writeAgentScaffold } from '../helpers/build-agent-scaffold.js';

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
  const sealedPath = path.join(targetDir, 'sealed.json');

  if (existsSync(sealedPath)) {
    fmt.errorBlock(
      'Refusing to overwrite sealed agent',
      `${sealedPath} exists.\nThis agent is sealed and should be treated as immutable.`,
    );
    process.exitCode = 1;
    return;
  }

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

  // ── Resolve personality from preset ──────────────────────────────────────
  let personalityTraits: Record<string, number> | undefined;
  if (agentPreset) {
    const t = agentPreset.hexacoTraits;
    personalityTraits = {
      honesty: t.honesty,
      emotionality: t.emotionality,
      extraversion: t.extraversion,
      agreeableness: t.agreeableness,
      conscientiousness: t.conscientiousness,
      openness: t.openness,
    };
  } else if (hexacoValues) {
    personalityTraits = {
      honesty: hexacoValues.honesty_humility,
      emotionality: hexacoValues.emotionality,
      extraversion: hexacoValues.extraversion,
      agreeableness: hexacoValues.agreeableness,
      conscientiousness: hexacoValues.conscientiousness,
      openness: hexacoValues.openness,
    };
  }

  // ── Security tier ────────────────────────────────────────────────────────
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

  // ── Interactive LLM setup ──────────────────────────────────────────────
  const nonInteractive = _globals.yes || _globals.quiet || !process.stdin.isTTY || !process.stdout.isTTY;
  const skipKeys = flags['skip-keys'] === true || _globals.quiet;
  let llmProvider: string | undefined;
  let llmModel: string | undefined;
  let llmAuthMethod: 'api-key' | 'oauth' | undefined;
  let wroteEnv = false;
  const envData: Record<string, string> = {};

  if (!skipKeys) {
    const llmResult = await runInitLlmStep({ nonInteractive });
    if (llmResult) {
      llmProvider = llmResult.llmProvider;
      llmModel = llmResult.llmModel;
      llmAuthMethod = llmResult.llmAuthMethod;

      Object.assign(envData, llmResult.apiKeys);
      if (llmResult.llmModel) envData['OPENAI_MODEL'] = llmResult.llmModel;
      envData['PORT'] = '3777';
      wroteEnv = Object.keys(llmResult.apiKeys).length > 0;

      // Also save to global ~/.wunderland/.env
      await mergeEnv(llmResult.apiKeys, _globals.config);

      // ── Optional GitHub PAT ──────────────────────────────────────────────
      if (!nonInteractive) {
        const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
        if (!ghToken) {
          const clack = await import('@clack/prompts');
          const wantGithub = await clack.confirm({
            message: 'Add a GitHub Personal Access Token? (enables repo search, issues, PRs)',
            initialValue: false,
          });
          if (!clack.isCancel(wantGithub) && wantGithub) {
            const token = await clack.password({ message: 'GitHub PAT:' });
            if (!clack.isCancel(token) && token) {
              envData['GITHUB_TOKEN'] = String(token);
            }
          }
        }
      }
    }
  }

  // ── Build config ───────────────────────────────────────────────────────
  const { config } = buildAgentConfig({
    agentName: dirName,
    llmProvider,
    llmModel,
    llmAuthMethod,
    personalityTraits,
    securityTierName,
    agentPreset: agentPreset ? {
      name: agentPreset.name,
      description: agentPreset.description,
      hexacoTraits: agentPreset.hexacoTraits as unknown as Record<string, number>,
      securityTier: agentPreset.securityTier,
      suggestedSkills: agentPreset.suggestedSkills,
      suggestedChannels: agentPreset.suggestedChannels,
      suggestedExtensions: (agentPreset as any).suggestedExtensions,
      extensionOverrides: (agentPreset as any).extensionOverrides,
      toolAccessProfile: (agentPreset as any).toolAccessProfile,
      id: agentPreset.id,
    } : undefined,
  });

  // ── Write scaffold files ──────────────────────────────────────────────
  await writeAgentScaffold({
    targetDir,
    config,
    envData,
    agentName: dirName,
    writeEnv: wroteEnv,
    personaMd: agentPreset?.persona,
  });

  // ── README.md (init-specific) ─────────────────────────────────────────
  await writeFile(
    path.join(targetDir, 'README.md'),
    `# ${config.displayName}\n\nScaffolded by the Wunderland CLI.\n\n## Run\n\n\`\`\`bash\n${wroteEnv ? '' : 'cp .env.example .env\n'}wunderland start\n\`\`\`\n\nAgent server:\n- GET http://localhost:3777/health\n- POST http://localhost:3777/chat { "message": "Hello", "sessionId": "local" }\n- HITL UI: http://localhost:3777/hitl\n\nNotes:\n- \`wunderland start\` prints an \`HITL Secret\` on startup. Paste it into the HITL UI, or run: \`wunderland hitl watch --server http://localhost:3777 --secret <token>\`.\n- Approvals are controlled by \`executionMode\` in \`agent.config.json\`:\n  - \`human-dangerous\`: approve Tier 3 tools only\n  - \`human-all\`: approve every tool call\n  - \`autonomous\` (or \`wunderland start --auto-approve-tools\`): auto-approve everything\n- Optional: set \`hitl.turnApprovalMode\` to \`after-each-round\` to require per-round checkpoints.\n- Disable shell safety checks with: \`wunderland start --dangerously-skip-command-safety\` or \`wunderland start --dangerously-skip-permissions\`.\n\n## Observability (OpenTelemetry)\n\nWunderland supports opt-in OpenTelemetry (OTEL) export for auditing.\n\n- Enable via \`agent.config.json\`: set \`observability.otel.enabled=true\`.\n- Configure exporters via OTEL env vars in \`.env\` (see \`.env.example\`).\n\n## Skills\n\nAdd custom SKILL.md files to the \`skills/\` directory.\nEnable curated skills with: \`wunderland skills enable <name>\`\n`,
    'utf8',
  );

  // ── Output ─────────────────────────────────────────────────────────────
  const resolvedTierName: SecurityTierName = securityTierName ?? 'permissive';
  const tierConfig = getSecurityTier(resolvedTierName);

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
    fmt.kvPair('Security Tier', accent(tierConfig.displayName));
    fmt.kvPair('', dim(tierConfig.description));
    const executionMode = config.executionMode as string;
    fmt.kvPair('Execution Mode', executionMode === 'autonomous' ? wColor(executionMode) : sColor(executionMode));
    fmt.kvPair('Tool Profile', accent(config.toolAccessProfile as string));
    const permSet = config.permissionSet as string;
    fmt.kvPair('CLI Execution', permSet === 'autonomous' ? wColor('enabled') : dim('disabled'));
  }

  fmt.kvPair('Skills Dir', dim('./skills'));
  fmt.blank();

  if (wroteEnv) {
    fmt.note(`Next: ${sColor(`cd ${dirName}`)} && ${sColor('wunderland start')}`);
  } else {
    fmt.note(`Next: ${sColor(`cd ${dirName}`)} && ${sColor('cp .env.example .env')} && ${sColor('wunderland start')}`);
  }
  fmt.note(`Restrict permissions: ${dim('wunderland init --security-tier=balanced')}`);
  fmt.blank();
}
