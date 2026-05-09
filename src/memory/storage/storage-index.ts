// @ts-nocheck
/**
 * @fileoverview Per-agent storage subsystem barrel exports.
 * @module wunderland/storage
 */

export { AgentStorageManager, resolveAgentStorageConfig } from './AgentStorageManager.js';
export { AgentMemoryAdapter } from './AgentMemoryAdapter.js';
export { AgentStateStore } from './AgentStateStore.js';
export { MemoryAutoIngestPipeline } from './MemoryAutoIngestPipeline.js';
export { derivePersonalityMemoryConfig } from './PersonalityMemoryConfig.js';
export type { PersonalityMemoryConfig, FactCategory, HexacoTraits } from './PersonalityMemoryConfig.js';
export type { LlmCaller, MemoryAutoIngestPipelineConfig } from './MemoryAutoIngestPipeline.js';
export type {
  IAgentStorageManager,
  IAgentMemoryAdapter,
  IAgentStateStore,
  IMemoryAutoIngestPipeline,
  AutoIngestResult,
  ExtractedFact,
  ResolvedAgentStorageConfig,
  AgentConversationTurn,
  AgentConversationSummary,
} from './types.js';
