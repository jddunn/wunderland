// @ts-nocheck
/**
 * @fileoverview Schema-on-demand meta tools for Wunderland's tool-calling loop.
 *
 * These tools let the model enable curated extension packs at runtime so the
 * next LLM round includes the newly-available tool schemas.
 */

import { getAvailableExtensions, type ExtensionInfo } from '@framers/agentos-extensions-registry';

import type { ToolInstance } from '../tools/tool-calling.js';
import { filterToolMapByPolicy, getPermissionsForSet, normalizeToolAccessProfile } from '../tools/policy.js';
import { normalizeExtensionName } from '../../cli/extensions/aliases.js';
import {
  PACKAGE_PACKS,
  createPackagePack,
  packageHttpServiceOf,
  packagePackEntries,
  packagePackFor,
  toolsDroppedFrom,
} from '../../cli/extensions/package-packs.js';
import { createSpeechExtensionEnvOverrides } from '../../channels/voice/speech-catalog.js';
import { TOOL_NOT_ALLOWED } from '../tools/tool-allow-list.js';
import { logToolRefusal } from '../tools/tool-refusal-log.js';

type ExtensionsListOutput = {
  curated: ExtensionInfo[];
  /** The packs the curated registry does not list, which `extensions_enable` loads by name too. */
  packagePacks: Array<{ name: string; packageName: string }>;
  enabledPackages: string[];
};

type ExtensionsEnableInput = {
  extension: string;
  source?: 'curated' | 'package';
  options?: Record<string, unknown>;
  dryRun?: boolean;
};

type ExtensionsEnableOutput = {
  extension: string;
  source: 'curated' | 'package';
  packageName?: string;
  available?: boolean;
  loaded: boolean;
  skipped?: boolean;
  reason?: string;
  toolsAdded: string[];
  toolsUpdated: string[];
  toolsBlockedByPolicy?: string[];
  /** A package pack's HTTP endpoint: mounted when the agent keeps every one of its tools. */
  httpEndpoint?: 'mounted' | 'not_mounted';
};

/**
 * How `extensions_enable` loads a package pack (`cli/extensions/package-packs.ts`) as `start`'s
 * loader does at startup: its options from the agent's `extensionOverrides`, its key through the
 * config's secret reader, its tools narrowed by the agent's tool settings, and its HTTP handler
 * mounted only when they keep every one of its tools.
 */
export type SchemaOnDemandPackagePacks = {
  /** `extensionOverrides`, global then agent. `<name>.options` and `<name>.priority` reach the pack. */
  overrides?: Readonly<Record<string, unknown>>;
  /** The secret reader the pack gets (the agent config's `secrets`, then the environment). */
  getSecret?: (secretId: string) => string | undefined;
  /**
   * Narrows the pack's newly loaded tools in `toolMap` as `start` narrows every tool (the permission
   * set, the tool access profile, `tools.allow`), deleting the ones it drops; answers their names.
   */
  confine?: (toolMap: Map<string, ToolInstance>, toolNames: readonly string[]) => string[];
  /** Mounts a pack's HTTP handlers on `start`'s server. Without it no handler is mounted. */
  mountHttpHandlers?: (handlers: unknown[]) => void;
  /** Called with each package pack loaded, so `start` deactivates it on shutdown. */
  onPackLoaded?: (pack: unknown) => void;
};

export type SchemaOnDemandRuntimeDefaults = {
  workingDirectory: string;
  headlessBrowser: boolean;
  dangerouslySkipCommandSafety: boolean;
  agentWorkspace?: { agentId: string; baseDir: string };
};

