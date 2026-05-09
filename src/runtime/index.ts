// @ts-nocheck
/**
 * @fileoverview Runtime module barrel exports — tool calling, research classification,
 * system prompt building, adaptive execution, and operational utilities.
 * @module wunderland/runtime
 */

export { WunderlandAdaptiveExecutionRuntime } from '../runtime-new/execution/adaptive-execution.js';
export { resolveAgentDisplayName, firstNonEmptyString } from '../runtime-new/identity/agent-identity.js';
export { resolveApiKeyInput } from '../runtime-new/identity/api-key-resolver.js';
export { buildOllamaRuntimeOptions } from '../runtime-new/tools/ollama-options.js';
export {
  filterToolMapByPolicy,
  normalizeRuntimePolicy,
  getPermissionsForSet,
  type NormalizedRuntimePolicy,
} from '../runtime-new/tools/policy.js';
export {
  classifyResearchDepth,
  buildResearchPrefix,
  shouldInjectResearch,
  createResearchClassifierLlmCall,
  resolveResearchClassifierModel,
  type ResearchDepth,
  type ResearchClassification,
  type ResearchClassifierConfig,
} from '../runtime-new/agentos-bridge/research-classifier.js';
export {
  buildAgenticSystemPrompt,
  buildAgenticSystemPrompt as buildSystemPrompt,
} from '../runtime-new/execution/system-prompt-builder.js';
export { runToolCallingTurn, safeJsonStringify, type ToolInstance } from '../runtime-new/tools/tool-calling.js';
export {
  createWunderlandGraphRuntime,
  invokeWunderlandGraph,
  streamWunderlandGraph,
  resolveCompiledGraph,
  type WunderlandGraphLike,
  type WunderlandGraphRunConfig,
} from '../runtime-new/execution/graph-runner.js';
export { ToolFailureLearner } from '../runtime-new/tools/tool-failure-learner.js';
export { TOOL_FALLBACK_MAP } from '../runtime-new/tools/tool-helpers.js';
export {
  buildToolFunctionNameMapping,
  buildToolDefsFromMapping,
  resolveStrictToolNames,
} from '../runtime-new/tools/tool-function-names.js';
export {
  resolveAgentWorkspaceBaseDir,
  sanitizeAgentWorkspaceId,
} from '../runtime-new/tools/workspace.js';
export {
  initCliQueryRouter,
  getCliQueryRouter,
  getUnifiedRetrieverBuildResult,
  resetCliQueryRouterForTests,
  formatCliQueryRouterReadyLog,
  type CliQueryRouterOptions,
  type UnifiedRetrieverBuildResult,
} from '../runtime-new/agentos-bridge/query-router-init.js';
export {
  buildUnifiedRetrieverFromConfig,
  formatUnifiedRetrievalLog,
  persistBM25Index,
  type UnifiedRetrieverBuildContext,
} from '../runtime-new/agentos-bridge/unified-retriever-builder.js';
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
} from '../runtime-new/agentos-bridge/rag-state-persistence.js';
