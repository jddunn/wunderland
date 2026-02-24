/**
 * @fileoverview WunderlandDiscoveryManager — high-level wrapper for capability discovery.
 * @module wunderland/discovery/WunderlandDiscoveryManager
 *
 * Handles all wunderland-specific concerns for the CapabilityDiscoveryEngine:
 * - Creates EmbeddingManager + InMemoryVectorStore internally
 * - Resolves embedding provider from LLM config
 * - Gathers CapabilityIndexSources from loaded tools/skills
 * - Derives preset co-occurrences from agent presets
 * - Manages CapabilityManifestScanner lifecycle
 * - Creates discover_capabilities meta-tool
 */

import type { ITool } from '@framers/agentos';
import type {
  CapabilityDiscoveryConfig,
  CapabilityDiscoveryResult,
  CapabilityIndexSources,
  ICapabilityDiscoveryEngine,
} from '@framers/agentos/discovery';
import {
  CapabilityDiscoveryEngine,
  CapabilityManifestScanner,
  createDiscoverCapabilitiesTool,
} from '@framers/agentos/discovery';
import { EmbeddingManager, InMemoryVectorStore } from '@framers/agentos';
import { AIModelProviderManager } from '@framers/agentos';

import { derivePresetCoOccurrences } from './preset-co-occurrence.js';

// ============================================================================
// TYPES
// ============================================================================

export interface WunderlandDiscoveryConfig {
  /** Enable/disable discovery. Default: true when embedding available. */
  enabled?: boolean;
  /** Discovery engine tuning. */
  config?: Partial<CapabilityDiscoveryConfig>;
  /** Explicit embedding provider override (e.g., 'openai', 'ollama'). */
  embeddingProvider?: string;
  /** Explicit embedding model override. */
  embeddingModel?: string;
  /** Whether to scan ~/.wunderland/capabilities/ for CAPABILITY.yaml files. Default: true. */
  scanManifestDirs?: boolean;
  /** Whether to register discover_capabilities meta-tool. Default: true. */
  registerMetaTool?: boolean;
}

export interface WunderlandDiscoveryStats {
  enabled: boolean;
  initialized: boolean;
  capabilityCount: number;
  graphNodes: number;
  graphEdges: number;
  presetCoOccurrences: number;
  manifestDirs: string[];
}

/** Minimal tool shape for source gathering (matches ToolInstance from runtime/tool-calling). */
interface ToolLike {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  hasSideEffects?: boolean;
  category?: string;
  requiredCapabilities?: string[];
}

/** Skill entry for indexing. */
export interface SkillEntry {
  name: string;
  description: string;
  content: string;
  category?: string;
  tags?: string[];
  requiredSecrets?: string[];
  requiredTools?: string[];
}

// ============================================================================
// EMBEDDING PROVIDER RESOLUTION
// ============================================================================

/** Maps LLM provider IDs to their default embedding model configurations. */
const EMBEDDING_PROVIDER_MAP: Record<string, { model: string; dimension: number }> = {
  openai:      { model: 'text-embedding-3-small', dimension: 1536 },
  openrouter:  { model: 'openai/text-embedding-3-small', dimension: 1536 },
  anthropic:   { model: 'text-embedding-3-small', dimension: 1536 }, // Falls back to OpenAI
  ollama:      { model: 'nomic-embed-text', dimension: 768 },
  groq:        { model: 'text-embedding-3-small', dimension: 1536 }, // Falls back to OpenAI
};

