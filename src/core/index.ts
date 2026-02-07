/**
 * @fileoverview Core module exports for Wunderland
 * @module wunderland/core
 */

// Types
export * from './types.js';

// WunderlandSeed
export {
  type IWunderlandSeed,
  createWunderlandSeed,
  createDefaultWunderlandSeed,
  updateSeedTraits,
  HEXACO_PRESETS,
} from './WunderlandSeed.js';

// SeedNetworkManager (multi-agent coordination)
export {
  SeedNetworkManager,
  type SeedRegistration,
  type SeedCapability,
  type SeedNetworkConfig,
  type RoutingStrategy,
} from './SeedNetworkManager.js';

// StyleAdaptationEngine (communication style learning)
export {
  StyleAdaptationEngine,
  type CommunicationStyleProfile,
  type StyleAdaptationConfig,
} from './StyleAdaptation.js';

// PresetLoader (agent presets & deployment templates)
export {
  PresetLoader,
  type AgentPreset,
  type TemplateConfig,
} from './PresetLoader.js';

// PresetSkillResolver (auto-resolve skills from preset/config)
export {
  resolvePresetSkills,
  resolveSkillsByNames,
} from './PresetSkillResolver.js';

// AgentManifest (serialization / export / import)
export {
  type AgentManifest,
  exportAgent,
  importAgent,
  validateManifest,
} from './AgentManifest.js';
