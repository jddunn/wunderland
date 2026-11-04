/**
 * @fileoverview Mission model-flag resolution for `wunderland mission run`.
 *
 * `mission run <file.yaml>` previously ignored `--planner-model` /
 * `--execution-model` — those flags were parsed only in the natural-language
 * mission path (`runNaturalLanguageMission`), so a YAML mission always ran on
 * the runtime default provider/model regardless of the flags. This module is
 * the shared resolver both paths use.
 *
 * Two correctness rules (Codex spec review 2026-07-19, findings F4 + F6):
 *  - Split `provider/model` on the FIRST slash only, so multi-segment model ids
 *    like `openrouter/anthropic/claude-sonnet-5` survive intact.
 *  - Resolve the API key + base URL from the SELECTED provider's environment,
 *    never the runtime default — otherwise a `--execution-model anthropic/...`
 *    flag would ship the default OpenAI/OpenRouter key to an Anthropic endpoint.
 *
 * @module wunderland/cli/mission-model-flags
 */

import { baseUrlFor } from '../../platform/config/provider-base-urls.js';

/** Runtime LLM config shape shared by the mission-run and NL-mission paths. */
export interface MissionModel {
  providerId: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

/** Options for {@link assertQualityFloor}. */
export interface QualityFloorOptions {
  /** When true, a local/small model resolves as below-floor and throws. */
  requireNonLocal: boolean;
  /** Human-readable source of the resolved model, surfaced in the error. */
  source?: string;
}

/**
 * Per-provider env var names for the API key and optional base URL. Mirrors the
 * `providerEnvMap` in mission.ts so both entry points resolve credentials the
 * same way. Providers absent from this map keep the runtime credentials.
 */
const PROVIDER_ENV: Record<string, { key: string; baseUrlEnv?: string; defaultBaseUrl?: string }> = {
  // Every entry resolves a base URL (resolveMissionProviderBaseUrl): the shared
  // chatCompletionsRequest helper routes purely on baseUrl and falls back to
  // the OpenAI endpoint when it is undefined — so a provider without one would
  // send its key to OpenAI and 401 (observed live 2026-07-24 with anthropic).
  // OpenAI, Anthropic and OpenRouter read their base-URL variable through
  // baseUrlFor, the same join `start` uses, so they carry no default here.
  openai: { key: 'OPENAI_API_KEY' },
  anthropic: { key: 'ANTHROPIC_API_KEY' },
  openrouter: { key: 'OPENROUTER_API_KEY' },
  gemini: {
    key: 'GEMINI_API_KEY',
    baseUrlEnv: 'GEMINI_BASE_URL',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  groq: { key: 'GROQ_API_KEY', baseUrlEnv: 'GROQ_BASE_URL', defaultBaseUrl: 'https://api.groq.com/openai/v1' },
  together: { key: 'TOGETHER_API_KEY', baseUrlEnv: 'TOGETHER_BASE_URL', defaultBaseUrl: 'https://api.together.xyz/v1' },
  mistral: { key: 'MISTRAL_API_KEY', baseUrlEnv: 'MISTRAL_BASE_URL', defaultBaseUrl: 'https://api.mistral.ai/v1' },
  xai: { key: 'XAI_API_KEY', baseUrlEnv: 'XAI_BASE_URL', defaultBaseUrl: 'https://api.x.ai/v1' },
};

/** Model-id / provider patterns that indicate a local, below-floor model. */
const LOCAL_MODEL_RE = /^(ollama|llama|qwen|phi\d|gemma|mistral:\s*7b|deepseek-r1:|codellama)/i;

/**
 * Resolve a `--planner-model` / `--execution-model` flag into a full LLM config.
 *
 * @param flag    The raw flag value (`provider/model`, bare `model`, or undefined).
 * @param runtime The runtime default config to fall back to.
 * @param env     The environment to resolve provider credentials from.
 * @returns The resolved {@link MissionModel}.
 * @throws If the flag names a known provider that has no API key in `env`.
 */
export function resolveMissionModel(
  flag: string | undefined,
  runtime: MissionModel,
  env: Record<string, string | undefined>,
): MissionModel {
  if (!flag) return runtime;

  const slash = flag.indexOf('/');
  if (slash === -1) {
    // Bare model id → keep the runtime provider + credentials, swap the model.
    return { ...runtime, model: flag };
  }

  const providerId = flag.slice(0, slash);
  const model = flag.slice(slash + 1);
  const spec = PROVIDER_ENV[providerId];
  if (!spec) {
    // Unknown provider → honor provider + model but keep runtime credentials.
    return { ...runtime, providerId, model };
  }

  const apiKey = (env[spec.key] ?? '').trim();
  if (!apiKey) {
    throw new Error(`Provider "${providerId}" selected but no API key found in env (${spec.key}).`);
  }
  const baseUrl = resolveMissionProviderBaseUrl(providerId, env);
  return { providerId, model, apiKey, baseUrl };
}

/**
 * The base URL a mission sends `providerId`'s requests to.
 *
 * OpenAI, Anthropic and OpenRouter read OPENAI_BASE_URL, ANTHROPIC_BASE_URL
 * and OPENROUTER_BASE_URL through {@link baseUrlFor}, the join `wunderland
 * start` uses: Anthropic's value may name the host root or the `/v1` root,
 * with or without a trailing slash, and resolves to the `/v1` root the
 * OpenAI-compatible request needs. Other providers read their own variable,
 * else their default root.
 *
 * @param providerId - The provider id (`openai`, `anthropic`, `groq`, ...).
 * @param env - The environment to read.
 * @returns The base URL, or `undefined` for a provider this module does not know.
 */
export function resolveMissionProviderBaseUrl(
  providerId: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const fromVariable = baseUrlFor(providerId, env);
  if (fromVariable) return fromVariable;
  const spec = PROVIDER_ENV[providerId];
  if (!spec) return undefined;
  return (spec.baseUrlEnv ? env[spec.baseUrlEnv] : undefined) ?? spec.defaultBaseUrl;
}

/**
 * Enforce an assistant-mission quality floor: a live browser-driving assistant
 * mission must not silently run on a local 7B model. Fails closed, naming the
 * resolved provider/model and where it came from (Codex finding F5).
 *
 * @returns The same model when it clears the floor.
 * @throws When `requireNonLocal` is set and the model resolves as local-tier.
 */
export function assertQualityFloor(model: MissionModel, opts: QualityFloorOptions): MissionModel {
  if (!opts.requireNonLocal) return model;
  const isLocal = model.providerId === 'ollama' || LOCAL_MODEL_RE.test(model.model);
  if (isLocal) {
    const src = opts.source ? ` (source: ${opts.source})` : '';
    throw new Error(
      `Assistant mission resolved to ${model.providerId}/${model.model}, which is below the assistant quality floor${src}. ` +
        `Pin a cloud model with --planner-model/--execution-model (e.g. anthropic/claude-sonnet-5).`,
    );
  }
  return model;
}
