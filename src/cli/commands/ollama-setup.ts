/**
 * @fileoverview `wunderland ollama-setup` — Interactive one-command setup for
 * offline-first agents using Ollama. Detects hardware, installs Ollama if
 * missing (macOS/Linux), recommends models, pulls them, and configures the
 * agent to use the local Ollama provider automatically.
 *
 * Usage:
 *   wunderland ollama-setup             # interactive full setup
 *   wunderland ollama-setup --yes       # non-interactive (auto-accept recommendations)
 *   wunderland ollama-setup --tier mid  # force a specific tier
 *   wunderland ollama-setup --skip-pull # detect + configure but don't download models
 */

import chalk from 'chalk';
import { createSpinner } from 'nanospinner';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

import {
  autoConfigureOllama,
  pullModel,
  detectOllamaInstall,
  type ModelRecommendation,
  type OllamaAutoConfigResult,
} from '../ollama/ollama-manager.js';
import { loadConfig, updateConfig } from '../config/config-manager.js';
import { ok, fail, note, warning, blank, section } from '../ui/format.js';
import { accent, dim, success as sColor } from '../ui/theme.js';
import type { GlobalFlags } from '../types.js';

const execFileAsync = promisify(execFile);

// ── Ollama installation helpers ─────────────────────────────────────────

async function installOllamaMac(): Promise<boolean> {
  const spinner = createSpinner('Installing Ollama via brew...').start();
  try {
    // Check if brew exists
    await execFileAsync('which', ['brew']);
    const child = spawn('brew', ['install', 'ollama'], { stdio: 'inherit' });
    return new Promise((resolve) => {
      child.on('close', (code) => {
        if (code === 0) {
          spinner.success({ text: 'Ollama installed via Homebrew' });
          resolve(true);
        } else {
          spinner.error({ text: 'brew install ollama failed' });
          resolve(false);
        }
      });
      child.on('error', () => {
        spinner.error({ text: 'Could not run brew' });
        resolve(false);
      });
    });
  } catch {
    spinner.error({ text: 'Homebrew not found' });
    note(`Install Ollama manually from ${accent('https://ollama.ai/')}`);
    return false;
  }
}

async function installOllamaLinux(): Promise<boolean> {
  const spinner = createSpinner('Installing Ollama via curl...').start();
  try {
    const child = spawn('sh', ['-c', 'curl -fsSL https://ollama.ai/install.sh | sh'], {
      stdio: 'inherit',
    });
    return new Promise((resolve) => {
      child.on('close', (code) => {
        if (code === 0) {
          spinner.success({ text: 'Ollama installed' });
          resolve(true);
        } else {
          spinner.error({ text: 'Ollama install script failed' });
          resolve(false);
        }
      });
      child.on('error', () => {
        spinner.error({ text: 'Could not run install script' });
        resolve(false);
      });
    });
  } catch {
    spinner.error({ text: 'Installation failed' });
    return false;
  }
}

// ── Simple readline prompt (no external dep) ────────────────────────────

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Main command ────────────────────────────────────────────────────────

