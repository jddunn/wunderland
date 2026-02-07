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
