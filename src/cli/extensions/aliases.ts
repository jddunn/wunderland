// @ts-nocheck
/**
 * @fileoverview Canonicalization helpers for curated extension names.
 */

const EXTENSION_NAME_ALIASES: Record<string, string> = {
  'google-calendar': 'calendar-google',
};

export function normalizeExtensionName(name: string): string {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return '';
  return EXTENSION_NAME_ALIASES[trimmed] ?? trimmed;
}

export function normalizeExtensionList(names: string[] | undefined): string[] {
  if (!Array.isArray(names)) return [];

  const normalized = names
    .map((name) => normalizeExtensionName(String(name ?? '')))
    .filter((name) => name.length > 0);

  return [...new Set(normalized)];
}