export default async function ollamaSetup(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const autoYes = globals.yes || flags.yes === true;
  const skipPull = flags['skip-pull'] === true;
  const forceTier = typeof flags.tier === 'string' ? flags.tier : null;

  section('Ollama Setup — Offline-First Agent Configuration');
  blank();
  note('This command will:');
  note('  1. Detect or install Ollama on your system');
  note('  2. Analyze your hardware (RAM, GPU) for optimal model selection');
  note('  3. Download recommended models for your agent');
  note('  4. Configure wunderland to use Ollama as the default LLM provider');
  blank();

  // Step 1: Check if Ollama is installed, offer to install if not
  let binaryPath = await detectOllamaInstall();

  if (!binaryPath) {
    warning('Ollama is not installed on this system.');
    const platform = os.platform();

    if (platform === 'darwin' || platform === 'linux') {
      const shouldInstall = autoYes || (await prompt(
        `  Install Ollama automatically? (${platform === 'darwin' ? 'via Homebrew' : 'via curl'}) [Y/n] `
      )).toLowerCase() !== 'n';

      if (shouldInstall) {
        const success = platform === 'darwin'
          ? await installOllamaMac()
          : await installOllamaLinux();

        if (!success) {
          fail('Could not install Ollama automatically.');
          note(`Please install manually from ${accent('https://ollama.ai/')} and re-run this command.`);
          return;
        }

        binaryPath = await detectOllamaInstall();
        if (!binaryPath) {
          fail('Ollama binary not found after installation. Check your PATH.');
          return;
        }
      } else {
        note(`Install Ollama from ${accent('https://ollama.ai/')} and re-run this command.`);
        return;
      }
    } else {
      note(`Please install Ollama from ${accent('https://ollama.ai/')} for your platform.`);
      return;
    }
  }

  blank();

  // Step 2: Run auto-configuration (detect, start server, analyze hardware, recommend)
  let result: OllamaAutoConfigResult;
  try {
    result = await autoConfigureOllama();
  } catch (err) {
    fail(err instanceof Error ? err.message : 'Ollama auto-configuration failed');
    return;
  }

  blank();

  // Step 3: Optionally override tier
  let recommendation = result.recommendation;
  if (forceTier && ['low', 'mid', 'high'].includes(forceTier)) {
    const { recommendModels, detectSystemSpecs } = await import('../ollama/ollama-manager.js');
    const specs = await detectSystemSpecs();
    // Override tier by simulating different RAM levels
    const fakeSpecs = {
      ...specs,
      totalMemoryGB: forceTier === 'low' ? 4 : forceTier === 'mid' ? 12 : 32,
      hasGpu: forceTier === 'high',
    };
    recommendation = recommendModels(fakeSpecs);
    note(`Tier overridden to ${accent(forceTier)}`);
  }

  // Step 4: Pull models
  const modelsToInstall = [
    ...new Set([recommendation.router, recommendation.primary, recommendation.auditor]),
  ];
  const installedNames = new Set(result.localModels.map((m) => m.name));
  const missingModels = modelsToInstall.filter((m) => !installedNames.has(m));

  if (missingModels.length > 0 && !skipPull) {
    blank();
    section('Model Download');
    note(`Need to pull ${missingModels.length} model(s): ${missingModels.map(accent).join(', ')}`);

    const shouldPull = autoYes || (await prompt(
      '  Download recommended models now? [Y/n] '
    )).toLowerCase() !== 'n';

    if (shouldPull) {
      for (const model of missingModels) {
        blank();
        const spinner = createSpinner(`Pulling ${accent(model)}...`).start();
        try {
          spinner.stop(); // stop spinner before streaming progress
          note(`Downloading ${accent(model)}...`);
          await pullModel(model);
          ok(`${model} ready`);
        } catch (err) {
          fail(`Failed to pull ${model}: ${err instanceof Error ? err.message : String(err)}`);
          note('You can pull it manually later with: ollama pull ' + model);
        }
      }
    } else {
      note('Skipping model download. Pull them later with:');
      for (const m of missingModels) {
        note(`  ollama pull ${m}`);
      }
    }
  } else if (missingModels.length === 0) {
    ok('All recommended models are already installed locally');
  } else {
    note('Skipping model download (--skip-pull). Pull them later with:');
    for (const m of missingModels) {
      note(`  ollama pull ${m}`);
    }
  }

  // Step 5: Update wunderland config to use Ollama
  blank();
  section('Configuration');

  try {
    await updateConfig(
      {
        llmProvider: 'ollama',
        llmModel: recommendation.primary,
      },
      globals.config,
    );
    ok(`Default provider set to ${accent('ollama')}`);
    ok(`Default model set to ${accent(recommendation.primary)}`);
  } catch (err) {
    warning(`Could not update config: ${err instanceof Error ? err.message : String(err)}`);
    note('You can set it manually: wunderland config set llmProvider ollama');
  }

  // Summary
  blank();
  section('Setup Complete');
  blank();
  console.log(chalk.green('  ✓ ') + 'Ollama is installed and running');
  console.log(chalk.green('  ✓ ') + `Tier: ${chalk.bold(recommendation.tier)} — ${dim(recommendation.reason)}`);
  console.log(chalk.green('  ✓ ') + `Router:  ${accent(recommendation.router)}`);
  console.log(chalk.green('  ✓ ') + `Primary: ${accent(recommendation.primary)}`);
  console.log(chalk.green('  ✓ ') + `Auditor: ${accent(recommendation.auditor)}`);
  console.log(chalk.green('  ✓ ') + 'Provider configured: ' + sColor('ollama'));
  blank();
  note('Next steps:');
  note(`  ${accent('wunderland init my-agent --provider ollama')}  Create an offline agent`);
  note(`  ${accent('wunderland start')}                             Run your agent locally`);
  note(`  ${accent('wunderland chat')}                              Talk to your agent`);
  blank();
  note(`${dim('All inference stays on your machine. No API keys required. No data leaves your system.')}`);
}
