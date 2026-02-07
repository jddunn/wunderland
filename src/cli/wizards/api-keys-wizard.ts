/**
 * @fileoverview API keys wizard — LLM provider key collection.
 * @module wunderland/cli/wizards/api-keys-wizard
 */

import * as p from '@clack/prompts';
import type { WizardState } from '../types.js';
import { LLM_PROVIDERS } from '../constants.js';
import * as fmt from '../ui/format.js';

export async function runApiKeysWizard(state: WizardState): Promise<void> {
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

    // Check if already set in env
    const existing = process.env[provider.envVar];
    if (existing) {
      fmt.ok(`${provider.label}: already set in environment`);
      state.apiKeys[provider.envVar] = existing;
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
        value: m,
        label: m,
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
