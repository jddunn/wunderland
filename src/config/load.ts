import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { WunderlandAgentConfig, WunderlandProviderId } from '../api/types.js';
import type { LLMProviderConfig } from '../runtime/tool-calling.js';
import { WunderlandConfigError } from './errors.js';
import { resolveEffectiveAgentConfig } from './effective-agent-config.js';
import {
  resolveWunderlandProviderId,
  resolveWunderlandTextModel,
} from './provider-defaults.js';
import { validateWunderlandAgentConfig } from './schema.js';

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, '');
}

export async function loadAgentConfig(opts: {
  agentConfig?: WunderlandAgentConfig;
  configPath?: string;
  workingDirectory: string;
}): Promise<WunderlandAgentConfig> {
  if (opts.agentConfig) {
    return (
      await resolveEffectiveAgentConfig({
        agentConfig: opts.agentConfig,
        workingDirectory: opts.workingDirectory,
      })
    ).agentConfig;
  }
  if (!opts.configPath) return {};

  const configPath = path.resolve(opts.workingDirectory, opts.configPath);
  if (!existsSync(configPath)) {
    throw new WunderlandConfigError('Missing config file.', [
      { path: 'configPath', message: `File not found: ${configPath}`, hint: 'Pass agentConfig directly or fix configPath.' },
    ]);
  }

  let parsed: unknown;
  try {
    const raw = await readFile(configPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WunderlandConfigError('Invalid config JSON.', [
      {
        path: 'configPath',
        message: err instanceof Error ? err.message : 'Failed to parse JSON.',
        hint: 'Ensure the file contains valid JSON.',
      },
    ]);
  }

  const validated = validateWunderlandAgentConfig(parsed);
  if (validated.issues.length > 0) {
    throw new WunderlandConfigError('Invalid agent config.', validated.issues.map((i) => ({ ...i, path: i.path || 'config' })));
  }

  return (
    await resolveEffectiveAgentConfig({
      agentConfig: validated.config,
      workingDirectory: opts.workingDirectory,
    })
  ).agentConfig;
}

export function resolveProviderId(raw: unknown): WunderlandProviderId {
  try {
    return resolveWunderlandProviderId(raw);
  } catch {
    throw new WunderlandConfigError('Unsupported LLM provider.', [
      { path: 'llm.providerId', message: `Unsupported providerId "${String(raw)}".`, hint: 'Supported: openai, openrouter, ollama, anthropic, gemini.' },
    ]);
  }
}

export type ResolvedLlmConfig = {
  providerId: WunderlandProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  fallback?: LLMProviderConfig;
  canUseLLM: boolean;
  openaiFallbackEnabled: boolean;
  /** Auth method resolved from agent config. */
  authMethod: 'api-key' | 'oauth';
  /** Async key getter for OAuth-authenticated sessions. */
  getApiKey?: () => Promise<string>;
};

export async function resolveLlmConfig(opts: {
  agentConfig: WunderlandAgentConfig;
  llm?: Partial<{
    providerId: WunderlandProviderId | string;
    apiKey: string;
    model: string;
    baseUrl?: string;
    fallback?: LLMProviderConfig;
  }>;
}): Promise<ResolvedLlmConfig> {
  const providerFromConfig = typeof (opts.agentConfig as any).llmProvider === 'string' ? String((opts.agentConfig as any).llmProvider).trim() : '';
  const providerIdRaw = opts.llm?.providerId ?? providerFromConfig ?? 'openai';
  const providerId = providerIdRaw === 'openai' || providerIdRaw === 'openrouter' || providerIdRaw === 'ollama' || providerIdRaw === 'anthropic' || providerIdRaw === 'gemini'
    ? (providerIdRaw as WunderlandProviderId)
    : resolveProviderId(providerIdRaw);

  const modelFromConfig = typeof (opts.agentConfig as any).llmModel === 'string' ? String((opts.agentConfig as any).llmModel).trim() : '';
  const model = resolveWunderlandTextModel({
    providerId,
    model:
      typeof opts.llm?.model === 'string' && opts.llm.model.trim()
        ? opts.llm.model.trim()
        : modelFromConfig,
  });

  const ollamaBaseUrl = (() => {
    if (opts.llm?.baseUrl) return opts.llm.baseUrl;
    const configBaseUrl =
      typeof (opts.agentConfig as any)?.ollama?.baseUrl === 'string'
        ? String((opts.agentConfig as any).ollama.baseUrl).trim()
        : '';
    const raw = String(process.env['OLLAMA_BASE_URL'] || '').trim() || configBaseUrl;
    const base = raw || 'http://localhost:11434';
    const normalized = base.endsWith('/') ? base.slice(0, -1) : base;
    if (normalized.endsWith('/v1')) return normalized;
    return `${normalized}/v1`;
  })();

  const baseUrl =
    providerId === 'openrouter'
      ? (normalizeBaseUrl(opts.llm?.baseUrl) ?? 'https://openrouter.ai/api/v1')
      : providerId === 'ollama'
        ? ollamaBaseUrl
        : providerId === 'gemini'
          ? (normalizeBaseUrl(opts.llm?.baseUrl) ??
            'https://generativelanguage.googleapis.com/v1beta/openai')
          : normalizeBaseUrl(opts.llm?.baseUrl);

  const openrouterApiKey = String(process.env['OPENROUTER_API_KEY'] || '').trim();

  const fallback =
    opts.llm?.fallback ??
    (providerId === 'openai' && openrouterApiKey
      ? ({
          apiKey: openrouterApiKey,
          model: 'auto',
          baseUrl: 'https://openrouter.ai/api/v1',
          extraHeaders: { 'HTTP-Referer': 'https://wunderland.sh', 'X-Title': 'Wunderland' },
        } satisfies LLMProviderConfig)
      : undefined);

  // Determine auth method from agent config
  const authMethod: 'api-key' | 'oauth' =
    (opts.agentConfig as any).llmAuthMethod === 'oauth' && providerId === 'openai'
      ? 'oauth'
      : 'api-key';

  if (authMethod === 'oauth') {
    throw new WunderlandConfigError('OpenAI OAuth is not currently supported.', [
      {
        path: 'llmAuthMethod',
        message: 'Subscription-based OpenAI OAuth is disabled until a first-party OAuth application is registered.',
        hint: 'Use OPENAI_API_KEY or pass llm.apiKey instead.',
      },
    ]);
  }

  const apiKey =
    typeof opts.llm?.apiKey === 'string'
      ? opts.llm.apiKey
      : providerId === 'openrouter'
        ? openrouterApiKey
        : providerId === 'ollama'
          ? 'ollama'
          : providerId === 'anthropic'
            ? String(process.env['ANTHROPIC_API_KEY'] || '')
            : providerId === 'gemini'
              ? String(process.env['GEMINI_API_KEY'] || '')
              : String(process.env['OPENAI_API_KEY'] || '');

  let getApiKey: (() => Promise<string>) | undefined;

  const canUseLLM =
    providerId === 'ollama'
      ? true
      : providerId === 'openrouter'
        ? !!apiKey
        : providerId === 'anthropic'
          ? !!apiKey
          : providerId === 'gemini'
            ? !!apiKey
            : !!apiKey || !!fallback;

  const openaiFallbackEnabled = providerId === 'openai' && !!fallback;

  return { providerId, apiKey, model, baseUrl, fallback, canUseLLM, openaiFallbackEnabled, authMethod, getApiKey };
}
