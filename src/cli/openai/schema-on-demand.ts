/**
 * @fileoverview Schema-on-demand meta tools for Wunderland's CLI tool-calling loop.
 *
 * These tools let the model enable curated extension packs at runtime so the
 * next OpenAI round includes the newly-available tool schemas.
 */

import { getAvailableExtensions, type ExtensionInfo } from '@framers/agentos-extensions-registry';

import type { ToolInstance } from './tool-calling.js';

type ExtensionsListOutput = {
  curated: ExtensionInfo[];
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
      return { elevenLabsApiKey: process.env['ELEVENLABS_API_KEY'] };
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
  logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void; error?: (...args: any[]) => void };
}): ToolInstance[] {
  const enabledPackages = new Set<string>();
  const log = opts.logger ?? console;
  const allowPackages =
    typeof opts.allowPackages === 'boolean' ? opts.allowPackages : process.env['NODE_ENV'] !== 'production';
  const allowUnknownPackages = opts.allowUnknownPackages === true;

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
        enabledPackages: [...enabledPackages.values()].sort(),
      };
      return { success: true, output: out };
    },
  };

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
    execute: async (args): Promise<{ success: boolean; output?: unknown; error?: string }> => {
      const input = (args ?? {}) as Partial<ExtensionsEnableInput>;

      const ref = typeof input.extension === 'string' ? input.extension.trim() : '';
      if (!ref) return { success: false, error: 'Missing required field: extension' };

      const source: 'curated' | 'package' = input.source === 'package' ? 'package' : 'curated';
      const wantsPackage = source === 'package' || ref.startsWith('@');
      const dryRun = input.dryRun === true;
      const userOptions =
        input.options && typeof input.options === 'object' && !Array.isArray(input.options)
          ? (input.options as Record<string, unknown>)
          : undefined;

      const catalog = await getCatalog();

      let entry: ExtensionInfo | undefined;
      let packageName: string | undefined;

      if (wantsPackage) {
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

      if (entry && entry.available === false) {
        return { success: false, error: `Extension package is not installed/available: ${packageName}` };
      }

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

      const defaults = buildDefaultPackOptions(packageName, opts.runtimeDefaults);
      const packOptions = { ...defaults, ...(userOptions ?? {}) };
      const pack = factory({ options: packOptions, logger: log });

      try {
        await pack?.onActivate?.({
          logger: log,
          getSecret: () => undefined,
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

      const out: ExtensionsEnableOutput = {
        extension: ref,
        source,
        packageName,
        available: entry?.available,
        loaded: true,
        toolsAdded: toolsAdded.sort(),
        toolsUpdated: toolsUpdated.sort(),
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
