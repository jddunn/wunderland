// @ts-nocheck
/**
 * @fileoverview Runtime module barrel exports — tool calling, research classification,
 * system prompt building, adaptive execution, and operational utilities.
 * @module wunderland/runtime
 */

export { WunderlandAdaptiveExecutionRuntime } from './adaptive-execution.js';
export { resolveAgentDisplayName, firstNonEmptyString } from './agent-identity.js';
export { resolveApiKeyInput } from './api-key-resolver.js';
export { buildOllamaRuntimeOptions } from './ollama-options.js';
export {
  filterToolMapByPolicy,
  normalizeRuntimePolicy,
  getPermissionsForSet,
  type NormalizedRuntimePolicy,
} from './policy.js';
export {
  classifyResearchDepth,
  buildResearchPrefix,
  shouldInjectResearch,
  createResearchClassifierLlmCall,
  resolveResearchClassifierModel,
  type ResearchDepth,
  type ResearchClassification,
  type ResearchClassifierConfig,
} from './research-classifier.js';
export {
  buildAgenticSystemPrompt,
  buildAgenticSystemPrompt as buildSystemPrompt,
} from './system-prompt-builder.js';
export { runToolCallingTurn, safeJsonStringify, type ToolInstance } from './tool-calling.js';
export {
  createWunderlandGraphRuntime,
  invokeWunderlandGraph,
  streamWunderlandGraph,
  resolveCompiledGraph,
  type WunderlandGraphLike,
  type WunderlandGraphRunConfig,
} from './graph-runner.js';
export { ToolFailureLearner } from './tool-failure-learner.js';
export { TOOL_FALLBACK_MAP } from './tool-helpers.js';
export {
  buildToolFunctionNameMapping,
  buildToolDefsFromMapping,
  resolveStrictToolNames,
} from './tool-function-names.js';
export {
  resolveAgentWorkspaceBaseDir,
  sanitizeAgentWorkspaceId,
} from './workspace.js';
export {
  initCliQueryRouter,
  getCliQueryRouter,
  getUnifiedRetrieverBuildResult,
  resetCliQueryRouterForTests,
  formatCliQueryRouterReadyLog,
  type CliQueryRouterOptions,
  type UnifiedRetrieverBuildResult,
} from './query-router-init.js';
export {
  buildUnifiedRetrieverFromConfig,
  formatUnifiedRetrievalLog,
  persistBM25Index,
  type UnifiedRetrieverBuildContext,
} from './unified-retriever-builder.js';
export {
  saveBM25State,
  loadBM25State,
  saveRaptorState,
  loadRaptorState,
  computeCorpusHash,
  getBM25StateAge,
  getRaptorStateAge,
  type SerializedBM25State,
  type SerializedRaptorState,
  type RagStatePersistenceOptions,
} from './rag-state-persistence.js';
