/**
 * @fileoverview Discovery module for Wunderland.
 * @module wunderland/discovery
 *
 * Re-exports core discovery primitives from AgentOS and provides
 * WunderlandDiscoveryManager for higher-level integration.
 *
 * @example
 * ```typescript
 * import { WunderlandDiscoveryManager } from 'wunderland/discovery';
 *
 * const manager = new WunderlandDiscoveryManager({ registerMetaTool: true });
 * await manager.initialize({ toolMap, llmConfig: { providerId: 'openai', apiKey } });
 *
 * const result = await manager.discoverForTurn("search the web for AI news");
 * ```
 */

// Re-export all discovery types from AgentOS
export type {
  CapabilityKind,
  CapabilitySourceRef,
  CapabilityDescriptor,
  CapabilityTier,
  Tier1Result,
  Tier2Result,
  TokenEstimate,
  DiscoveryDiagnostics,
  CapabilityDiscoveryResult,
  CapabilityDiscoveryConfig,
  CapabilityEdgeType,
  CapabilityEdge,
  RelatedCapability,
  ICapabilityGraph,
  PresetCoOccurrence,
  CapabilitySearchResult,
  CapabilityIndexSources,
  CapabilityManifestFile,
  DiscoveryQueryOptions,
  ICapabilityDiscoveryEngine,
} from '@framers/agentos/discovery';

export { DEFAULT_DISCOVERY_CONFIG } from '@framers/agentos/discovery';

// Re-export core discovery classes from AgentOS
export {
  CapabilityDiscoveryEngine,
  CapabilityIndex,
  CapabilityGraph,
  CapabilityContextAssembler,
  CapabilityEmbeddingStrategy,
  CapabilityManifestScanner,
  createDiscoverCapabilitiesTool,
} from '@framers/agentos/discovery';

// Wunderland-specific manager
export {
  WunderlandDiscoveryManager,
  type WunderlandDiscoveryConfig,
  type DiscoveryRecallProfile,
  type WunderlandDiscoveryStats,
  type SkillEntry as DiscoverySkillEntry,
} from './WunderlandDiscoveryManager.js';

// Preset co-occurrence helper
export { derivePresetCoOccurrences } from './preset-co-occurrence.js';
