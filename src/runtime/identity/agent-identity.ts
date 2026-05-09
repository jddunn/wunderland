// @ts-nocheck
/**
 * @fileoverview Helpers for consistent runtime agent identity resolution.
 * @module wunderland/runtime/agent-identity
 */

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const next = asNonEmptyString(value);
    if (next) return next;
  }
  return undefined;
}

export function resolveAgentDisplayName(opts: {
  displayName?: unknown;
  agentName?: unknown;
  globalAgentName?: unknown;
  seedId?: unknown;
  fallback: string;
}): string {
  return (
    firstNonEmptyString(
      opts.displayName,
      opts.agentName,
      opts.globalAgentName,
      opts.seedId,
    ) ?? opts.fallback
  );
}
