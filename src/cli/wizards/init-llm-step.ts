/**
 * @fileoverview Lightweight LLM provider/key/model prompt for `wunderland init`.
 * Detects existing env vars, confirms or overrides, selects provider + model.
 * @module wunderland/cli/wizards/init-llm-step
 */

import * as p from '@clack/prompts';
import { LLM_PROVIDERS } from '../constants.js';
import { accent } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

const TOOL_CALLING_PROVIDER_IDS = new Set(['openai', 'anthropic', 'openrouter', 'ollama']);
const SUPPORTED_LLM_PROVIDERS = LLM_PROVIDERS.filter((p) => TOOL_CALLING_PROVIDER_IDS.has(p.id));

export interface InitLlmResult {
  /** Collected API keys: envVar → value */
  apiKeys: Record<string, string>;
  /** Selected LLM provider ID (e.g., 'openai') */
  llmProvider: string;
  /** Selected model ID (e.g., 'gpt-4o-mini') */
  llmModel: string;
  /** Auth method: 'api-key' (default) or 'oauth' for subscription-based tokens. */
  llmAuthMethod?: 'api-key' | 'oauth';
}

export interface InitLlmStepOptions {
  /**
   * When true, do not prompt. Uses detected env keys (if present) and
   * selects a recommended provider/model automatically.
   *
   * If no keys are detected, returns `null`.
   */
  nonInteractive?: boolean;
}

function choosePreferredProviderId(detectedProviderIds: string[]): string {
  const preferredOrder = ['openai', 'anthropic', 'openrouter', 'ollama'];
  for (const id of preferredOrder) {
    if (detectedProviderIds.includes(id)) return id;
  }
  return detectedProviderIds[0] || 'openai';
}

/**
 * Interactive LLM configuration step for `wunderland init`.
 * Returns collected keys + provider/model, or `null` if the user cancelled.
 */
export async function runInitLlmStep(opts: InitLlmStepOptions = {}): Promise<InitLlmResult | null> {
  fmt.section('LLM Configuration');

  const apiKeys: Record<string, string> = {};
  let selectedProvider: string | undefined;
  let useOAuth = false;
  const nonInteractive = opts.nonInteractive === true || !process.stdin.isTTY || !process.stdout.isTTY;

  // ── Detect existing env vars ───────────────────────────────────────────────
  const detected: { id: string; label: string; envVar: string; value: string }[] = [];
  for (const prov of SUPPORTED_LLM_PROVIDERS) {
    if (!prov.envVar) continue; // Ollama — no key needed
    const val = process.env[prov.envVar];
    if (val) {
      detected.push({ id: prov.id, label: prov.label, envVar: prov.envVar, value: val });
    }
  }

  if (nonInteractive) {
    if (detected.length === 0) {
      fmt.note('No API keys detected in environment. Skipping LLM setup (non-interactive).');
      return null;
    }

    for (const d of detected) {
      apiKeys[d.envVar] = d.value;
    }

    selectedProvider = choosePreferredProviderId(detected.map((d) => d.id));
    const provDef = SUPPORTED_LLM_PROVIDERS.find((p) => p.id === selectedProvider);
    const selectedModel = (provDef?.models?.[0] as string | undefined) || 'gpt-4o-mini';

    fmt.blank();
    fmt.ok(`Provider: ${accent(selectedProvider)}  Model: ${accent(selectedModel)}`);

    return {
      apiKeys,
      llmProvider: selectedProvider,
      llmModel: selectedModel,
    };
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
    const providerOptions = [
      ...SUPPORTED_LLM_PROVIDERS.map((prov) => ({
        value: prov.id,
        label: prov.label,
        hint: prov.id === 'ollama' ? 'local, no key needed' : undefined,
      })),
      {
        value: 'openai-oauth',
        label: 'OpenAI (Subscription)',
        hint: 'ChatGPT Plus/Pro — no API key needed',
      },
    ];

    const chosenProvider = await p.select({
      message: 'Which LLM provider do you want to use?',
      options: providerOptions,
    });

    if (p.isCancel(chosenProvider)) return null;

    if (chosenProvider === 'openai-oauth') {
      selectedProvider = 'openai';
      useOAuth = true;
      fmt.note(`Run ${accent('wunderland login')} after init to authenticate with your OpenAI subscription.`);
    } else {
      selectedProvider = chosenProvider as string;
    }

    const provDef = SUPPORTED_LLM_PROVIDERS.find((p) => p.id === selectedProvider);
    if (provDef && provDef.envVar && !useOAuth) {
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
  const provDef = SUPPORTED_LLM_PROVIDERS.find((p) => p.id === selectedProvider);

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
    ...(useOAuth ? { llmAuthMethod: 'oauth' as const } : {}),
  };
}
