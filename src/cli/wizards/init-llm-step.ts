/**
 * @fileoverview Lightweight LLM provider/key/model prompt for `wunderland init`.
 * Detects existing env vars, confirms or overrides, selects provider + model.
 * @module wunderland/cli/wizards/init-llm-step
 */

import * as p from '@clack/prompts';
import { LLM_PROVIDERS } from '../constants.js';
import { accent } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

const TOOL_CALLING_PROVIDER_IDS = new Set(['openai', 'anthropic', 'openrouter', 'ollama', 'gemini']);
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
  /** Ollama-specific config (numCtx, numGpu, baseUrl). */
  ollamaConfig?: {
    numCtx?: number;
    numGpu?: number;
    baseUrl?: string;
  };
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
  const preferredOrder = ['openai', 'anthropic', 'gemini', 'openrouter', 'ollama'];
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
      // No cloud API keys — try Ollama as automatic fallback
      const {
        detectOllamaInstall,
        isLocalOllamaBaseUrl,
        normalizeOllamaBaseUrl,
        runOllamaAutoSetup,
      } = await import('../ollama/ollama-manager.js');
      const configuredBaseUrl = normalizeOllamaBaseUrl(process.env['OLLAMA_BASE_URL']);
      const ollamaPath = await detectOllamaInstall();
      if (ollamaPath || !isLocalOllamaBaseUrl(configuredBaseUrl)) {
        fmt.note('No API keys detected. Ollama found/configured — configuring Ollama provider...');
        try {
          const result = await runOllamaAutoSetup({ baseUrl: configuredBaseUrl });
          return {
            apiKeys: {},
            llmProvider: 'ollama',
            llmModel: result.model,
            ollamaConfig: {
              numCtx: result.numCtx,
              numGpu: result.numGpu,
              baseUrl: result.baseUrl !== 'http://localhost:11434' ? result.baseUrl : undefined,
            },
          };
        } catch {
          fmt.note('Ollama auto-setup failed. Skipping LLM setup.');
          return null;
        }
      }

      fmt.note('No API keys detected in environment. Skipping LLM setup (non-interactive).');
      return null;
    }

    for (const d of detected) {
      apiKeys[d.envVar] = d.value;
    }

    selectedProvider = choosePreferredProviderId(detected.map((d) => d.id));
    const provDef = SUPPORTED_LLM_PROVIDERS.find((p) => p.id === selectedProvider);
    const selectedModel = (provDef?.models?.[0] as string | undefined) || 'gpt-4o';

    fmt.blank();
    fmt.ok(`Provider: ${accent(selectedProvider)}  Model: ${accent(selectedModel)}`);

    return {
      apiKeys,
      llmProvider: selectedProvider,
      llmModel: selectedModel,
    };
  }

  // Interactive — show info panel
  fmt.blank();
  fmt.panel({
    title: 'LLM Configuration',
    style: 'info',
    content: detected.length > 0
      ? `Detected ${detected.length} API key${detected.length > 1 ? 's' : ''} in your environment.\nSelect a provider and model to continue.`
      : 'Select an LLM provider and enter your API key.\nSupported: OpenAI, Anthropic, Gemini, OpenRouter, Ollama.',
  });
  fmt.blank();

  if (detected.length > 0) {
    fmt.note('Detected API keys:');
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
      }

      // If multiple providers detected, let user choose which one to use
      if (detected.length > 1) {
        const chosenProvider = await p.select({
          message: 'Multiple API keys detected. Which provider do you want to use?',
          options: detected.map((d) => ({
            value: d.id,
            label: d.label,
          })),
        });
        if (p.isCancel(chosenProvider)) return null;
        selectedProvider = chosenProvider as string;
      } else {
        selectedProvider = detected[0].id;
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
        hint: 'ChatGPT Plus/Pro — not yet supported',
      },
    ];

    const chosenProvider = await p.select({
      message: 'Which LLM provider do you want to use?',
      options: providerOptions,
    });

    if (p.isCancel(chosenProvider)) return null;

    if (chosenProvider === 'openai-oauth') {
      fmt.errorBlock(
        'Not yet supported',
        'OAuth subscription-based usage (ChatGPT Plus/Pro) is not yet available.\n' +
        'Please use an OpenAI API key instead — get one at https://platform.openai.com/api-keys',
      );
      return null;
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

  // ── Select model (or auto-setup for Ollama) ──────────────────────────────
  let selectedModel = '';
  let ollamaConfig: { numCtx?: number; numGpu?: number; baseUrl?: string } | undefined;
  const provDef = SUPPORTED_LLM_PROVIDERS.find((p) => p.id === selectedProvider);

  if (selectedProvider === 'ollama') {
    // Zero-friction Ollama pipeline: detect, install, start, recommend, pull
    try {
      fmt.blank();
      fmt.section('Ollama Auto-Setup');
      const { runOllamaAutoSetup, listLocalModels } = await import('../ollama/ollama-manager.js');
      const result = await runOllamaAutoSetup();
      selectedModel = result.model;
      ollamaConfig = {
        numCtx: result.numCtx,
        numGpu: result.numGpu,
        baseUrl: result.baseUrl !== 'http://localhost:11434' ? result.baseUrl : undefined,
      };

      // Show installed models summary
      const installed = result.localModels.length > 0 ? result.localModels : await listLocalModels();
      if (installed.length > 0) {
        fmt.blank();
        fmt.note('Installed models:');
        for (const m of installed) {
          const sizeGB = (m.size / (1024 ** 3)).toFixed(1);
          fmt.ok(`  ${m.name} (${sizeGB} GB)`);
        }
      }
    } catch (err) {
      fmt.fail(err instanceof Error ? err.message : 'Ollama auto-setup failed');
      return null;
    }
  } else if (provDef && provDef.models.length > 0) {
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
    selectedModel = provDef.models[0] as string || 'gpt-4o';
  }

  fmt.blank();
  fmt.ok(`Provider: ${accent(selectedProvider)}  Model: ${accent(selectedModel)}`);

  return {
    apiKeys,
    llmProvider: selectedProvider,
    llmModel: selectedModel,
    ...(useOAuth ? { llmAuthMethod: 'oauth' as const } : {}),
    ...(ollamaConfig ? { ollamaConfig } : {}),
  };
}
