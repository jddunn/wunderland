/**
 * @fileoverview Config loading and inline onboarding for `wunderland start`.
 * Extracted from start.ts — handles config resolution, environment loading,
 * seal verification, and interactive first-time setup.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../../types.js';
import { accent } from '../../ui/theme.js';
import * as fmt from '../../ui/format.js';
import { loadDotEnvIntoProcessUpward, mergeEnv } from '../../config/env-manager.js';
import { loadConfig } from '../../config/config-manager.js';
import { buildAgentConfig, writeAgentScaffold, toDisplayName } from '../../helpers/build-agent-scaffold.js';
import { runInitLlmStep } from '../../wizards/init-llm-step.js';
import { verifySealedConfig } from '../../seal-utils.js';
import { PERSONALITY_PRESETS } from '../../constants.js';
import { success as sColor } from '../../ui/theme.js';

export interface ConfigLoaderContext {
  flags: Record<string, string | boolean>;
  globals: GlobalFlags;
  cfg: any;
  configRaw: string;
  globalConfig: any;
  configDir: string;
}

/**
 * Load and validate the agent config, running inline onboarding if needed.
 * Sets ctx.cfg, ctx.configRaw, ctx.globalConfig, ctx.configDir.
 * Returns false if we should abort (error/cancel). Returns true if config was loaded successfully.
 */
export async function loadAndValidateConfig(
  ctx: ConfigLoaderContext,
): Promise<boolean> {
  const flags = ctx.flags;
  const globals = ctx.globals;
  const configPath = typeof flags['config'] === 'string'
    ? path.resolve(process.cwd(), flags['config'])
    : path.resolve(process.cwd(), 'agent.config.json');

  // Load environment
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });
  const globalConfig = await loadConfig(globals.config);
  ctx.globalConfig = globalConfig;

  let configRaw = '';
  let cfg: any;

  if (!existsSync(configPath)) {
    // ── Inline onboarding for first-time users ────────────────────────────
    const nonInteractive = globals.quiet || globals.yes || !process.stdin.isTTY || !process.stdout.isTTY;
    if (nonInteractive) {
      fmt.errorBlock(
        'Missing config file',
        `${configPath}\n\nRun: ${accent('wunderland init <dir>')}`,
      );
      process.exitCode = 1;
      return false;
    }

    const p = await import('@clack/prompts');
    fmt.blank();
    p.intro(accent('Quick Setup'));
    fmt.note('No agent.config.json found in this directory.');

    const shouldSetup = await p.confirm({
      message: `Create an agent configuration here?`,
      initialValue: true,
    });

    if (p.isCancel(shouldSetup) || !shouldSetup) {
      fmt.errorBlock(
        'Missing config file',
        `Run ${accent('wunderland init my-agent')} to scaffold a new agent project.`,
      );
      process.exitCode = 1;
      return false;
    }

    // 1. Agent name
    const dirBasename = path.basename(process.cwd());
    const agentName = await p.text({
      message: 'What should your agent be called?',
      placeholder: toDisplayName(dirBasename),
      defaultValue: toDisplayName(dirBasename),
      validate: (val) => (!val.trim() ? 'Name cannot be empty' : undefined),
    });
    if (p.isCancel(agentName)) { p.cancel('Setup cancelled.'); return false; }

    // 2. LLM provider + API key + model
    const llmResult = await runInitLlmStep({ nonInteractive: false });
    if (!llmResult) { p.cancel('Setup cancelled.'); return false; }

    // 3. Personality preset
    let personalityPresetKey: string | undefined;
    if (globalConfig.personalityPreset) {
      personalityPresetKey = globalConfig.personalityPreset;
    } else {
      const presetOptions = [
        { value: 'balanced', label: 'Balanced (default)', hint: 'neutral across all traits' },
        ...PERSONALITY_PRESETS.map((pr) => ({
          value: pr.id, label: pr.label, hint: pr.desc,
        })),
      ];
      const selected = await p.select({
        message: 'Choose a personality preset:',
        options: presetOptions,
      });
      if (p.isCancel(selected)) { p.cancel('Setup cancelled.'); return false; }
      if (selected !== 'balanced') {
        personalityPresetKey = selected as string;
      }
    }

    // 4. Build config + write files
    const { config: builtConfig } = buildAgentConfig({
      agentName: agentName as string,
      llmProvider: llmResult.llmProvider,
      llmModel: llmResult.llmModel,
      llmAuthMethod: llmResult.llmAuthMethod,
      personalityPresetKey,
    });

    const envData: Record<string, string> = { ...llmResult.apiKeys };
    if (llmResult.llmModel) envData['OPENAI_MODEL'] = llmResult.llmModel;
    envData['PORT'] = String(process.env.PORT || '3777');

    await writeAgentScaffold({
      targetDir: process.cwd(),
      config: builtConfig,
      envData,
      agentName: agentName as string,
      writeEnv: Object.keys(llmResult.apiKeys).length > 0,
      skipExisting: true,
    });

    // Save keys to global ~/.wunderland/.env
    if (Object.keys(llmResult.apiKeys).length > 0) {
      await mergeEnv(llmResult.apiKeys, globals.config);
    }

    // Reload env so the just-written .env is available
    await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

    p.outro(sColor('Agent configured! Starting server...'));
    fmt.blank();

    cfg = builtConfig;
    configRaw = JSON.stringify(builtConfig, null, 2);
  } else {
    // ── Load existing config from disk ────────────────────────────────────
    const configDir = path.dirname(configPath);
    const sealedPath = path.join(configDir, 'sealed.json');

    try {
      configRaw = await readFile(configPath, 'utf8');
    } catch (err) {
      fmt.errorBlock('Read failed', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return false;
    }

    if (existsSync(sealedPath)) {
      let sealedRaw = '';
      try {
        sealedRaw = await readFile(sealedPath, 'utf8');
      } catch (err) {
        fmt.errorBlock('Read failed', err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return false;
      }

      const verification = verifySealedConfig({ configRaw, sealedRaw });
      if (!verification.ok) {
        fmt.errorBlock(
          'Seal verification failed',
          `${verification.error || 'Verification failed.'}\nRun: ${accent('wunderland verify-seal')}`,
        );
        process.exitCode = 1;
        return false;
      }
      if (!verification.signaturePresent) {
        fmt.warning('Sealed config has no signature (hash-only verification).');
      }
    }

    try {
      cfg = JSON.parse(configRaw);
    } catch (err) {
      fmt.errorBlock(
        'Invalid config file',
        err instanceof Error ? err.message : String(err),
      );
      process.exitCode = 1;
      return false;
    }

    ctx.configDir = configDir;
  }

  ctx.cfg = cfg;
  ctx.configRaw = configRaw;

  // For the onboarding path, configDir is cwd
  if (!ctx.configDir) {
    ctx.configDir = path.dirname(
      typeof flags['config'] === 'string'
        ? path.resolve(process.cwd(), flags['config'])
        : path.resolve(process.cwd(), 'agent.config.json'),
    );
  }

  return true;
}
