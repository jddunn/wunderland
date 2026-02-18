/**
 * Environment-backed secret resolution for AgentOS extension packs.
 *
 * AgentOS extensions typically request secrets by a stable secret id
 * (e.g. "twilio.accountSid"). In CLI contexts, the most ergonomic source
 * of truth is process.env, so we provide a small adapter:
 * - secret id -> ENV VAR name (from extension-secrets.json when available)
 * - getSecret(secretId) -> process.env[ENV_VAR] (with backward-compatible fallbacks)
 */

import { createRequire } from 'node:module';

type SecretDef = { id: string; envVar?: string };

const require = createRequire(import.meta.url);

let _envVarBySecretId: Map<string, string> | null = null;
function getEnvVarForSecretId(secretId: string): string | undefined {
  if (_envVarBySecretId === null) {
    try {
      const defs = require('@framers/agentos/config/extension-secrets.json') as SecretDef[];
      _envVarBySecretId = new Map(
        Array.isArray(defs)
          ? defs
              .filter((d) => d && typeof d.id === 'string' && typeof d.envVar === 'string')
              .map((d) => [d.id, String(d.envVar)] as const)
          : [],
      );
    } catch {
      _envVarBySecretId = new Map();
    }
  }
  return _envVarBySecretId.get(secretId);
}

export function secretIdToEnvVar(secretId: string): string {
  const base = String(secretId ?? '').trim();
  const withUnderscores = base
    // camelCase -> snake_case
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    // "." / "-" / etc -> "_"
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return withUnderscores.toUpperCase();
}

export function createEnvSecretResolver(opts?: {
  env?: Record<string, string | undefined>;
  configSecrets?: Record<string, string>;
}): (secretId: string) => string | undefined {
  const env = opts?.env ?? process.env;
  const configSecrets = opts?.configSecrets;

  return (secretId: string): string | undefined => {
    const id = typeof secretId === 'string' ? secretId.trim() : '';
    if (!id) return undefined;

    const fromConfig = configSecrets && typeof configSecrets[id] === 'string' ? configSecrets[id] : undefined;
    if (fromConfig && fromConfig.trim()) return fromConfig.trim();

    const candidates: string[] = [];

    // Prefer the canonical env var name from the shared secret catalog.
    const fromCatalog = getEnvVarForSecretId(id);
    if (fromCatalog) candidates.push(fromCatalog);

    // Back-compat: older runtimes derived env vars from the secret id.
    const derived = secretIdToEnvVar(id);
    if (!fromCatalog || derived !== fromCatalog) candidates.push(derived);

    // Common "legacy" aliases used in the wild.
    // These are intentionally minimal; channel packs may still implement their own fallbacks.
    if (id === 'discord.botToken') candidates.push('DISCORD_TOKEN');
    if (id === 'telegram.botToken') candidates.push('TELEGRAM_TOKEN');

    for (const envVar of candidates) {
      const v = env[envVar];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }

    return undefined;
  };
}
