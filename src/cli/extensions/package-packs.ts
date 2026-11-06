/**
 * @fileoverview Extension packs `wunderland start` imports from npm by their
 * package name: the packs the curated registry
 * (`@framers/agentos-extensions-registry`) does not list. An agent config
 * names one as it names any pack (`extensions.tools`, `tools.allow.packs`),
 * and `extensionOverrides.<name>` reaches it as it reaches the others.
 */

import { secretIdToEnvVar } from '../../security/env-secrets.js';
import { normalizeExtensionName } from './aliases.js';

/** A pack the registry does not list: its npm package and the options wunderland gives it. */
export interface PackagePack {
  /** The npm package `start` imports; it exports `createExtensionPack`. */
  readonly package: string;
  /** The options its `createExtensionPack` gets, under `extensionOverrides.<name>.options`. */
  readonly options: Readonly<Record<string, unknown>>;
  /**
   * The secret its HTTP endpoint's bearer token is stored under. wunderland reads it through
   * `getSecret` (the agent config's `secrets`, then the variable) and passes it as `http.token`;
   * with none, the endpoint is left off (`http: null`) and the pack's tools still load.
   */
  readonly httpTokenSecret?: string;
}

/** Reads a secret by its id: the agent config's `secrets`, then the environment. */
export type PackageSecretReader = (secretId: string) => string | undefined;

/** A manifest entry `start`'s loader imports by package. */
export interface PackagePackEntry {
  /** The name the agent config gives the pack. */
  name: string;
  /** The npm package. */
  package: string;
  /**
   * The pack's options: wunderland's, then the agent's override options over
   * them, then the override's `priority` as `options.priority`, which is where
   * the pack reads its descriptors' priority.
   */
  options: Record<string, unknown>;
  /** Why wunderland left the pack's HTTP endpoint off, for `start` to note. */
  note?: string;
}

/** The HTTP handlers a loaded package pack serves, and the tools they serve. */
export interface PackageHttpService<Handler = unknown> {
  /** The pack's name, for notes. */
  pack: string;
  /** Every tool the pack registers: its handlers serve them all. */
  tools: string[];
  /** The pack's `http-handler` payloads. */
  handlers: Handler[];
}

/** The packs by the name an agent config gives them. */
export const PACKAGE_PACKS: Readonly<Record<string, PackagePack>> = Object.freeze({
  /**
   * WildWeave's film studio: 22 `wildweave_film_*` tools over a wilds.ai
   * account's film, the key in the secret `wildweave.studio.key`
   * (`WILDWEAVE_STUDIO_KEY`), and its MCP endpoint on `start`'s HTTP server
   * at `/mcp/wildweave-film`, answering callers on this machine that send
   * `Authorization: Bearer <token>`, the token in the secret
   * `wildweave.studio.http_token` (`WILDWEAVE_STUDIO_HTTP_TOKEN`).
   */
  'wildweave-film': Object.freeze({
    package: '@framers/agentos-ext-wildweave-film',
    options: Object.freeze({ baseUrl: 'https://wilds.ai', http: Object.freeze({ path: '/mcp/wildweave-film' }) }),
    httpTokenSecret: 'wildweave.studio.http_token',
  }),
});

/** Whether `name` is a pack `start` imports by package. */
export function isPackagePackName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PACKAGE_PACKS, normalizeExtensionName(name));
}

/**
 * The package pack `ref` names, by the name a config gives it
 * (`wildweave-film`) or by its npm package
 * (`@framers/agentos-ext-wildweave-film`).
 */
export function packagePackFor(ref: string): { name: string; package: string } | undefined {
  const name = normalizeExtensionName(ref);
  if (!name) return undefined;
  if (isPackagePackName(name)) return { name, package: PACKAGE_PACKS[name]!.package };
  for (const [packName, pack] of Object.entries(PACKAGE_PACKS)) {
    if (pack.package === name) return { name: packName, package: pack.package };
  }
  return undefined;
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
 *
 * A pack whose HTTP endpoint asks for a bearer token (`httpTokenSecret`) gets
 * the token read through `getSecret` as `http.token`, unless the override
 * gives one. With none, its `http` is `null`, so the pack loads its tools
 * without the endpoint (it refuses to load with `http` and no token), and the
 * entry's `note` says why.
 */
export function packagePackEntries(
  names: readonly string[],
  overrides: Readonly<Record<string, unknown>> = {},
  getSecret?: PackageSecretReader,
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
    const options: Record<string, unknown> = { ...pack.options, ...extra };
    let note: string | undefined;
    const http = options['http'];
    if (pack.httpTokenSecret && isRecord(http) && http['token'] === undefined) {
      const token = getSecret?.(pack.httpTokenSecret)?.trim();
      if (token) {
        options['http'] = { ...http, token };
      } else {
        options['http'] = null;
        note = `${name}: HTTP endpoint not mounted; set the secret ${pack.httpTokenSecret} (${secretIdToEnvVar(pack.httpTokenSecret)}) to a token of 32 or more characters, such as \`openssl rand -hex 32\` writes`;
      }
    }
    // The loader hands the pack its options alone: the priority goes there.
    const priority = override['priority'];
    if (typeof priority === 'number') options['priority'] = priority;
    entries.push(note ? { name, package: pack.package, options, note } : { name, package: pack.package, options });
  }
  return entries;
}

/**
 * Imports a package pack's npm package and creates the pack with the entry's
 * options: `start`'s loader at startup and `extensions_enable` under
 * `lazyTools` both load one this way.
 *
 * @throws When the package does not import or does not export `createExtensionPack`.
 */
export async function createPackagePack(
  entry: PackagePackEntry,
  host: { getSecret?: (secretId: string) => string | undefined; logger?: unknown },
  importer: (specifier: string) => Promise<any> = (specifier) => import(specifier),
): Promise<any> {
  const mod = await importer(entry.package);
  const factory = mod?.createExtensionPack ?? mod?.default?.createExtensionPack ?? mod?.default;
  if (typeof factory !== 'function') throw new Error(`Extension ${entry.package} does not export createExtensionPack`);
  return factory({ options: entry.options, logger: host.logger ?? console, getSecret: host.getSecret });
}

/**
 * The HTTP handlers a loaded package pack serves and the tools they serve, or
 * `undefined` when it serves none. A handler serves every one of the pack's
 * tools to callers outside the agent's turns, so `start` mounts it only when
 * the agent's tool settings keep all of them ({@link toolsDroppedFrom}).
 */
export function packageHttpServiceOf<Handler = unknown>(pack: any): PackageHttpService<Handler> | undefined {
  const descriptors: any[] = Array.isArray(pack?.descriptors) ? pack.descriptors : [];
  const handlers = descriptors
    .filter((d) => d?.kind === 'http-handler')
    .map((d) => d.payload)
    .filter(Boolean) as Handler[];
  if (handlers.length === 0) return undefined;
  const tools = descriptors
    .filter((d) => d?.kind === 'tool')
    .map((d) => d?.payload?.name)
    .filter((name): name is string => typeof name === 'string');
  return { pack: String(pack?.name ?? 'package pack'), tools, handlers };
}

/** The tools of `service` the tool map no longer holds, in its order. */
export function toolsDroppedFrom(service: PackageHttpService, toolMap: { has(name: string): boolean }): string[] {
  return service.tools.filter((name) => !toolMap.has(name));
}
