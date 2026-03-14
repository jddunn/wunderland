/**
 * @fileoverview API keys wizard — LLM provider key collection.
 * @module wunderland/cli/wizards/api-keys-wizard
 */

import * as p from '@clack/prompts';
import chalk from 'chalk';
import type { WizardState } from '../types.js';
import { LLM_PROVIDERS } from '../constants.js';
import { accent } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { importEnvBlock } from '../config/env-manager.js';

// ── Key validation ──────────────────────────────────────────────────────────

async function validateApiKey(providerId: string, apiKey: string): Promise<{ valid: boolean; detail: string; latency: number }> {
  const provider = LLM_PROVIDERS.find((p) => p.id === providerId);
  if (!provider?.validationUrl) return { valid: true, detail: 'no validation endpoint', latency: 0 };

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const headers: Record<string, string> = {};

    if (providerId === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      headers['content-type'] = 'application/json';
      // Send minimal request — 400 = key is valid, 401 = invalid
      const res = await fetch(provider.validationUrl, {
        method: 'POST', signal: controller.signal, headers,
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      clearTimeout(timer);
      const latency = Date.now() - start;
      if (res.status === 401) return { valid: false, detail: '401 Unauthorized', latency };
      return { valid: true, detail: `${res.status} (${latency}ms)`, latency };
    }

    // Default: Bearer token + HEAD/GET
    headers['Authorization'] = `Bearer ${apiKey}`;
    const method = providerId === 'gemini' ? 'GET' : 'HEAD';
    const url = providerId === 'gemini' ? `${provider.validationUrl}?key=${apiKey}` : provider.validationUrl;
    const finalHeaders = providerId === 'gemini' ? {} : headers;

    const res = await fetch(url, { method, signal: controller.signal, headers: finalHeaders });
    clearTimeout(timer);
    const latency = Date.now() - start;
    if (res.status === 401 || res.status === 403) return { valid: false, detail: `${res.status} Unauthorized`, latency };
    return { valid: true, detail: `${latency}ms`, latency };
  } catch (err: any) {
    return { valid: false, detail: err?.message || 'connection failed', latency: Date.now() - start };
  }
}

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
  const options = [
    ...LLM_PROVIDERS.map((prov) => ({
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

  const selected = await p.multiselect({
    message: 'Which LLM providers do you want to use?',
    options,
    required: true,
    initialValues: ['openai'],
  });

  if (p.isCancel(selected)) return;

  const rawProviders = selected as string[];

  // Handle OpenAI OAuth selection
  const wantsOAuth = rawProviders.includes('openai-oauth');
  const providers = rawProviders.filter((id) => id !== 'openai-oauth');

  if (wantsOAuth) {
    state.llmProvider = state.llmProvider || 'openai';
    state.llmAuthMethod = 'oauth';
    fmt.note('Run "wunderland login" after setup to authenticate with your OpenAI subscription.');
  }

  // Collect keys for each provider
  const configuredProviders: string[] = [];

  for (const provId of providers) {
    const provider = LLM_PROVIDERS.find((p) => p.id === provId);
    if (!provider) continue;

    // Ollama doesn't need a key
    if (!provider.envVar) {
      configuredProviders.push(provId);
      continue;
    }

    // Skip OpenAI key prompt if using OAuth
    if (provId === 'openai' && state.llmAuthMethod === 'oauth') {
      configuredProviders.push('openai');
      continue;
    }

    // Check if already set in env or imported via .env paste
    const existing = process.env[provider.envVar];
    const importedViaPaste = provider.envVar in state.apiKeys;
    if (existing || importedViaPaste) {
      const source = importedViaPaste ? 'imported from .env paste' : 'already set in environment';
      fmt.ok(`${provider.label}: ${source}`);
      if (existing) state.apiKeys[provider.envVar] = existing;
      configuredProviders.push(provId);
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
      // Validate the key in real-time
      const validation = await validateApiKey(provId, apiKey as string);
      if (validation.valid) {
        fmt.ok(`${provider.label}: key valid (${validation.detail})`);
        state.apiKeys[provider.envVar] = apiKey as string;
        configuredProviders.push(provId);
      } else {
        fmt.fail(`${provider.label}: ${validation.detail}`);
        fmt.note(`Get a key: ${fmt.link(provider.signupUrl)}`);
        // Offer retry
        const retry = await p.confirm({ message: 'Try a different key?', initialValue: true });
        if (!p.isCancel(retry) && retry) {
          const retryKey = await p.password({ message: `${provider.label} API Key (retry):` });
          if (!p.isCancel(retryKey) && retryKey) {
            const retryValidation = await validateApiKey(provId, retryKey as string);
            if (retryValidation.valid) {
              fmt.ok(`${provider.label}: key valid (${retryValidation.detail})`);
              state.apiKeys[provider.envVar] = retryKey as string;
              configuredProviders.push(provId);
            } else {
              fmt.fail(`${provider.label}: still invalid — saving anyway, you can update later.`);
              state.apiKeys[provider.envVar] = retryKey as string;
              configuredProviders.push(provId);
            }
          }
        } else {
          // Save anyway — user might fix later
          state.apiKeys[provider.envVar] = apiKey as string;
          configuredProviders.push(provId);
        }
      }
    } else {
      fmt.note(`Get one at: ${fmt.link(provider.signupUrl)}`);
    }
  }

  // Choose default provider when multiple were configured
  if (configuredProviders.length > 1) {
    const providerChoices = configuredProviders.map((id) => {
      const prov = LLM_PROVIDERS.find((p) => p.id === id);
      return { value: id, label: prov?.label || id };
    });

    const picked = await p.select({
      message: 'Default LLM provider:',
      options: providerChoices,
    });

    if (!p.isCancel(picked)) {
      state.llmProvider = picked as string;
    } else {
      state.llmProvider = configuredProviders[0];
    }
  } else if (configuredProviders.length === 1) {
    state.llmProvider = configuredProviders[0];
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

  // Summary panel
  if (state.llmProvider) {
    const g = glyphs();
    const keyCount = Object.keys(state.apiKeys).length;
    fmt.blank();
    fmt.panel({
      title: `${g.ok} LLM Configured`,
      style: 'success',
      content: [
        `Provider: ${accent(state.llmProvider)}`,
        state.llmModel ? `Model:    ${accent(state.llmModel)}` : null,
        state.llmAuthMethod === 'oauth' ? `Auth:     OAuth (subscription)` : null,
        keyCount > 0 ? `Keys:     ${keyCount} saved` : null,
      ].filter(Boolean).join('\n'),
    });
    fmt.blank();
  }
}
