// @ts-nocheck
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
} from '../agents/builder/WunderlandSeed.js';

// SeedNetworkManager (multi-agent coordination)
export {
  SeedNetworkManager,
  type SeedRegistration,
  type SeedCapability,
  type SeedNetworkConfig,
  type RoutingStrategy,
} from '../agents/lifecycle/SeedNetworkManager.js';

// StyleAdaptationEngine (communication style learning)
export {
  StyleAdaptationEngine,
  type CommunicationStyleProfile,
  type StyleAdaptationConfig,
} from '../agents/prompts/StyleAdaptation.js';

// PresetLoader (agent presets & deployment templates)
export {
  PresetLoader,
  type AgentPreset,
  type TemplateConfig,
} from '../agents/presets/PresetLoader.js';

// PresetSkillResolver (auto-resolve skills from preset/config)
export {
  resolvePresetSkills,
  resolveSkillsByNames,
} from '../agents/presets/PresetSkillResolver.js';

// AgentManifest (serialization / export / import)
export {
  type AgentManifest,
  exportAgent,
  importAgent,
  validateManifest,
} from '../agents/builder/AgentManifest.js';

// PluginHookManager (event-driven plugin hook system)
export {
  PluginHookManager,
  HOOK_NAMES,
  type HookName,
  type HookContext,
  type HookResult,
  type HookHandler,
  type HookHandlerFn,
} from '../agents/lifecycle/PluginHooks.js';

// PromptBuilder (centralized system prompt composition)
export {
  PromptBuilder,
  type PromptSection,
  type PromptBuilderInput,
  type BuiltPrompt,
} from '../agents/prompts/PromptBuilder.js';

// TokenUsageTracker (cumulative token tracking with cost estimation)
export { TokenUsageTracker } from './TokenUsageTracker.js';

// CompactionManager (conversation compaction with critical rule re-injection)
export { CompactionManager } from './CompactionManager.js';

// PresetExtensionResolver (resolve extensions from presets)
export { resolvePresetExtensions } from '../agents/presets/PresetExtensionResolver.js';

// NaturalLanguageAgentBuilder (merged from ai/)
export {
  extractAgentConfig,
  validateApiKeySetup,
  type LLMInvoker,
  type ExtractedAgentConfig,
} from '../agents/builder/NaturalLanguageAgentBuilder.js';

// Safe merge (prototype pollution prevention)
export {
  safeDeepMerge,
  safeDeepMergeSilent,
  stripDangerousKeys,
  isSafeKey,
} from './safe-merge.js';

// SSRF guard (private IP/host blocking)
export {
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateIP,
  isBlockedHost,
  validateURL,
  validateWebSocketURL,
} from './ssrf-guard.js';

// Validation utilities (agent config, presets, security tiers, etc.)
export {
  validatePreset,
  validateSecurityTier,
  validateToolAccessProfile,
  validatePermissionSet,
  validateExecutionMode,
  validateTurnApprovalMode,
  validateExtensionName,
  validateSkillName,
  validateHexacoTraits,
  validateAgentConfig,
  VALID_PRESETS,
} from '../agents/builder/validation.js';