function resolveEmbeddingConfig(opts: {
  embeddingProvider?: string;
  embeddingModel?: string;
  llmProviderId: string;
  llmApiKey: string;
  llmBaseUrl?: string;
}): { providerId: string; apiKey: string; model: string; dimension: number; baseUrl?: string } | null {
  // Explicit override
  const providerHint = opts.embeddingProvider || opts.llmProviderId;
  const defaults = EMBEDDING_PROVIDER_MAP[providerHint];
  if (!defaults) return null;

  const model = opts.embeddingModel || defaults.model;
  const dimension = defaults.dimension;

  // For non-OpenAI providers that use OpenAI embeddings, check for OPENAI_API_KEY
  let apiKey = opts.llmApiKey;
  let providerId = providerHint;
  let baseUrl = opts.llmBaseUrl;

  if (providerHint === 'anthropic' || providerHint === 'groq') {
    // These don't have their own embedding API — fall back to OpenAI
    const openaiKey = process.env['OPENAI_API_KEY'];
    if (!openaiKey) return null;
    apiKey = openaiKey;
    providerId = 'openai';
    baseUrl = undefined;
  }

  if (providerHint === 'openrouter') {
    // OpenRouter uses its own API key but OpenAI-compatible endpoint
    baseUrl = 'https://openrouter.ai/api/v1';
  }

  if (!apiKey) return null;

  return { providerId, apiKey, model, dimension, baseUrl };
}

// ============================================================================
// WUNDERLAND DISCOVERY MANAGER
// ============================================================================

export class WunderlandDiscoveryManager {
  private _engine: CapabilityDiscoveryEngine | null = null;
  private scanner: CapabilityManifestScanner | null = null;
  private _metaTool: ITool | null = null;
  private _enabled = false;
  private _initialized = false;
  private _manifestDirs: string[] = [];
  private _presetCoOccurrenceCount = 0;
  private embeddingManager: EmbeddingManager | null = null;
  private vectorStore: InMemoryVectorStore | null = null;

  constructor(private readonly config: WunderlandDiscoveryConfig = {}) {}

  /** The underlying discovery engine (null if not initialized). */
  get engine(): ICapabilityDiscoveryEngine | null {
    return this._engine;
  }

  /**
   * Initialize the discovery engine.
   *
   * @param opts.toolMap - Loaded tools from CLI or library API
   * @param opts.skillEntries - Optional loaded skill data
   * @param opts.llmConfig - LLM provider config for embedding provider resolution
   */
  async initialize(opts: {
    toolMap: Map<string, ToolLike>;
    skillEntries?: SkillEntry[];
    llmConfig: { providerId: string; apiKey: string; baseUrl?: string };
  }): Promise<void> {
    if (this.config.enabled === false) return;

    // 1. Resolve embedding provider
    const embeddingConfig = resolveEmbeddingConfig({
      embeddingProvider: this.config.embeddingProvider,
      embeddingModel: this.config.embeddingModel,
      llmProviderId: opts.llmConfig.providerId,
      llmApiKey: opts.llmConfig.apiKey,
      llmBaseUrl: opts.llmConfig.baseUrl,
    });

    if (!embeddingConfig) {
      // No embedding provider available — discovery disabled
      return;
    }

    // 2. Create AIModelProviderManager
    const providerManager = new AIModelProviderManager();
    await providerManager.initialize({
      providers: [{
        providerId: embeddingConfig.providerId,
        enabled: true,
        isDefault: true,
        config: {
          apiKey: embeddingConfig.apiKey,
          ...(embeddingConfig.baseUrl ? { baseURL: embeddingConfig.baseUrl } : {}),
        },
      }],
    });

    // 3. Create EmbeddingManager
    this.embeddingManager = new EmbeddingManager();
    await this.embeddingManager.initialize(
      {
        embeddingModels: [{
          modelId: embeddingConfig.model,
          providerId: embeddingConfig.providerId,
          dimension: embeddingConfig.dimension,
          isDefault: true,
        }],
        defaultModelId: embeddingConfig.model,
        enableCache: true,
        cacheMaxSize: 500,
        cacheTTLSeconds: 3600,
      },
      providerManager,
    );

    // 4. Create InMemoryVectorStore
    this.vectorStore = new InMemoryVectorStore();
    await this.vectorStore.initialize({
      id: 'wunderland-discovery',
      type: 'in_memory',
    });

    // 5. Create discovery engine
    this._engine = new CapabilityDiscoveryEngine(
      this.embeddingManager,
      this.vectorStore,
      this.config.config,
    );

    // 6. Gather capability sources
    const sources = this.gatherSources(opts.toolMap, opts.skillEntries);

    // 7. Scan manifest directories
    if (this.config.scanManifestDirs !== false) {
      try {
        this.scanner = new CapabilityManifestScanner();
        this._manifestDirs = this.scanner.getDefaultDirs();
        const manifests = await this.scanner.scan();
        if (manifests.length > 0) {
          sources.manifests = [...(sources.manifests ?? []), ...manifests];
        }
      } catch {
        // Non-fatal — manifest directories may not exist
      }
    }

    // 8. Derive preset co-occurrences
    const coOccurrences = derivePresetCoOccurrences();
    this._presetCoOccurrenceCount = coOccurrences.length;

    // 9. Initialize engine
    await this._engine.initialize(sources, coOccurrences);

    // 10. Create meta-tool
    if (this.config.registerMetaTool !== false && this._engine) {
      this._metaTool = createDiscoverCapabilitiesTool(this._engine);
    }

    this._enabled = true;
    this._initialized = true;
  }

