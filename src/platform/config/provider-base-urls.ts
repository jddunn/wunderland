/**
 * @fileoverview The base URL each provider's calls are sent to, read from the
 * provider's base-URL variable.
 *
 * `wunderland start` sends every call to OpenAI, Anthropic and OpenRouter
 * (the primary provider's turns, the fallback chain, the local memory tool,
 * the RAG bootstrap and the discovery index) to the URL this module returns,
 * so a proxy or gateway named by `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` or
 * `OPENROUTER_BASE_URL` sees every one of them.
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
  const value = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (!value) return PROVIDER_DEFAULT_BASE_URLS[providerId];
  if (providerId === 'anthropic') return `${value.replace(/\/v1$/, '')}/v1`;
  return value;
}