function buildDefaultPackOptions(
  packageName: string,
  runtime: SchemaOnDemandRuntimeDefaults,
): Record<string, unknown> {
  const speechOverrides = createSpeechExtensionEnvOverrides();

  switch (packageName) {
    case '@framers/agentos-ext-cli-executor':
      return runtime.agentWorkspace
        ? {
            agentWorkspace: {
              agentId: runtime.agentWorkspace.agentId,
              baseDir: runtime.agentWorkspace.baseDir,
              createIfMissing: true,
              subdirs: ['assets', 'exports', 'tmp'],
            },
            filesystem: { allowRead: true, allowWrite: true },
            dangerouslySkipSecurityChecks: runtime.dangerouslySkipCommandSafety,
          }
        : {
            workingDirectory: runtime.workingDirectory,
            filesystem: {
              allowRead: true,
              allowWrite: true,
              readRoots: [runtime.workingDirectory],
              writeRoots: [runtime.workingDirectory],
            },
            dangerouslySkipSecurityChecks: runtime.dangerouslySkipCommandSafety,
          };
    case '@framers/agentos-ext-web-browser':
      return { headless: runtime.headlessBrowser };
    case '@framers/agentos-ext-web-search':
      return {
        serperApiKey: process.env['SERPER_API_KEY'],
        serpApiKey: process.env['SERPAPI_API_KEY'],
        braveApiKey: process.env['BRAVE_API_KEY'],
      };
    case '@framers/agentos-ext-giphy':
      return { giphyApiKey: process.env['GIPHY_API_KEY'] };
    case '@framers/agentos-ext-image-search':
      return {
        pexelsApiKey: process.env['PEXELS_API_KEY'],
        unsplashApiKey: process.env['UNSPLASH_ACCESS_KEY'],
        pixabayApiKey: process.env['PIXABAY_API_KEY'],
      };
    case '@framers/agentos-ext-voice-synthesis':
      return speechOverrides['voice-synthesis']?.options ?? {};
    case '@framers/agentos:speech-runtime':
      return speechOverrides['speech-runtime']?.options ?? {};
    case '@framers/agentos-ext-news-search':
      return { newsApiKey: process.env['NEWSAPI_API_KEY'] };
    default:
      return {};
  }
}

function getFactory(mod: any): ((ctx: any) => any) | null {
  const factory = mod?.createExtensionPack ?? mod?.default?.createExtensionPack ?? mod?.default;
  return typeof factory === 'function' ? factory : null;
}

