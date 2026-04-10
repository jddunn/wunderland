// @ts-nocheck
import { normalizeExtensionName } from './aliases.js';

export type ExtensionOverride = {
  enabled?: boolean;
  priority?: number;
  options?: Record<string, unknown>;
};

export function mergeExtensionOverride(
  base?: ExtensionOverride,
  extra?: ExtensionOverride,
): ExtensionOverride {
  const out: ExtensionOverride = {
    ...(base ?? {}),
    ...(extra ?? {}),
  };

  if (base?.options || extra?.options) {
    out.options = {
      ...(base?.options ?? {}),
      ...(extra?.options ?? {}),
    };
  }

  return out;
}

export function mergeExtensionOverrides(
  globalOverrides?: Record<string, ExtensionOverride>,
  agentOverrides?: Record<string, ExtensionOverride>,
): Record<string, ExtensionOverride> {
  const merged: Record<string, ExtensionOverride> = {};

  for (const source of [globalOverrides ?? {}, agentOverrides ?? {}]) {
    for (const [rawName, override] of Object.entries(source)) {
      const name = normalizeExtensionName(rawName);
      merged[name] = mergeExtensionOverride(merged[name], override);
    }
  }

  return merged;
}
