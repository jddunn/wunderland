import type { WunderlandProviderId } from '../api/types.js';

const SUPPORTED_TEXT_PROVIDERS = new Set<WunderlandProviderId>([
  'openai',
  'openrouter',
  'ollama',
  'anthropic',
  'gemini',
  'claude-code-cli',
  'gemini-cli',
]);

const TEXT_MODEL_ENV_KEYS: Record<WunderlandProviderId, string> = {
  openai: 'OPENAI_MODEL',
  openrouter: 'OPENROUTER_MODEL',
  ollama: 'OLLAMA_MODEL',
  anthropic: 'ANTHROPIC_MODEL',
  gemini: 'GEMINI_MODEL',
  'claude-code-cli': 'CLAUDE_CODE_MODEL',
  'gemini-cli': 'GEMINI_CLI_MODEL',
};

const TEXT_PROVIDER_DEFAULTS: Record<WunderlandProviderId, string> = {
  openai: 'gpt-4o',
  openrouter: 'openai/gpt-4o',
  ollama: 'llama3.2',
  anthropic: 'claude-sonnet-4-20250514',
  gemini: 'gemini-2.5-flash',
  'claude-code-cli': 'claude-sonnet-4-20250514',
  'gemini-cli': 'gemini-2.5-flash',
};

const TEXT_PROVIDER_ENV_ORDER: Array<{
  providerId: WunderlandProviderId;
  key: string;
}> = [
  { providerId: 'openrouter', key: 'OPENROUTER_API_KEY' },
  { providerId: 'openai', key: 'OPENAI_API_KEY' },
  { providerId: 'anthropic', key: 'ANTHROPIC_API_KEY' },
  { providerId: 'gemini', key: 'GEMINI_API_KEY' },
  { providerId: 'claude-code-cli' as WunderlandProviderId, key: '__CLAUDE_CODE_CLI_DETECT__' },
  { providerId: 'gemini-cli' as WunderlandProviderId, key: '__GEMINI_CLI_DETECT__' },
  { providerId: 'ollama', key: 'OLLAMA_BASE_URL' },
];

export function isWunderlandProviderId(value: string): value is WunderlandProviderId {
  return SUPPORTED_TEXT_PROVIDERS.has(value as WunderlandProviderId);
}

export function resolveWunderlandProviderId(
  raw: unknown,
  fallback: WunderlandProviderId = 'openai',
): WunderlandProviderId {
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!normalized) return fallback;
  if (isWunderlandProviderId(normalized)) return normalized;
  throw new Error(
    `Unsupported provider "${String(raw)}". Supported: openai, openrouter, ollama, anthropic, gemini, claude-code-cli, gemini-cli.`,
  );
}

export function getWunderlandDefaultTextModel(providerId: WunderlandProviderId): string {
  const envKey = TEXT_MODEL_ENV_KEYS[providerId];
  const envOverride = process.env[envKey]?.trim();
  if (envOverride) return envOverride;

  const model = TEXT_PROVIDER_DEFAULTS[providerId];
  if (!model) {
    throw new Error(`No default text model configured for provider "${providerId}".`);
  }
  return model;
}

export function resolveWunderlandTextModel(opts: {
  providerId: WunderlandProviderId;
  model?: string;
}): string {
  const explicitModel = typeof opts.model === 'string' ? opts.model.trim() : '';
  if (explicitModel) {
    if (explicitModel.includes(':')) {
      const [, ...rest] = explicitModel.split(':');
      return rest.join(':').trim();
    }
    return explicitModel;
  }
  return getWunderlandDefaultTextModel(opts.providerId);
}

export function detectWunderlandRuntimeProviderFromEnv(): WunderlandProviderId | undefined {
  for (const { providerId, key } of TEXT_PROVIDER_ENV_ORDER) {
    /* CLI-based providers use PATH detection, not env vars */
    if (providerId === 'claude-code-cli') {
      try {
        const { execSync } = require('child_process');
        execSync('which claude', { stdio: 'ignore' });
        return 'claude-code-cli';
      } catch { /* claude not on PATH — skip */ }
      continue;
    }
    if (providerId === 'gemini-cli') {
      try {
        const { execSync } = require('child_process');
        execSync('which gemini', { stdio: 'ignore' });
        return 'gemini-cli';
      } catch { /* gemini not on PATH — skip */ }
      continue;
    }
    if (process.env[key]?.trim()) return providerId;
  }
  return undefined;
}

function normalizeOllamaBaseUrl(value: string | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const base = trimmed || 'http://localhost:11434';
  const normalized = base.endsWith('/') ? base.slice(0, -1) : base;
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

export function resolveWunderlandRuntimeConfigFromEnv(): {
  providerId: WunderlandProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
} {
  const providerId = detectWunderlandRuntimeProviderFromEnv();
  if (!providerId) {
    throw new Error(
      'No LLM runtime found. Set OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or OLLAMA_BASE_URL.',
    );
  }

  const model = getWunderlandDefaultTextModel(providerId);
  if (providerId === 'openrouter') {
    return {
      providerId,
      apiKey: String(process.env['OPENROUTER_API_KEY'] || '').trim(),
      model,
      baseUrl: 'https://openrouter.ai/api/v1',
    };
  }
  if (providerId === 'ollama') {
    return {
      providerId,
      apiKey: '',
      model,
      baseUrl: normalizeOllamaBaseUrl(process.env['OLLAMA_BASE_URL']),
    };
  }
  if (providerId === 'gemini') {
    return {
      providerId,
      apiKey: String(process.env['GEMINI_API_KEY'] || '').trim(),
      model,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    };
  }
  if (providerId === 'anthropic') {
    return {
      providerId,
      apiKey: String(process.env['ANTHROPIC_API_KEY'] || '').trim(),
      model,
    };
  }
  if (providerId === 'claude-code-cli') {
    return {
      providerId,
      apiKey: '',
      model,
    };
  }
  if (providerId === 'gemini-cli') {
    return {
      providerId,
      apiKey: '',
      model,
    };
  }
  return {
    providerId,
    apiKey: String(process.env['OPENAI_API_KEY'] || '').trim(),
    model,
  };
}