  /**
   * Per-turn discovery. Returns result compatible with PromptBuilder or null.
   */
  async discoverForTurn(userMessage: string): Promise<CapabilityDiscoveryResult | null> {
    if (!this._initialized || !this._engine) return null;

    try {
      const result = await this._engine.discover(userMessage);
      // Debug: log which capabilities were selected
      const tier1Names = result?.tier1?.map((c) => `${c.capability?.name ?? '?'}(${c.relevanceScore?.toFixed(2)})`).join(', ') ?? 'none';
      const tier2Names = result?.tier2?.map((c) => c.capability?.name ?? '?').join(', ') ?? 'none';
      console.log(`[Discovery] "${userMessage.slice(0, 60)}" → T1:[${tier1Names}] T2:[${tier2Names}]`);
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Get the meta-tool for agent self-discovery.
   */
  getMetaTool(): ITool | null {
    return this._metaTool;
  }

  /**
   * Get discovery engine stats.
   */
  getStats(): WunderlandDiscoveryStats {
    const engineStats = this._engine?.getStats();
    return {
      enabled: this._enabled,
      initialized: this._initialized,
      capabilityCount: engineStats?.capabilityCount ?? 0,
      graphNodes: engineStats?.graphNodes ?? 0,
      graphEdges: engineStats?.graphEdges ?? 0,
      presetCoOccurrences: this._presetCoOccurrenceCount,
      manifestDirs: this._manifestDirs,
    };
  }

  /**
   * Teardown: stop file watchers, release resources.
   */
  async close(): Promise<void> {
    if (this.scanner) {
      this.scanner.stopWatching();
      this.scanner = null;
    }
    if (this.vectorStore) {
      try { await this.vectorStore.shutdown(); } catch { /* ignore */ }
      this.vectorStore = null;
    }
    if (this.embeddingManager) {
      try { await this.embeddingManager.shutdown?.(); } catch { /* ignore */ }
      this.embeddingManager = null;
    }
    this._engine = null;
    this._metaTool = null;
    this._initialized = false;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Gather CapabilityIndexSources from loaded tools and skills.
   */
  private gatherSources(
    toolMap: Map<string, ToolLike>,
    skillEntries?: SkillEntry[],
  ): CapabilityIndexSources {
    const tools: CapabilityIndexSources['tools'] = [];
    for (const [, tool] of toolMap) {
      tools.push({
        id: `tool:${tool.name}`,
        name: tool.name,
        displayName: tool.name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        description: tool.description || '',
        category: tool.category || 'productivity',
        inputSchema: tool.inputSchema,
        hasSideEffects: tool.hasSideEffects,
      });
    }

    const skills: CapabilityIndexSources['skills'] = [];
    if (skillEntries) {
      for (const skill of skillEntries) {
        skills.push({
          name: skill.name,
          description: skill.description || '',
          content: skill.content || '',
          category: skill.category,
          tags: skill.tags,
          requiredSecrets: skill.requiredSecrets,
          requiredTools: skill.requiredTools,
        });
      }
    }

    return { tools, skills };
  }
}
