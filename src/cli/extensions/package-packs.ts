/**
 * @fileoverview Extension packs `wunderland start` imports from npm by their
 * package name: the packs the curated registry
 * (`@framers/agentos-extensions-registry`) does not list. An agent config
 * names one as it names any pack (`extensions.tools`, `tools.allow.packs`),
 * and `extensionOverrides.<name>` reaches it as it reaches the others.
 */

import { normalizeExtensionName } from './aliases.js';

/** A pack the registry does not list: its npm package and the options wunderland gives it. */
export interface PackagePack {
  /** The npm package `start` imports; it exports `createExtensionPack`. */
  readonly package: string;
  /** The options its `createExtensionPack` gets, under `extensionOverrides.<name>.options`. */
  readonly options: Readonly<Record<string, unknown>>;
}

/** A manifest entry `start`'s loader imports by package. */
export interface PackagePackEntry {
  /** The name the agent config gives the pack. */
  name: string;
  /** The npm package. */
  package: string;
  /** The pack's options: wunderland's, then the agent's overrides over them. */
  options: Record<string, unknown>;
  /** The override's priority, when it gives one. */
  priority?: number;
}

/** The packs by the name an agent config gives them. */
export const PACKAGE_PACKS: Readonly<Record<string, PackagePack>> = Object.freeze({
  /**
   * WildWeave's film studio: 22 `wildweave_film_*` tools over a wilds.ai
   * account's film, the key in the secret `wildweave.studio.key`
   * (`WILDWEAVE_STUDIO_KEY`), and its MCP endpoint on `start`'s HTTP server
   * at `/mcp/wildweave-film`, answering callers on this machine alone.
   */
  'wildweave-film': Object.freeze({
    package: '@framers/agentos-ext-wildweave-film',
    options: Object.freeze({ baseUrl: 'https://wilds.ai', http: Object.freeze({ path: '/mcp/wildweave-film' }) }),
  }),
});

/** Whether `name` is a pack `start` imports by package. */
export function isPackagePackName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PACKAGE_PACKS, normalizeExtensionName(name));
}

/**
 * Takes the packs `start` imports by package out of an extension list, so the
 * registry is not asked for them.
 *
 * @returns The list's package packs and the rest, each in the list's order.
 */
export function takePackagePacks(names: readonly string[]): { packagePacks: string[]; rest: string[] } {
  const packagePacks: string[] = [];
  const rest: string[] = [];
  for (const name of names) (isPackagePackName(name) ? packagePacks : rest).push(normalizeExtensionName(name));
  return { packagePacks, rest };
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The manifest entries of the named package packs, once each: wunderland's
 * options with the override's `options` over them, key by key. An override
 * with `"enabled": false` leaves its pack out; a name that is not a package
 * pack is skipped.
 */
export function packagePackEntries(
  names: readonly string[],
  overrides: Readonly<Record<string, unknown>> = {},
): PackagePackEntry[] {
  const entries: PackagePackEntry[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = normalizeExtensionName(raw);
    if (seen.has(name) || !isPackagePackName(name)) continue;
    seen.add(name);
    const pack = PACKAGE_PACKS[name]!;
    const given = overrides[name];
    const override: Record<string, unknown> = isRecord(given) ? given : {};
    if (override['enabled'] === false) continue;
    const givenOptions = override['options'];
    const extra: Record<string, unknown> = isRecord(givenOptions) ? givenOptions : {};
    const entry: PackagePackEntry = { name, package: pack.package, options: { ...pack.options, ...extra } };
    const priority = override['priority'];
    if (typeof priority === 'number') entry.priority = priority;
    entries.push(entry);
  }
  return entries;
}
