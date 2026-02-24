import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { WunderlandAgentConfig, WunderlandProviderId } from '../api/types.js';
import type { LLMProviderConfig } from '../runtime/tool-calling.js';
import { WunderlandConfigError } from './errors.js';
import { validateWunderlandAgentConfig } from './schema.js';

export async function loadAgentConfig(opts: {
  agentConfig?: WunderlandAgentConfig;
  configPath?: string;
  workingDirectory: string;
}): Promise<WunderlandAgentConfig> {
  if (opts.agentConfig) return opts.agentConfig;
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

  return validated.config;
}

export function resolveProviderId(raw: unknown): WunderlandProviderId {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'openai' || v === 'openrouter' || v === 'ollama' || v === 'anthropic') return v;
  throw new WunderlandConfigError('Unsupported LLM provider.', [
    { path: 'llm.providerId', message: `Unsupported providerId "${String(raw)}".`, hint: 'Supported: openai, openrouter, ollama, anthropic.' },
  ]);
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
  const providerId = providerIdRaw === 'openai' || providerIdRaw === 'openrouter' || providerIdRaw === 'ollama' || providerIdRaw === 'anthropic'
    ? (providerIdRaw as WunderlandProviderId)
    : resolveProviderId(providerIdRaw);

  const modelFromConfig = typeof (opts.agentConfig as any).llmModel === 'string' ? String((opts.agentConfig as any).llmModel).trim() : '';
  const model =
    typeof opts.llm?.model === 'string' && opts.llm.model.trim()
      ? opts.llm.model.trim()
      : (modelFromConfig || (process.env['OPENAI_MODEL'] || 'gpt-4o-mini'));

  const baseUrl =
    providerId === 'openrouter'
      ? (opts.llm?.baseUrl ?? 'https://openrouter.ai/api/v1')
      : providerId === 'ollama'
        ? (opts.llm?.baseUrl ?? 'http://localhost:11434/v1')
        : opts.llm?.baseUrl;

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

  const apiKey =
    typeof opts.llm?.apiKey === 'string'
      ? opts.llm.apiKey
      : providerId === 'openrouter'
        ? openrouterApiKey
        : providerId === 'ollama'
          ? 'ollama'
          : providerId === 'anthropic'
            ? String(process.env['ANTHROPIC_API_KEY'] || '')
            : String(process.env['OPENAI_API_KEY'] || '');

  // For OAuth, we don't require an API key — tokens are resolved dynamically
  let getApiKey: (() => Promise<string>) | undefined;

  if (authMethod === 'oauth') {
    try {
      // Dynamic import to avoid hard dependency on the auth module
      const { OpenAIOAuthFlow, FileTokenStore } = await import('@framers/agentos/auth');
      const flow = new OpenAIOAuthFlow({ tokenStore: new FileTokenStore() });
      getApiKey = () => flow.getAccessToken();
    } catch {
      // Fallback: if the auth module isn't available, treat as api-key
    }
  }

  const canUseLLM =
    authMethod === 'oauth'
      ? true // OAuth handles auth dynamically
      : providerId === 'ollama'
        ? true
        : providerId === 'openrouter'
          ? !!openrouterApiKey
          : providerId === 'anthropic'
            ? !!process.env['ANTHROPIC_API_KEY']
            : !!apiKey || !!fallback;

  const openaiFallbackEnabled = providerId === 'openai' && !!fallback;

  return { providerId, apiKey, model, baseUrl, fallback, canUseLLM, openaiFallbackEnabled, authMethod, getApiKey };
}

