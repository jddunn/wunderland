/**
 * @fileoverview Lightweight LLM provider/key/model prompt for `wunderland init`.
 * Detects existing env vars, confirms or overrides, selects provider + model.
 * @module wunderland/cli/wizards/init-llm-step
 */

import * as p from '@clack/prompts';
import { LLM_PROVIDERS } from '../constants.js';
import { accent } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

export interface InitLlmResult {
  /** Collected API keys: envVar → value */
  apiKeys: Record<string, string>;
  /** Selected LLM provider ID (e.g., 'openai') */
  llmProvider: string;
  /** Selected model ID (e.g., 'gpt-4o-mini') */
  llmModel: string;
}

/**
 * Interactive LLM configuration step for `wunderland init`.
 * Returns collected keys + provider/model, or `null` if the user cancelled.
 */
export async function runInitLlmStep(): Promise<InitLlmResult | null> {
  fmt.section('LLM Configuration');

  const apiKeys: Record<string, string> = {};
  let selectedProvider: string | undefined;

  // ── Detect existing env vars ───────────────────────────────────────────────
  const detected: { id: string; label: string; envVar: string; value: string }[] = [];
  for (const prov of LLM_PROVIDERS) {
    if (!prov.envVar) continue; // Ollama — no key needed
    const val = process.env[prov.envVar];
    if (val) {
      detected.push({ id: prov.id, label: prov.label, envVar: prov.envVar, value: val });
    }
  }

  if (detected.length > 0) {
    fmt.note('Detected API keys in environment:');
    fmt.blank();
    for (const d of detected) {
      fmt.maskedKey(d.label, d.value);
    }
    fmt.blank();

    const useDetected = await p.confirm({
      message: `Use detected key${detected.length > 1 ? 's' : ''}?`,
      initialValue: true,
    });

    if (p.isCancel(useDetected)) return null;

    if (useDetected) {
      for (const d of detected) {
        apiKeys[d.envVar] = d.value;
        if (!selectedProvider) selectedProvider = d.id;
      }
    }
  }

  // ── Prompt for key if none collected ───────────────────────────────────────
  if (Object.keys(apiKeys).length === 0) {
    const providerOptions = LLM_PROVIDERS.map((prov) => ({
      value: prov.id,
      label: prov.label,
      hint: prov.id === 'ollama' ? 'local, no key needed' : undefined,
    }));

    const chosenProvider = await p.select({
      message: 'Which LLM provider do you want to use?',
      options: providerOptions,
    });

    if (p.isCancel(chosenProvider)) return null;
    selectedProvider = chosenProvider as string;

    const provDef = LLM_PROVIDERS.find((p) => p.id === selectedProvider);
    if (provDef && provDef.envVar) {
      const key = await p.password({
        message: `${provDef.label} API Key:`,
        validate: (val: string) => {
          if (!val.trim()) return `${provDef.label} key is required`;
          return undefined;
        },
      });

      if (p.isCancel(key)) return null;
      if (key) apiKeys[provDef.envVar] = key as string;

      fmt.note(`Get one at: ${fmt.link(provDef.docsUrl)}`);
    }
  }

  if (!selectedProvider) {
    // Fallback — shouldn't happen, but be safe
    selectedProvider = 'openai';
  }

  // ── Select default provider if multiple keys ──────────────────────────────
  if (detected.length > 1 && Object.keys(apiKeys).length > 1) {
    const providerChoices = detected
      .filter((d) => d.envVar in apiKeys)
      .map((d, i) => ({
        value: d.id,
        label: d.label,
        hint: i === 0 ? 'recommended' : undefined,
      }));

    if (providerChoices.length > 1) {
      const picked = await p.select({
        message: 'Default LLM provider:',
        options: providerChoices,
      });

      if (!p.isCancel(picked)) {
        selectedProvider = picked as string;
      }
    }
  }

  // ── Select model ──────────────────────────────────────────────────────────
  let selectedModel = '';
  const provDef = LLM_PROVIDERS.find((p) => p.id === selectedProvider);

  if (provDef && provDef.models.length > 0) {
    const modelOptions = provDef.models.map((m, i) => ({
      value: m as string,
      label: m as string,
      hint: i === 0 ? 'recommended' : undefined,
    }));

    const model = await p.select({
      message: 'Default model:',
      options: modelOptions,
    });

    if (!p.isCancel(model)) {
      selectedModel = model as string;
    }
  }

  if (!selectedModel && provDef) {
    selectedModel = provDef.models[0] as string || 'gpt-4o-mini';
  }

  fmt.blank();
  fmt.ok(`Provider: ${accent(selectedProvider)}  Model: ${accent(selectedModel)}`);

  return {
    apiKeys,
    llmProvider: selectedProvider,
    llmModel: selectedModel,
  };
}
