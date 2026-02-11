/**
 * @fileoverview Main entry point for Wunderland - Adaptive AI Agent Framework
 * @module wunderland
 *
 * Wunderland provides a comprehensive framework for building adaptive AI agents
 * with HEXACO personality traits, hierarchical inference routing, and multi-layered
 * security including human-in-the-loop authorization.
 *
 * @example
 * ```typescript
 * import {
 *   createWunderlandSeed,
 *   WunderlandSecurityPipeline,
 *   HierarchicalInferenceRouter,
 *   StepUpAuthorizationManager,
 *   HEXACO_PRESETS,
 * } from 'wunderland';
 *
 * // Create an agent with HEXACO personality
 * const seed = createWunderlandSeed({
 *   seedId: 'research-assistant',
 *   name: 'Research Assistant',
 *   description: 'Helps with academic research',
 *   hexacoTraits: HEXACO_PRESETS.ANALYTICAL_RESEARCHER,
 *   securityProfile: { enablePreLLMClassifier: true, enableDualLLMAuditor: true, enableOutputSigning: true },
 *   inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
 *   stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
 * });
 *
 * // Set up security pipeline
 * const security = new WunderlandSecurityPipeline({ enablePreLLM: true });
 *
 * // Set up inference routing
 * const router = new HierarchicalInferenceRouter();
 *
 * // Set up authorization
 * const auth = new StepUpAuthorizationManager({}, hitlCallback);
 * ```
 */

import { createRequire } from 'node:module';

// Core exports
export * from './core/index.js';

// Security exports
export * from './security/index.js';

// Inference exports
export * from './inference/index.js';

// Authorization exports
export * from './authorization/index.js';

// Browser automation exports (ported from OpenClaw)
export * from './browser/index.js';

// Pairing/allowlist exports (ported from OpenClaw)
export * from './pairing/index.js';

// Skills exports (ported from OpenClaw)
export * from './skills/index.js';

// RAG (Retrieval Augmented Generation) exports
export * from './rag/index.js';

// Agency (multi-agent collectives) exports
export * from './agency/index.js';

// Workflows engine exports
export * from './workflows/index.js';

// Voice calling exports
export * from './voice/call-client.js';

// Structured outputs exports
export * from './structured/index.js';

// Knowledge graph exports
export * from './knowledge/index.js';

// Planning engine exports
export * from './planning/index.js';

// Evaluation exports
export * from './evaluation/index.js';

// Provenance & audit trail exports
export * from './provenance/index.js';

// Marketplace exports
export * from './marketplace/index.js';

// Social network exports (Wonderland)
export * from './social/index.js';

// Jobs marketplace exports (agent-centric job evaluation with RAG)
export * from './jobs/index.js';

// Scheduling exports (cron scheduler, modeled after OpenClaw)
export * from './scheduling/index.js';

// Guardrails exports
export { CitizenModeGuardrail, type CitizenGuardrailResult, type CitizenGuardrailAction } from './guardrails/CitizenModeGuardrail.js';

// Tools exports — canonical names from agentos-extensions via ToolRegistry
export { SocialPostTool, type PublishResult, type PostStorageCallback } from './tools/SocialPostTool.js';
export {
  createWunderlandTools, getToolAvailability, WUNDERLAND_TOOL_IDS, type ToolRegistryConfig,
  SerperSearchTool,
  GiphySearchTool,
  ImageSearchTool,
  TextToSpeechTool,
  NewsSearchTool,
} from './tools/ToolRegistry.js';
export { createMemoryReadTool, type MemoryReadFn, type MemoryReadItem, type MemoryReadResult } from './tools/MemoryReadTool.js';
export { RAGTool, RAG_TOOL_ID, type RAGToolConfig } from './tools/RAGTool.js';
// Backward-compat aliases (deprecated — use canonical names above)
export { GiphyTool, type GiphySearchInput, type GiphySearchResult } from './tools/GiphyTool.js';
export { ElevenLabsTool, type ElevenLabsTTSInput, type ElevenLabsTTSResult } from './tools/ElevenLabsTool.js';
export { MediaSearchTool, type MediaSearchInput, type MediaSearchResult } from './tools/MediaSearchTool.js';
export { type NewsSearchInput, type NewsSearchResult } from './tools/NewsSearchTool.js';
export { type SerperSearchInput, type SerperSearchResult } from './tools/SerperSearchTool.js';

// Re-export commonly used items at top level for convenience
export {
  createWunderlandSeed,
  createDefaultWunderlandSeed,
  HEXACO_PRESETS,
  type IWunderlandSeed,
} from './core/WunderlandSeed.js';

export {
  WunderlandSecurityPipeline,
  createProductionSecurityPipeline,
  createDevelopmentSecurityPipeline,
} from './security/WunderlandSecurityPipeline.js';

export { HierarchicalInferenceRouter } from './inference/HierarchicalInferenceRouter.js';

export { StepUpAuthorizationManager } from './authorization/StepUpAuthorizationManager.js';

// Browser automation (ported from OpenClaw)
export { BrowserClient } from './browser/BrowserClient.js';
export { BrowserSession } from './browser/BrowserSession.js';
export { BrowserInteractions } from './browser/BrowserInteractions.js';

// Pairing (ported from OpenClaw)
export { PairingManager } from './pairing/PairingManager.js';

// Scheduling (modeled after OpenClaw)
export { CronScheduler } from './scheduling/CronScheduler.js';

// Version info (read from package.json at runtime)
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };
export const VERSION = pkg.version;
export const PACKAGE_NAME = pkg.name;
