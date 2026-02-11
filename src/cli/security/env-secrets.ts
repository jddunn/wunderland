/**
 * Environment-backed secret resolution for AgentOS extension packs.
 *
 * AgentOS extensions typically request secrets by a stable secret id
 * (e.g. "twilio.accountSid"). In CLI contexts, the most ergonomic source
 * of truth is process.env, so we provide a small adapter:
 * - secret id -> ENV VAR name (TWILIO_ACCOUNT_SID)
 * - getSecret(secretId) -> process.env[ENV_VAR]
 */

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

    const envVar = secretIdToEnvVar(id);
    const v = env[envVar];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
}

