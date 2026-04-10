// @ts-nocheck
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
import { glyphs } from '../ui/glyphs.js';
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

  // NOTE: Directory is NOT created here — we defer mkdir until after all
  // interactive prompts complete so that CTRL+C doesn't leave a partial folder.

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
  const forceLocal = flags['local'] === true;
  let llmProvider: string | undefined;
  let llmModel: string | undefined;
  let llmAuthMethod: 'api-key' | 'oauth' | undefined;
  let ollamaConfig: { numCtx?: number; numGpu?: number; baseUrl?: string } | undefined;
  let wroteEnv = false;
  let initCancelled = false;
  const envData: Record<string, string> = {};

  const handleSigint = () => {
    initCancelled = true;
  };
  process.on('SIGINT', handleSigint);

  try {
    if (!skipKeys) {
      let llmResult: Awaited<ReturnType<typeof runInitLlmStep>> | null = null;

      if (forceLocal) {
        // --local flag: skip all prompts, auto-setup Ollama end-to-end
        fmt.blank();
        fmt.section('Local Agent Setup (Ollama)');
        const { runOllamaAutoSetup } = await import('../ollama/ollama-manager.js');
        try {
          const result = await runOllamaAutoSetup();
          llmResult = {
            apiKeys: {},
            llmProvider: 'ollama',
            llmModel: result.model,
            ollamaConfig: {
              numCtx: result.numCtx,
              numGpu: result.numGpu,
              baseUrl: result.baseUrl !== 'http://localhost:11434' ? result.baseUrl : undefined,
            },
          };
        } catch (err) {
          fmt.fail(err instanceof Error ? err.message : 'Ollama auto-setup failed');
          return;
        }
      } else {
        llmResult = await runInitLlmStep({ nonInteractive });
        if (!llmResult && !nonInteractive) {
          // User cancelled the LLM setup (CTRL+C or explicit cancel).
          // Don't create a partial agent folder.
          fmt.blank();
          fmt.warning('Init cancelled — no agent folder was created.');
          return;
        }
      }

      if (initCancelled) {
        fmt.blank();
        fmt.warning('Init cancelled — no agent folder was created.');
        return;
      }

      if (llmResult) {
        llmProvider = llmResult.llmProvider;
        llmModel = llmResult.llmModel;
        llmAuthMethod = llmResult.llmAuthMethod;
        ollamaConfig = llmResult.ollamaConfig;

        Object.assign(envData, llmResult.apiKeys);
        if (llmResult.llmModel) envData['OPENAI_MODEL'] = llmResult.llmModel;
        envData['PORT'] = '3777';
        wroteEnv = Object.keys(llmResult.apiKeys).length > 0;

        // ── Optional GitHub PAT ──────────────────────────────────────────────
        if (!nonInteractive && !forceLocal) {
          const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
          if (!ghToken) {
            const clack = await import('@clack/prompts');
            const wantGithub = await clack.confirm({
              message: 'Add a GitHub Personal Access Token? (enables repo search, issues, PRs)',
              initialValue: false,
            });
            if (clack.isCancel(wantGithub) || initCancelled) {
              fmt.blank();
              fmt.warning('Init cancelled — no agent folder was created.');
              return;
            }
            if (wantGithub) {
              const token = await clack.password({ message: 'GitHub PAT:' });
              if (clack.isCancel(token) || initCancelled) {
                fmt.blank();
                fmt.warning('Init cancelled — no agent folder was created.');
                return;
              }
              if (token) {
                envData['GITHUB_TOKEN'] = String(token);
              }
            }
          }
        }

        if (initCancelled) {
          fmt.blank();
          fmt.warning('Init cancelled — no agent folder was created.');
          return;
        }

        // Persist provider credentials only after the prompt flow completes.
        await mergeEnv(llmResult.apiKeys, _globals.config);

        if (llmResult.llmProvider === 'ollama' && llmResult.ollamaConfig) {
          const { updateConfig } = await import('../config/config-manager.js');
          await updateConfig({
            llmProvider: 'ollama',
            llmModel: llmResult.llmModel,
            ollama: llmResult.ollamaConfig,
          }, _globals.config);
        }
      }
    }
  } finally {
    process.removeListener('SIGINT', handleSigint);
  }

  // ── Build config ───────────────────────────────────────────────────────
  const { config } = buildAgentConfig({
    agentName: dirName,
    llmProvider,
    llmModel,
    llmAuthMethod,
    personalityTraits,
    securityTierName,
    ollamaConfig,
    agentPreset: agentPreset ? {
      name: agentPreset.name,
      description: agentPreset.description,
      hexacoTraits: agentPreset.hexacoTraits,
      securityTier: agentPreset.securityTier,
      suggestedSkills: agentPreset.suggestedSkills,
      suggestedChannels: agentPreset.suggestedChannels,
      suggestedExtensions: (agentPreset as any).suggestedExtensions,
      extensionOverrides: (agentPreset as any).extensionOverrides,
      toolAccessProfile: (agentPreset as any).toolAccessProfile,
      discovery: (agentPreset as any).discovery,
      rag: (agentPreset as any).rag,
      persona: agentPreset.persona,
      id: agentPreset.id,
    } : undefined,
  });

  // ── Create directory (deferred from earlier to avoid partial state on CTRL+C)
  await mkdir(targetDir, { recursive: true });

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
    `# ${config.displayName}\n\nScaffolded by the Wunderland CLI.\n\n## Run\n\n\`\`\`bash\n${wroteEnv ? '' : 'cp .env.example .env\n'}wunderland start\n\`\`\`\n\nAgent server:\n- GET http://localhost:3777/health\n- POST http://localhost:3777/chat { "message": "Hello", "sessionId": "local" }\n- HITL UI: http://localhost:3777/hitl\n\nNotes:\n- \`wunderland start\` prints an \`HITL Secret\` on startup. Paste it into the HITL UI, or run: \`wunderland hitl watch --server http://localhost:3777 --secret <token>\`.\n- Approvals are controlled by \`executionMode\` in \`agent.config.json\`:\n  - \`human-dangerous\`: approve Tier 3 tools only\n  - \`human-all\`: approve every tool call\n  - \`autonomous\` (or \`wunderland start --auto-approve-tools\`): auto-approve everything\n- Optional: set \`hitl.turnApprovalMode\` to \`after-each-round\` to require per-round checkpoints.\n- Disable shell safety checks with: \`wunderland start --dangerously-skip-command-safety\` or \`wunderland start --dangerously-skip-permissions\`.\n\n## Observability (OpenTelemetry)\n\nWunderland supports opt-in OpenTelemetry (OTEL) export for auditing.\n\n- Enable via \`agent.config.json\`: set \`observability.otel.enabled=true\`.\n- Configure exporters via OTEL env vars in \`.env\` (see \`.env.example\`).\n- Session text logs are enabled by default for scaffolded agents and land in \`./logs/YYYY-MM-DD/*.log\`.\n- Disable them with \`observability.textLogs.enabled=false\` in \`agent.config.json\`.\n\n## Skills\n\nAdd custom SKILL.md files to the \`skills/\` directory.\nEnable curated skills with: \`wunderland skills enable <name>\`\n`,
    'utf8',
  );

  // ── Output ─────────────────────────────────────────────────────────────
  const resolvedTierName: SecurityTierName = securityTierName ?? 'permissive';
  const tierConfig = getSecurityTier(resolvedTierName);
  const g = glyphs();

  const summaryLines: (string | null)[] = [
    `Agent:     ${accent(String(config.displayName))}`,
    `Directory: ${dim(targetDir)}`,
    `Seed ID:   ${String(config.seedId)}`,
    llmProvider ? `Provider:  ${accent(llmProvider)}` : null,
    llmModel ? `Model:     ${accent(llmModel)}` : null,
  ];

  if (agentPreset) {
    summaryLines.push(`Preset:    ${accent(agentPreset.id)}`);
    summaryLines.push(`Security:  ${accent(agentPreset.securityTier)}`);
    if (agentPreset.suggestedSkills.length > 0) {
      summaryLines.push(`Skills:    ${agentPreset.suggestedSkills.join(', ')}`);
    }
  } else {
    const presetKey = presetFlag?.toUpperCase().replace(/-/g, '_');
    if (presetKey && hexacoValues) {
      const preset = PERSONALITY_PRESETS.find((p) => p.id === presetKey);
      summaryLines.push(`Personality: ${preset ? preset.label : presetKey}`);
    }
    summaryLines.push(`Security:  ${accent(tierConfig.displayName)}`);
    const executionMode = config.executionMode as string;
    summaryLines.push(`Execution: ${executionMode === 'autonomous' ? wColor(executionMode) : sColor(executionMode)}`);
  }

  const nextCmd = wroteEnv
    ? `cd ${dirName} && wunderland start`
    : `cd ${dirName} && cp .env.example .env && wunderland start`;
  summaryLines.push('', `Next: ${sColor(nextCmd)}`);

  fmt.blank();
  fmt.panel({
    title: `${g.ok} Agent Scaffolded`,
    style: 'success',
    content: summaryLines.filter(Boolean).join('\n'),
  });
  fmt.blank();
}
