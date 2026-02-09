/**
 * @fileoverview Load and query extension-secrets.json definitions.
 * These drive the dynamic wizard prompts — adding a new channel or provider
 * to extension-secrets.json auto-generates CLI prompts.
 * @module wunderland/cli/config/secrets
 */

import { createRequire } from 'node:module';
import type { SecretDef } from '../types.js';

const require = createRequire(import.meta.url);

let _cached: SecretDef[] | null = null;

/** Load all secret definitions from extension-secrets.json. */
export function getAllSecrets(): SecretDef[] {
  if (_cached) return _cached;
  try {
    _cached = require('@framers/agentos/config/extension-secrets.json') as SecretDef[];
  } catch {
    _cached = [];
  }
  return _cached;
}

/** Get secrets required for a specific platform/provider. */
export function getSecretsForPlatform(platform: string): SecretDef[] {
  return getAllSecrets().filter((s) => s.providers.includes(platform));
}

/** Get secrets required for a list of platforms. Deduplicates by id. */
export function getSecretsForPlatforms(platforms: string[]): SecretDef[] {
  const seen = new Set<string>();
  const result: SecretDef[] = [];
  for (const platform of platforms) {
    for (const secret of getSecretsForPlatform(platform)) {
      if (!seen.has(secret.id)) {
        seen.add(secret.id);
        result.push(secret);
      }
    }
  }
  return result;
}

/** Group secrets by provider for display. */
export function groupSecretsByProvider(): Map<string, SecretDef[]> {
  const map = new Map<string, SecretDef[]>();
  for (const secret of getAllSecrets()) {
    for (const provider of secret.providers) {
      const list = map.get(provider) ?? [];
      list.push(secret);
      map.set(provider, list);
    }
  }
  return map;
}

/** Check which secrets are already set in the environment. */
export function checkEnvSecrets(): Array<SecretDef & { isSet: boolean; maskedValue?: string }> {
  return getAllSecrets().map((s) => {
    const val = process.env[s.envVar];
    return {
      ...s,
      isSet: !!val,
      maskedValue: val && val.length > 4
        ? '\u2022'.repeat(8) + val.slice(-4)
        : val ? 'set' : undefined,
    };
  });
}