export function createSchemaOnDemandTools(opts: {
  toolMap: Map<string, ToolInstance>;
  runtimeDefaults: SchemaOnDemandRuntimeDefaults;
  initialEnabledPackages?: string[];
  secrets?: Record<string, string>;
  getSecret?: (secretId: string) => string | undefined;
  defaultExtensionOptions?: Record<string, Record<string, unknown>>;
  /**
   * Allow enabling packs by explicit npm package name (source='package' or refs
   * starting with '@').
   *
   * Default: true in non-production, false in production.
   */
  allowPackages?: boolean;
  /**
   * Allow enabling unknown package names (not present in the curated catalog).
   *
   * Default: false.
   */
  allowUnknownPackages?: boolean;
  /**
   * The only packs `extensions_enable` may load (an agent config's
   * `tools.allow.packs`), by curated name (`web-search`) or package name. A
   * request for any other pack, by either name, is answered
   * `tool_not_allowed` before anything is imported. Omitted, every curated
   * pack is eligible.
   */
  allowedPackages?: readonly string[];
  /**
   * How `extensions_enable` loads the packs the curated registry does not list. Omitted, it loads
   * none of them and `extensions_list` names none.
   */
  packagePacks?: SchemaOnDemandPackagePacks;
  logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void; error?: (...args: any[]) => void };
  /** Called after extensions_enable loads new tools into toolMap. */
  onToolsChanged?: (toolsAdded: string[]) => void;
}): ToolInstance[] {
  const enabledPackages = new Set<string>();
  const log = opts.logger ?? console;
  const allowPackages =
    typeof opts.allowPackages === 'boolean' ? opts.allowPackages : process.env['NODE_ENV'] !== 'production';
  const allowUnknownPackages = opts.allowUnknownPackages === true;
  const allowedPackages = Array.isArray(opts.allowedPackages)
    ? new Set(opts.allowedPackages.map((name) => normalizeExtensionName(String(name ?? ''))).filter(Boolean))
    : undefined;

  for (const pkg of opts.initialEnabledPackages ?? []) {
    if (pkg) enabledPackages.add(String(pkg));
  }

  let cachedCatalog: ExtensionInfo[] | null = null;

  async function getCatalog(): Promise<ExtensionInfo[]> {
    if (cachedCatalog) return cachedCatalog;
    cachedCatalog = await getAvailableExtensions();
    return cachedCatalog;
  }

  const extensionsList: ToolInstance = {
    name: 'extensions_list',
    description: 'List curated AgentOS extension packs (and whether they are available/installed).',
    category: 'system',
    hasSideEffects: false,
    inputSchema: {
      type: 'object',
      properties: {
        includeUnavailable: { type: 'boolean', default: false },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional filter. Example: ["tool","integration"]',
        },
      },
      additionalProperties: false,
    },
    execute: async (args): Promise<{ success: boolean; output?: unknown; error?: string }> => {
      const includeUnavailable = args?.includeUnavailable === true;
      const categories = Array.isArray(args?.categories) ? (args.categories as any[]) : null;

      const catalog = await getCatalog();
      const filtered = catalog.filter((e) => {
        if (!includeUnavailable && e.available === false) return false;
        if (categories && categories.length > 0 && !categories.includes(e.category)) return false;
        return true;
      });

      const out: ExtensionsListOutput = {
        curated: filtered,
        packagePacks: opts.packagePacks
          ? Object.entries(PACKAGE_PACKS).map(([name, pack]) => ({ name, packageName: pack.package }))
          : [],
        enabledPackages: [...enabledPackages.values()].sort(),
      };
      return { success: true, output: out };
    },
  };

  /**
   * Loads a package pack as `start`'s loader does (`createPackagePack`), activates it, adds its
   * tools, narrows them by the agent's tool settings and mounts its HTTP handler only when they
   * keep every one of its tools.
   */
  async function enablePackagePack(
    ref: string,
    source: 'curated' | 'package',
    packageEntry: ReturnType<typeof packagePackEntries>[number],
    toolContext: unknown,
  ): Promise<{ success: boolean; output?: unknown; error?: string }> {
    const host = opts.packagePacks ?? {};
    const getSecret = host.getSecret ?? opts.getSecret;
    let pack: any;
    try {
      pack = await createPackagePack(packageEntry, { getSecret, logger: log });
      await pack?.onActivate?.({ logger: log, getSecret });
    } catch (err: any) {
      return { success: false, error: `Failed to load ${packageEntry.package}: ${err?.message ?? String(err)}` };
    }
    host.onPackLoaded?.(pack);

    const tools = (Array.isArray(pack?.descriptors) ? pack.descriptors : [])
      .filter((d: any) => d?.kind === 'tool')
      .map((d: any) => d?.payload)
      .filter((t: any) => t && typeof t.name === 'string') as ToolInstance[];
    const toolsAdded: string[] = [];
    const toolsUpdated: string[] = [];
    for (const tool of tools) {
      (opts.toolMap.has(tool.name) ? toolsUpdated : toolsAdded).push(tool.name);
      opts.toolMap.set(tool.name, tool);
    }
    enabledPackages.add(packageEntry.package);

    // The same narrowing start applies at startup: the permission set, the tool access profile
    // and tools.allow. A turn's own permission set narrows it further, as for any pack.
    const dropped = new Set<string>(host.confine?.(opts.toolMap, tools.map((t) => t.name)) ?? []);
    const permissionSet = typeof (toolContext as any)?.permissionSet === 'string' ? String((toolContext as any).permissionSet) : '';
    const toolAccessProfileRaw = typeof (toolContext as any)?.toolAccessProfile === 'string' ? String((toolContext as any).toolAccessProfile) : '';
    if (permissionSet && toolAccessProfileRaw) {
      const kept = new Map(tools.filter((t) => opts.toolMap.has(t.name)).map((t) => [t.name, opts.toolMap.get(t.name)!] as const));
      const filtered = filterToolMapByPolicy({
        toolMap: kept,
        toolAccessProfile: normalizeToolAccessProfile(toolAccessProfileRaw),
        permissions: getPermissionsForSet(permissionSet as any),
      });
      for (const name of kept.keys()) {
        if (filtered.toolMap.has(name)) continue;
        opts.toolMap.delete(name);
        dropped.add(name);
      }
    }
    const toolsKept = [...toolsAdded, ...toolsUpdated].filter((name) => opts.toolMap.has(name));
    if (toolsKept.length > 0) opts.onToolsChanged?.(toolsKept);

    // The handler serves every one of the pack's tools to callers outside the agent's turns.
    let httpEndpoint: 'mounted' | 'not_mounted' | undefined;
    const service = packageHttpServiceOf(pack);
    if (service) {
      const missing = toolsDroppedFrom(service, opts.toolMap);
      if (missing.length === 0 && host.mountHttpHandlers) {
        host.mountHttpHandlers(service.handlers);
        httpEndpoint = 'mounted';
      } else {
        httpEndpoint = 'not_mounted';
        log.info?.(
          `${service.pack}: HTTP endpoint not mounted; the agent's tool settings drop ${missing.length} of its ${service.tools.length} tools`,
        );
      }
    }

    const toolsBlockedByPolicy = [...dropped].sort();
    const out: ExtensionsEnableOutput = {
      extension: ref,
      source,
      packageName: packageEntry.package,
      loaded: true,
      toolsAdded: toolsAdded.sort(),
      toolsUpdated: toolsUpdated.sort(),
      ...(toolsBlockedByPolicy.length > 0 ? { toolsBlockedByPolicy } : null),
      ...(httpEndpoint ? { httpEndpoint } : null),
    };
    return { success: true, output: out };
  }

  const extensionsEnable: ToolInstance = {
    name: 'extensions_enable',
    description:
      'Enable (load) a curated extension pack at runtime so its tool schemas become available in the next LLM round. This has side effects and should be human-approved.',
    category: 'system',
    hasSideEffects: true,
    inputSchema: {
      type: 'object',
      required: ['extension'],
      properties: {
        extension: { type: 'string', description: "Curated name (e.g. 'web-search') or package name." },
        source: { type: 'string', enum: ['curated', 'package'], default: 'curated' },
        options: { type: 'object', additionalProperties: true, description: 'Pack options override.' },
        dryRun: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    execute: async (args, toolContext): Promise<{ success: boolean; output?: unknown; error?: string }> => {
      const input = (args ?? {}) as Partial<ExtensionsEnableInput>;

      const ref = typeof input.extension === 'string' ? normalizeExtensionName(input.extension) : '';
      if (!ref) return { success: false, error: 'Missing required field: extension' };

      const source: 'curated' | 'package' = input.source === 'package' ? 'package' : 'curated';
      const wantsPackage = source === 'package' || ref.startsWith('@');
      const dryRun = input.dryRun === true;
      const userOptions =
        input.options && typeof input.options === 'object' && !Array.isArray(input.options)
          ? (input.options as Record<string, unknown>)
          : undefined;

      const catalog = await getCatalog();
      // A pack the curated registry does not list, named by its config name or its npm package.
      // Only a host that gives packagePacks (start) loads one: the others have no narrowing,
      // handler rule or shutdown for it, and do not read its extensionOverrides entry.
      const packagePack = opts.packagePacks ? packagePackFor(ref) : undefined;

      if (allowedPackages) {
        // A pack is allowed when the list names it by its curated name or its
        // package name; an unknown name is outside the list.
        const named = catalog.find((e) => e.name === ref || e.packageName === ref);
        const names = [ref, named?.name, named?.packageName, packagePack?.name, packagePack?.package].filter(Boolean) as string[];
        if (!names.some((name) => allowedPackages.has(name))) {
          logToolRefusal({ kind: 'pack', name: ref });
          return { success: false, error: TOOL_NOT_ALLOWED };
        }
      }

      let entry: ExtensionInfo | undefined;
      let packageName: string | undefined;
      let packageEntry: ReturnType<typeof packagePackEntries>[number] | undefined;

      if (packagePack) {
        // Loaded as start's loader loads it, with the options the agent config gives it; a model's
        // options could send the studio key to another host.
        if (userOptions && Object.keys(userOptions).length > 0) {
          return {
            success: false,
            error: `${packagePack.name} takes its options from extensionOverrides.${packagePack.name} in the agent config, not from extensions_enable.`,
          };
        }
        packageEntry = packagePackEntries([packagePack.name], opts.packagePacks?.overrides ?? {})[0];
        if (!packageEntry) {
          return { success: false, error: `${packagePack.name} is disabled by extensionOverrides.${packagePack.name}.enabled.` };
        }
        packageName = packagePack.package;
      } else if (wantsPackage) {
        if (!allowPackages) {
          return {
            success: false,
            error: "Package loading is disabled (set allowPackages=true, or use source='curated' with a curated name).",
          };
        }

        packageName = ref;
        entry = catalog.find((e) => e.packageName === packageName);

        if (!entry && !allowUnknownPackages) {
          return { success: false, error: `Unknown extension package: ${packageName}` };
        }
      } else {
        entry = catalog.find((e) => e.name === ref || e.packageName === ref);
        packageName = entry?.packageName;
        if (!packageName) return { success: false, error: `Unknown extension: ${ref}` };
      }

      if (dryRun) {
        const out: ExtensionsEnableOutput = {
          extension: ref,
          source,
          packageName,
          available: entry?.available,
          loaded: false,
          skipped: true,
          reason: 'dry_run',
          toolsAdded: [],
          toolsUpdated: [],
        };
        return { success: true, output: out };
      }

      if (enabledPackages.has(packageName)) {
        const out: ExtensionsEnableOutput = {
          extension: ref,
          source,
          packageName,
          available: entry?.available,
          loaded: false,
          skipped: true,
          reason: 'already_loaded',
          toolsAdded: [],
          toolsUpdated: [],
        };
        return { success: true, output: out };
      }

      if (packageEntry) return enablePackagePack(ref, source, packageEntry, toolContext);

      const defaults = buildDefaultPackOptions(packageName, opts.runtimeDefaults);
      const extensionDefaults =
        entry?.name && opts.defaultExtensionOptions?.[entry.name]
          ? opts.defaultExtensionOptions[entry.name]
          : undefined;
      const extensionDefaultOptions =
        extensionDefaults
        && typeof extensionDefaults === 'object'
        && !Array.isArray(extensionDefaults)
        && extensionDefaults['options']
        && typeof extensionDefaults['options'] === 'object'
        && !Array.isArray(extensionDefaults['options'])
          ? (extensionDefaults['options'] as Record<string, unknown>)
          : extensionDefaults;
      const extensionDefaultPriority =
        extensionDefaults
        && typeof extensionDefaults === 'object'
        && !Array.isArray(extensionDefaults)
        && typeof extensionDefaults['priority'] === 'number'
          ? (extensionDefaults['priority'] as number)
          : undefined;
      const resolvedSecrets = Object.fromEntries(
        (entry?.requiredSecrets ?? [])
          .map((secretId) => {
            const value = opts.getSecret?.(secretId);
            return value ? [secretId, value] : null;
          })
          .filter((pair): pair is [string, string] => Array.isArray(pair)),
      );
      const packOptions = {
        ...((opts.secrets || Object.keys(resolvedSecrets).length > 0)
          ? { secrets: { ...(opts.secrets ?? {}), ...resolvedSecrets } }
          : {}),
        ...defaults,
        ...(extensionDefaultOptions ?? {}),
        ...(typeof extensionDefaultPriority === 'number' ? { priority: extensionDefaultPriority } : {}),
        ...(userOptions ?? {}),
      };

      let pack: any;
      if (typeof entry?.createPack === 'function') {
        pack = await entry.createPack({
          options: packOptions,
          logger: log,
          getSecret: opts.getSecret,
        });
      } else {
        let mod: any;
        try {
          mod = await import(packageName);
        } catch (err: any) {
          return { success: false, error: `Failed to import ${packageName}: ${err?.message ?? String(err)}` };
        }

        const factory = getFactory(mod);
        if (!factory) {
          return { success: false, error: `Extension ${packageName} does not export createExtensionPack()` };
        }

        pack = await factory({ options: packOptions, logger: log, getSecret: opts.getSecret });
      }

      try {
        await pack?.onActivate?.({
          logger: log,
          getSecret: (key: string) => {
            const fromResolver = opts.getSecret?.(key);
            if (typeof fromResolver === 'string' && fromResolver.length > 0) return fromResolver;
            const fromPackSecrets = (packOptions as Record<string, unknown>)?.secrets;
            if (fromPackSecrets && typeof fromPackSecrets === 'object') {
              const val = (fromPackSecrets as Record<string, unknown>)[key];
              return typeof val === 'string' ? val : undefined;
            }
            return undefined;
          },
        });
      } catch (err: any) {
        return {
          success: false,
          error: `Extension ${packageName} onActivate failed: ${err?.message ?? String(err)}`,
        };
      }

      const toolDescriptors = Array.isArray(pack?.descriptors)
        ? pack.descriptors.filter((d: any) => d?.kind === 'tool')
        : [];

      const tools = toolDescriptors
        .map((d: any) => d?.payload)
        .filter((t: any) => t && typeof t.name === 'string') as ToolInstance[];

      const toolsAdded: string[] = [];
      const toolsUpdated: string[] = [];

      for (const tool of tools) {
        if (opts.toolMap.has(tool.name)) {
          toolsUpdated.push(tool.name);
        } else {
          toolsAdded.push(tool.name);
        }
        opts.toolMap.set(tool.name, tool);
      }

      enabledPackages.add(packageName);

      // Notify caller so discovery can re-index
      if (toolsAdded.length > 0) {
        opts.onToolsChanged?.(toolsAdded);
      }

      let toolsBlockedByPolicy: string[] | undefined;
      // Enforce permission set + tool access profile after dynamic extension loads.
      try {
        const permissionSet = (toolContext && typeof (toolContext as any).permissionSet === 'string')
          ? String((toolContext as any).permissionSet)
          : '';
        const toolAccessProfileRaw = (toolContext && typeof (toolContext as any).toolAccessProfile === 'string')
          ? String((toolContext as any).toolAccessProfile)
          : '';
        if (permissionSet && toolAccessProfileRaw) {
          const filtered = filterToolMapByPolicy({
            toolMap: opts.toolMap,
            toolAccessProfile: normalizeToolAccessProfile(toolAccessProfileRaw),
            permissions: getPermissionsForSet(permissionSet as any),
          });
          opts.toolMap.clear();
          for (const [k, v] of filtered.toolMap.entries()) opts.toolMap.set(k, v);

          toolsBlockedByPolicy = [...toolsAdded, ...toolsUpdated]
            .filter((t) => !opts.toolMap.has(t))
            .sort();
        }
      } catch {
        // Best-effort only; if filtering fails, keep loaded tools.
      }

      const out: ExtensionsEnableOutput = {
        extension: ref,
        source,
        packageName,
        available: entry?.available,
        loaded: true,
        toolsAdded: toolsAdded.sort(),
        toolsUpdated: toolsUpdated.sort(),
        ...(toolsBlockedByPolicy && toolsBlockedByPolicy.length > 0 ? { toolsBlockedByPolicy } : null),
      };

      return { success: true, output: out };
    },
  };

  const extensionsStatus: ToolInstance = {
    name: 'extensions_status',
    description: 'Show which extension packages were enabled during this session.',
    category: 'system',
    hasSideEffects: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (): Promise<{ success: boolean; output?: unknown; error?: string }> => {
      return {
        success: true,
        output: { enabledPackages: [...enabledPackages.values()].sort(), toolCount: opts.toolMap.size },
      };
    },
  };

  return [extensionsList, extensionsEnable, extensionsStatus];
}
