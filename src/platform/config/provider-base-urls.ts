/**
 * @fileoverview The base URL each provider's calls are sent to, read from the
 * provider's base-URL variable.
 *
 * Every call wunderland sends to OpenAI, Anthropic and OpenRouter goes to the
 * URL this module returns, so a proxy or gateway named by `OPENAI_BASE_URL`,
 * `ANTHROPIC_BASE_URL` or `OPENROUTER_BASE_URL` sees every one of them:
 * `start`'s calls (the primary provider's turns, including the turn a webhook
 * wakes, the fallback chain, the LLM judge, the local memory tool, the RAG
 * bootstrap, the discovery index and the Discord welcome and curated picks
 * posts), `chat`'s, the job executor's and the other commands'.
 *
 * @module wunderland/platform/config/provider-base-urls
 */

/** The variable each provider's base URL is read from. */
export const PROVIDER_BASE_URL_ENV = {
  openai: 'OPENAI_BASE_URL',
  anthropic: 'ANTHROPIC_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
} as const;

/** A provider whose base URL {@link baseUrlFor} reads. */
export type BaseUrlProviderId = keyof typeof PROVIDER_BASE_URL_ENV;

/**
 * Each provider's own API root, used when its variable is unset or blank.
 * Anthropic's is the root its OpenAI-compatible endpoint and its Messages API
 * share (`/v1/chat/completions`, `/v1/messages`).
 */
export const PROVIDER_DEFAULT_BASE_URLS: Readonly<Record<BaseUrlProviderId, string>> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * Gemini's OpenAI-compatible root. It has no base-URL variable in `start` or
 * `chat`; `wunderland mission` reads `GEMINI_BASE_URL` for its own requests.
 */
export const GEMINI_OPENAI_COMPATIBLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

function isBaseUrlProvider(providerId: string): providerId is BaseUrlProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDER_BASE_URL_ENV, providerId);
}

/**
 * The API root a call to `providerId` is sent to.
 *
 * The provider's variable, trimmed and with trailing slashes removed, when it
 * is set and not blank; otherwise the provider's own root
 * ({@link PROVIDER_DEFAULT_BASE_URLS}). `OPENAI_BASE_URL` and
 * `OPENROUTER_BASE_URL` name the root as their SDKs read it
 * (`https://api.openai.com/v1`, `https://openrouter.ai/api/v1`) and are
 * returned as set. `ANTHROPIC_BASE_URL` names the host root as Anthropic's
 * SDK reads it (`https://api.anthropic.com`), so `/v1` is added; a value that
 * already ends in `/v1` keeps one.
 *
 * @param providerId - `openai`, `anthropic` or `openrouter`.
 * @param env - The environment to read; `process.env` by default.
 * @returns The base URL, or `undefined` for any other provider.
 */
export function baseUrlFor(
  providerId: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!isBaseUrlProvider(providerId)) return undefined;
  const raw = env[PROVIDER_BASE_URL_ENV[providerId]];
  const value = trimBaseUrl(raw);
  if (!value) return PROVIDER_DEFAULT_BASE_URLS[providerId];
  if (providerId === 'anthropic') return anthropicV1Root(value, env);
  return value;
}

/**
 * The base URL an agent's primary provider sends to, the one `start` and `chat`
 * share: {@link baseUrlFor} for OpenAI, Anthropic and OpenRouter, the Ollama URL
 * for Ollama, Gemini's OpenAI-compatible root for Gemini.
 *
 * @param providerId - The primary provider.
 * @param opts.ollamaBaseUrl - The `/v1` root of the Ollama server.
 * @param env - The environment to read; `process.env` by default.
 * @returns The base URL, or `undefined` for any other provider.
 */
export function primaryBaseUrlFor(
  providerId: string,
  opts: { ollamaBaseUrl: string },
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (providerId === 'ollama') return opts.ollamaBaseUrl;
  if (providerId === 'gemini') return GEMINI_OPENAI_COMPATIBLE_BASE_URL;
  return baseUrlFor(providerId, env);
}

/**
 * The provider's variable in the form AgentOS's provider of that name takes as
 * its base URL, for a call AgentOS sends (the LLM judge): the API root for
 * OpenAI and OpenRouter, the host root for Anthropic, whose provider adds
 * `/v1/messages` itself. A value that ends in `/v1` or a trailing slash is
 * normalized the way wunderland's own requests read it.
 *
 * @param providerId - The provider AgentOS sends to.
 * @param env - The environment to read; `process.env` by default.
 * @returns The base URL, or `undefined` when the variable is unset or blank or
 *   the provider has none, which leaves the call on the provider's own endpoint.
 */
export function agentosBaseUrlFor(
  providerId: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!isBaseUrlProvider(providerId)) return undefined;
  const value = trimBaseUrl(env[PROVIDER_BASE_URL_ENV[providerId]]);
  if (!value) return undefined;
  return providerId === 'anthropic' ? value.replace(/\/v1$/, '') : value;
}

/** A base URL with surrounding spaces and trailing slashes removed; '' when blank. */
function trimBaseUrl(raw: string | undefined): string {
  return typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
}

/**
 * Anthropic's `/v1` root for `baseUrl`, the one join every Anthropic caller
 * uses. `baseUrl` may name the host root (`https://api.anthropic.com`, as
 * Anthropic's SDK reads ANTHROPIC_BASE_URL) or the `/v1` root, with or without
 * a trailing slash; either way the result ends in exactly one `/v1`. With
 * `baseUrl` unset or blank, ANTHROPIC_BASE_URL is read, else Anthropic's own
 * root.
 *
 * @param baseUrl - A host root or `/v1` root; ANTHROPIC_BASE_URL by default.
 * @param env - The environment to read; `process.env` by default.
 * @returns The `/v1` root, e.g. `https://api.anthropic.com/v1`.
 */
export function anthropicV1Root(
  baseUrl?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = trimBaseUrl(baseUrl) || trimBaseUrl(env[PROVIDER_BASE_URL_ENV.anthropic]);
  if (!value) return PROVIDER_DEFAULT_BASE_URLS.anthropic;
  return `${value.replace(/\/v1$/, '')}/v1`;
}

/**
 * The URL of an Anthropic API path: `<anthropicV1Root(baseUrl)>/<path>`, such
 * as `anthropicApiUrl('messages')` for the Messages API or
 * `anthropicApiUrl('chat/completions')` for the OpenAI-compatible endpoint.
 *
 * @param path - The path under `/v1`, without the `/v1`.
 * @param baseUrl - A host root or `/v1` root; ANTHROPIC_BASE_URL by default.
 * @param env - The environment to read; `process.env` by default.
 * @returns The full URL.
 */
export function anthropicApiUrl(
  path: string,
  baseUrl?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return `${anthropicV1Root(baseUrl, env)}/${path.replace(/^\/+/, '')}`;
}
