/**
 * @fileoverview API keys wizard — LLM provider key collection.
 * @module wunderland/cli/wizards/api-keys-wizard
 */

import * as p from '@clack/prompts';
import chalk from 'chalk';
import type { WizardState } from '../types.js';
import { LLM_PROVIDERS } from '../constants.js';
import * as fmt from '../ui/format.js';
import { importEnvBlock } from '../config/env-manager.js';

export async function runApiKeysWizard(state: WizardState): Promise<void> {
  // ── .env paste import ──────────────────────────────────────────────────────
  const wantsPaste = await p.confirm({
    message: 'Would you like to paste a .env block with your API keys?\n  (This will auto-detect and import recognized keys)',
    initialValue: false,
  });

  if (!p.isCancel(wantsPaste) && wantsPaste) {
    const envText = await p.text({
      message: 'Paste your .env block below (press Enter twice when done):',
      placeholder: 'OPENAI_API_KEY=sk-...\nANTHROPIC_API_KEY=sk-ant-...',
      validate: (val: string) => {
        if (!val.trim()) return 'Please paste at least one KEY=VALUE line';
        return undefined;
      },
    });

    if (!p.isCancel(envText) && envText) {
      const result = await importEnvBlock(envText as string);

      // Display summary
      fmt.section('Import Summary');
      fmt.note(`${result.total} key${result.total !== 1 ? 's' : ''} parsed from input`);

      for (const detail of result.details) {
        switch (detail.action) {
          case 'imported':
            fmt.ok(`${chalk.bold(detail.key)}: imported`);
            // Also inject into state.apiKeys so downstream wizard steps see them
            state.apiKeys[detail.key] = '';  // mark as set (actual value is in .env)
            break;
          case 'updated':
            fmt.ok(`${chalk.bold(detail.key)}: updated (value changed)`);
            state.apiKeys[detail.key] = '';
            break;
          case 'skipped':
            fmt.skip(`${chalk.bold(detail.key)}: already set (same value)`);
            state.apiKeys[detail.key] = '';
            break;
          case 'unrecognized':
            fmt.warning(`${chalk.bold(detail.key)}: unrecognized key, skipped`);
            break;
        }
      }

      fmt.blank();
      if (result.imported > 0 || result.updated > 0) {
        fmt.ok(`${result.imported + result.updated} key${(result.imported + result.updated) !== 1 ? 's' : ''} written to ~/.wunderland/.env`);
      }
      if (result.unrecognized > 0) {
        fmt.note(`${result.unrecognized} unrecognized key${result.unrecognized !== 1 ? 's' : ''} were ignored`);
      }
      fmt.blank();
    }
  }

  // ── Provider selection & individual key prompts ────────────────────────────
  // Select providers
  const options = LLM_PROVIDERS.map((prov) => ({
    value: prov.id,
    label: prov.label,
    hint: prov.id === 'ollama' ? 'local, no key needed' : undefined,
  }));

  const selected = await p.multiselect({
    message: 'Which LLM providers do you want to use?',
    options,
    required: true,
    initialValues: ['openai'],
  });

  if (p.isCancel(selected)) return;

  const providers = selected as string[];

  // Collect keys for each provider
  for (const provId of providers) {
    const provider = LLM_PROVIDERS.find((p) => p.id === provId);
    if (!provider) continue;

    // Ollama doesn't need a key
    if (!provider.envVar) {
      state.llmProvider = state.llmProvider || provId;
      continue;
    }

    // Check if already set in env or imported via .env paste
    const existing = process.env[provider.envVar];
    const importedViaPaste = provider.envVar in state.apiKeys;
    if (existing || importedViaPaste) {
      const source = importedViaPaste ? 'imported from .env paste' : 'already set in environment';
      fmt.ok(`${provider.label}: ${source}`);
      if (existing) state.apiKeys[provider.envVar] = existing;
      state.llmProvider = state.llmProvider || provId;
      continue;
    }

    const apiKey = await p.password({
      message: `${provider.label} API Key:`,
      validate: (val: string) => {
        if (!val.trim()) return `${provider.label} key is required`;
        return undefined;
      },
    });

    if (p.isCancel(apiKey)) continue;
    if (apiKey) {
      state.apiKeys[provider.envVar] = apiKey as string;
      state.llmProvider = state.llmProvider || provId;
    }

    fmt.note(`Get one at: ${fmt.link(provider.docsUrl)}`);
  }

  // Select default model
  if (state.llmProvider) {
    const provider = LLM_PROVIDERS.find((p) => p.id === state.llmProvider);
    if (provider && provider.models.length > 0) {
      const modelOptions = provider.models.map((m, i) => ({
        value: m as string,
        label: m as string,
        hint: i === 0 ? 'recommended' : undefined,
      }));

      const model = await p.select({
        message: 'Default model:',
        options: modelOptions,
      });

      if (!p.isCancel(model)) {
        state.llmModel = model as string;
      }
    }
  }
}
