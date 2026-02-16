/**
 * @fileoverview Resolves preset extension suggestions into ExtensionManifests.
 * @module wunderland/core/PresetExtensionResolver
 *
 * Similar to PresetSkillResolver but for extensions (tools, voice, productivity).
 * Works with @framers/agentos-extensions-registry to auto-load extensions based on preset config.
 */

import { PresetLoader } from './PresetLoader.js';

// Use local interfaces to avoid hard dependency on the registry types.
interface ExtensionManifest {
  packs: Array<{
    name: string;
    factory: (...args: any[]) => any;
    priority?: number;
  }>;
}

interface ExtensionInfo {
  name: string;
  displayName: string;
  category: string;
  available: boolean;
}

export interface ExtensionResolutionResult {
  manifest: ExtensionManifest;
  missing: string[];
  blocked: string[];
}

// Registry options structure (mirrors the registry's RegistryOptions)
interface RegistryOptions {
  secrets?: Record<string, string>;
  tools?: string[] | 'all' | 'none';
  voice?: string[] | 'all' | 'none';
  productivity?: string[] | 'all' | 'none';
  channels?: string[] | 'all' | 'none';
  overrides?: Record<string, { enabled?: boolean; priority?: number; options?: unknown }>;
}

const EMPTY_MANIFEST: ExtensionManifest = {
  packs: [],
};

/**
 * Resolves a preset's suggested extensions into a full ExtensionManifest.
 *
 * @param presetId - Preset identifier (e.g., "research-assistant")
 * @param options - Additional registry options (secrets, overrides)
 * @returns ExtensionManifest ready for AgentOS + list of missing/blocked extensions
 *
 * @example
 * ```typescript
 * const result = await resolvePresetExtensions('research-assistant');
 * console.log(result.manifest.packs.length); // 3 (web-search, web-browser, news-search)
 * console.log(result.missing); // []
 * ```
 */
export async function resolvePresetExtensions(
  presetId: string,
  options?: Partial<RegistryOptions>,
): Promise<ExtensionResolutionResult> {
  const loader = new PresetLoader();
  const preset = loader.loadPreset(presetId);

  // Extract extension suggestions from preset
  const tools = (preset as any).suggestedExtensions?.tools ?? [];
  const voice = (preset as any).suggestedExtensions?.voice ?? [];
  const productivity = (preset as any).suggestedExtensions?.productivity ?? [];
  const overrides = (preset as any).extensionOverrides;

  return resolveExtensionsByNames(tools, voice, productivity, overrides, options);
}

/**
 * Resolves extension names into a manifest.
 *
 * @param tools - Tool extension names
 * @param voice - Voice provider extension names
 * @param productivity - Productivity extension names
 * @param overrides - Per-extension overrides (enabled, priority, options)
 * @param options - Registry options (secrets, etc.)
 * @returns ExtensionManifest + missing/blocked lists
 *
 * @example
 * ```typescript
 * const result = await resolveExtensionsByNames(
 *   ['web-search', 'web-browser'],
 *   [],
 *   [],
 *   { 'web-search': { priority: 25 } }
 * );
 * ```
 */
export async function resolveExtensionsByNames(
  tools: string[],
  voice: string[],
  productivity: string[],
  overrides?: Record<string, { enabled?: boolean; priority?: number; options?: unknown }>,
  options?: Partial<RegistryOptions>,
): Promise<ExtensionResolutionResult> {
  const allExtensionNames = [...tools, ...voice, ...productivity];

  if (allExtensionNames.length === 0) {
    return {
      manifest: { ...EMPTY_MANIFEST },
      missing: [],
      blocked: [],
    };
  }

  try {
    // Dynamic import to avoid hard dependency
    const registryModule: string = '@framers/agentos-extensions-registry';
    const registry: any = await import(registryModule);

    // Check which extensions are actually installed/available
    const availableExtensions: ExtensionInfo[] = await registry.getAvailableExtensions();
    const availableNames = new Set(
      availableExtensions.filter((e) => e.available).map((e) => e.name),
    );

    // Filter to only available extensions
    const validTools = tools.filter((name) => {
      if (!availableNames.has(name)) {
        console.warn(
          `[extensions] Extension "${name}" not available in registry, skipping`,
        );
        return false;
      }
      return true;
    });

    const validVoice = voice.filter((name) => {
      if (!availableNames.has(name)) {
        console.warn(
          `[extensions] Extension "${name}" not available in registry, skipping`,
        );
        return false;
      }
      return true;
    });

    const validProd = productivity.filter((name) => {
      if (!availableNames.has(name)) {
        console.warn(
          `[extensions] Extension "${name}" not available in registry, skipping`,
        );
        return false;
      }
      return true;
    });

    // Track missing extensions
    const missing = [
      ...tools.filter((name) => !availableNames.has(name)),
      ...voice.filter((name) => !availableNames.has(name)),
      ...productivity.filter((name) => !availableNames.has(name)),
    ];

    // Build registry options
    const registryOptions: Partial<RegistryOptions> = {
      ...options,
      tools: validTools.length > 0 ? validTools : 'none',
      voice: validVoice.length > 0 ? validVoice : 'none',
      productivity: validProd.length > 0 ? validProd : 'none',
      // Default channels to 'none' unless explicitly provided — prevents loading
      // all channel extensions (and their noisy missing-token warnings).
      channels: options?.channels ?? 'none',
      overrides: {
        ...options?.overrides,
        ...overrides,
      },
    };

    // Create manifest with filtered extensions
    const manifest = await registry.createCuratedManifest(registryOptions);

    return {
      manifest: manifest as ExtensionManifest,
      missing,
      blocked: [],
    };
  } catch (err) {
    console.warn(
      '[extensions] Could not resolve extensions:',
      err instanceof Error ? err.message : String(err),
    );

    // Return empty manifest if registry not available
    return {
      manifest: { ...EMPTY_MANIFEST },
      missing: allExtensionNames,
      blocked: [],
    };
  }
}

/**
 * Cache for resolved extension manifests (keyed by preset ID + hash of options).
 * Useful for avoiding repeated resolution in the same session.
 */
const manifestCache = new Map<string, ExtensionManifest>();

/**
 * Resolves preset extensions with caching for performance.
 *
 * @param presetId - Preset identifier
 * @param options - Registry options
 * @returns Cached or freshly resolved manifest + missing/blocked lists
 *
 * @example
 * ```typescript
 * // First call resolves and caches
 * const result1 = await resolvePresetExtensionsCached('research-assistant');
 *
 * // Second call returns cached manifest
 * const result2 = await resolvePresetExtensionsCached('research-assistant');
 * ```
 */
export async function resolvePresetExtensionsCached(
  presetId: string,
  options?: Partial<RegistryOptions>,
): Promise<ExtensionResolutionResult> {
  const cacheKey = `${presetId}:${JSON.stringify(options?.secrets || {})}`;

  if (manifestCache.has(cacheKey)) {
    return {
      manifest: manifestCache.get(cacheKey)!,
      missing: [],
      blocked: [],
    };
  }

  const result = await resolvePresetExtensions(presetId, options);
  if (result.manifest.packs.length > 0) {
    manifestCache.set(cacheKey, result.manifest);
  }

  return result;
}

/**
 * Clears the extension manifest cache.
 * Useful for testing or when registry contents change at runtime.
 */
export function clearExtensionCache(): void {
  manifestCache.clear();
}
