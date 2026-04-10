// @ts-nocheck
/**
 * @fileoverview Public type definitions for the Wunderland library API.
 * Extracted from public/index.ts for readability.
 */

import type { ITool, AgentMemory } from '@framers/agentos';
import type { ICognitiveMemoryManager } from '@framers/agentos/memory';
import type {
  AgentGraph as AgentGraphBuilder,
  CompiledExecutionGraph,
  GraphExpansionHandler,
  GraphEvent,
  GraphState,
  ICheckpointStore,
  MemoryConsistencyMode,
  StateReducers,
  WorkflowBuilder as AgentWorkflowBuilder,
  MissionBuilder as AgentMissionBuilder,
} from '@framers/agentos/orchestration';
import type {
  WunderlandAgentConfig,
  WunderlandProviderId,
  WunderlandToolFailureMode,
  WunderlandWorkspace,
  WunderlandTaskOutcomeTelemetryConfig,
  WunderlandAdaptiveExecutionConfig,
} from '../api/types.js';
import type { TurnToolSelectionMode } from './turn-tool-selection.js';
import type { NormalizedRuntimePolicy } from '../runtime/policy.js';
import type { WunderlandDiscoveryConfig, WunderlandDiscoveryStats } from '../discovery/index.js';
import type { ToolInstance, LLMProviderConfig } from '../runtime/tool-calling.js';
import type { ToolRegistryConfig } from '../tools/ToolRegistry.js';
import type { TokenUsageSummary } from '../core/TokenUsageTracker.js';

// =============================================================================
// Public Types
// =============================================================================

export type WunderlandMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ToolCallRecord = {
  toolName: string;
  hasSideEffects: boolean;
  args: Record<string, unknown>;
  approved: boolean;
  /** Tool output JSON/text as returned to the LLM (best-effort). */
  toolResult?: string;
  deniedReason?: string;
};

export type WunderlandTurnResult = {
  text: string;
  messages: WunderlandMessage[];
  toolCalls: ToolCallRecord[];
  meta: {
    providerId: WunderlandProviderId;
    model: string;
    sessionId: string;
    elapsedMs: number;
  };
};

export type WunderlandUsageSummary = TokenUsageSummary;

export type WunderlandDiagnostics = {
  llm: {
    providerId: WunderlandProviderId;
    model: string;
    baseUrl?: string;
    canUseLLM: boolean;
    openaiFallbackEnabled: boolean;
  };
  policy: NormalizedRuntimePolicy;
  approvals: {
    mode: WunderlandApprovalsMode;
  };
  tools: {
    count: number;
    names: string[];
    droppedByPolicy: Array<{ tool: string; reason: string }>;
    availability?: Record<string, { available: boolean; reason?: string }>;
  };
  skills: {
    count: number;
    names: string[];
  };
  workspace: {
    agentId: string;
    baseDir: string;
    workingDirectory: string;
  };
  persona?: {
    selectedId?: string;
    name?: string;
    availableCount: number;
  };
  discovery?: WunderlandDiscoveryStats;
};

export type ToolApprovalRequest = {
  sessionId: string;
  tool: Pick<ToolInstance, 'name' | 'description' | 'hasSideEffects' | 'category' | 'requiredCapabilities'>;
  args: Record<string, unknown>;
  preview: string;
};

export type WunderlandApprovalsMode = 'deny-side-effects' | 'auto-all' | 'custom';

export type WunderlandOptions = {
  /** Direct config object (control-plane). */
  agentConfig?: WunderlandAgentConfig;
  /** Optional path to `agent.config.json` (resolved relative to workingDirectory). */
  configPath?: string;
  /** Defaults to `process.cwd()` */
  workingDirectory?: string;
  /** Override the global Wunderland config directory used for env/config/usage storage. */
  configDirOverride?: string;
  /** Workspace location for tool execution state. */
  workspace?: Partial<WunderlandWorkspace>;
  /** LLM configuration (apiKey/model default from env when omitted). */
  llm?: Partial<{
    providerId: WunderlandProviderId | string;
    apiKey: string;
    model: string;
    baseUrl?: string;
    fallback?: LLMProviderConfig;
  }>;
  /**
   * Tool sources:
   * - 'none': no tools (pure chat)
   * - 'lazy': meta tools only — agent discovers & enables packs on demand (default)
   * - 'curated': curated tool packs eagerly loaded (requires optional deps)
   * - object: curated + custom tools
   */
  tools?:
    | 'none'
    | 'lazy'
    | 'curated'
    | {
        curated?: ToolRegistryConfig;
        custom?: ITool[];
      };
  /**
   * Load a preset by ID — auto-configures tools, skills, extensions, and personality.
   * Preset values are merged with explicit `tools`, `skills`, and `extensions` options
   * (explicit options take precedence).
   * @example preset: 'research-assistant'
   */
  preset?: string;
  /**
   * Skill sources (merged with preset skills if both provided):
   * - `'all'`: all curated skills for the current platform
   * - `string[]`: skill names from the curated registry
   * - object: fine-grained control over skill loading
   */
  skills?:
    | 'all'
    | string[]
    | {
        /** Curated skill names to load. */
        names?: string[];
        /** Additional skill directories to scan. */
        dirs?: string[];
        /** Scan default dirs (./skills, ~/.codex/skills) — default: true. */
        includeDefaults?: boolean;
      };
  /**
   * Extension sources (merged with preset extensions if both provided).
   * Extensions are resolved from `@framers/agentos-extensions-registry`.
   */
  extensions?: {
    /** Tool extension names (e.g. ['web-search', 'web-browser', 'giphy']). */
    tools?: string[];
    /** Voice provider extension names (e.g. ['speech-runtime', 'voice-synthesis']). */
    voice?: string[];
    /** Productivity extension names (e.g. ['calendar-google', 'email-gmail']). */
    productivity?: string[];
    /** Per-extension overrides (enabled, priority, options). */
    overrides?: Record<string, { enabled?: boolean; priority?: number; options?: unknown }>;
  };
  approvals?: {
    /** Default: 'deny-side-effects' */
    mode?: WunderlandApprovalsMode;
    /**
     * Called only for side-effect tools when mode='custom'.
     * Return true to allow execution.
     */
    onRequest?: (req: ToolApprovalRequest) => Promise<boolean>;
  };
  /** Optional default userId for guardrails/audit context. */
  userId?: string;
  /**
   * Optional cognitive memory facade or raw cognitive memory manager.
   * When provided, Wunderland exposes it on the returned app.
   */
  memory?: AgentMemory | ICognitiveMemoryManager;
  logger?: {
    debug?: (msg: string, meta?: unknown) => void;
    info?: (msg: string, meta?: unknown) => void;
    warn?: (msg: string, meta?: unknown) => void;
    error?: (msg: string, meta?: unknown) => void;
  };
  /** Capability discovery configuration. */
  discovery?: WunderlandDiscoveryConfig;
  /** Tool-calling behavior controls. */
  toolCalling?: {
    /** Enforce strict OpenAI function names and fail when rewrites/collisions are needed. */
    strictToolNames?: boolean;
  };
  /** Default tool-call failure behavior. */
  toolFailureMode?: WunderlandToolFailureMode;
  /** Runtime task-outcome telemetry controls. */
  taskOutcomeTelemetry?: WunderlandTaskOutcomeTelemetryConfig;
  /** Runtime adaptive execution controls. */
  adaptiveExecution?: WunderlandAdaptiveExecutionConfig;
};

/** Options accepted by {@link WunderlandSession.sendText} and {@link WunderlandSession.stream}. */
export type WunderlandSendTextOpts = {
  userId?: string;
  tenantId?: string;
  toolFailureMode?: WunderlandToolFailureMode;
  toolSelectionMode?: TurnToolSelectionMode;
};

export type WunderlandSession = {
  readonly id: string;
  messages: () => WunderlandMessage[];
  sendText: (text: string, opts?: WunderlandSendTextOpts) => Promise<WunderlandTurnResult>;
  /** Read durable token/cost usage aggregated for this session ID. */
  usage: () => Promise<WunderlandUsageSummary>;
  /**
   * Execute a turn and yield graph-style {@link GraphEvent} objects.
   * Useful for UI/event consumers that want the same event contract as graph runs
   * without wiring up a full AgentGraph.
   */
  stream: (text: string, opts?: WunderlandSendTextOpts) => AsyncIterable<GraphEvent>;
  /**
   * Persist the current session message history as a named checkpoint.
   * Returns an opaque checkpoint ID that can be passed to {@link WunderlandSession.resume}.
   */
  checkpoint: () => Promise<string>;
  /**
   * Restore this session's message history from a previously saved checkpoint.
   * Throws if the checkpoint ID is not found.
   */
  resume: (checkpointId: string) => Promise<void>;
};

export type WunderlandGraphLike =
  | CompiledExecutionGraph
  | {
      toIR: () => CompiledExecutionGraph;
    };

export type WunderlandGraphLlmOverride = {
  providerId?: WunderlandProviderId | string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fallback?: LLMProviderConfig;
};

export type WunderlandApp = {
  session: (sessionId?: string) => WunderlandSession;
  diagnostics: () => WunderlandDiagnostics;
  /** Read durable token/cost usage aggregated across all runs or a single session. */
  usage: (opts?: { sessionId?: string }) => Promise<WunderlandUsageSummary>;
  agentGraph: <TState extends GraphState = GraphState>(
    stateSchema: {
      input: any;
      scratch: any;
      artifacts: any;
    },
    config?: {
      reducers?: StateReducers;
      memoryConsistency?: MemoryConsistencyMode;
      checkpointPolicy?: 'every_node' | 'explicit' | 'none';
    },
  ) => AgentGraphBuilder<TState>;
  workflow: (name: string) => AgentWorkflowBuilder;
  mission: (name: string) => AgentMissionBuilder;
  runGraph: (
    graph: WunderlandGraphLike,
    input: unknown,
    opts?: {
      sessionId?: string;
      userId?: string;
      tenantId?: string;
      toolFailureMode?: WunderlandToolFailureMode;
      llmByProvider?: Record<string, WunderlandGraphLlmOverride>;
      checkpointStore?: ICheckpointStore;
      expansionHandler?: GraphExpansionHandler;
      reevalInterval?: number;
      debug?: boolean;
    },
  ) => Promise<unknown>;
  streamGraph: (
    graph: WunderlandGraphLike,
    input: unknown,
    opts?: {
      sessionId?: string;
      userId?: string;
      tenantId?: string;
      toolFailureMode?: WunderlandToolFailureMode;
      llmByProvider?: Record<string, WunderlandGraphLlmOverride>;
      checkpointStore?: ICheckpointStore;
      expansionHandler?: GraphExpansionHandler;
      reevalInterval?: number;
      debug?: boolean;
    },
  ) => AsyncIterable<GraphEvent>;
  resumeGraph: (
    graph: WunderlandGraphLike,
    checkpointId: string,
    opts?: {
      sessionId?: string;
      userId?: string;
      tenantId?: string;
      toolFailureMode?: WunderlandToolFailureMode;
      llmByProvider?: Record<string, WunderlandGraphLlmOverride>;
      checkpointStore?: ICheckpointStore;
      expansionHandler?: GraphExpansionHandler;
      reevalInterval?: number;
      debug?: boolean;
    },
  ) => Promise<unknown>;
  streamResumeGraph: (
    graph: WunderlandGraphLike,
    checkpointId: string,
    opts?: {
      sessionId?: string;
      userId?: string;
      tenantId?: string;
      toolFailureMode?: WunderlandToolFailureMode;
      llmByProvider?: Record<string, WunderlandGraphLlmOverride>;
      checkpointStore?: ICheckpointStore;
      expansionHandler?: GraphExpansionHandler;
      reevalInterval?: number;
      debug?: boolean;
    },
  ) => AsyncIterable<GraphEvent>;
  /**
   * Load and compile a workflow definition from a YAML file.
   * Returns the compiled workflow descriptor that can be passed to {@link WunderlandApp.runGraph}.
   */
  loadWorkflow: (yamlPath: string) => Promise<any>;
  /**
   * Load and compile a mission definition from a YAML file.
   * Returns the compiled mission descriptor that can be passed to {@link WunderlandApp.runGraph}.
   */
  loadMission: (yamlPath: string) => Promise<any>;
  /**
   * List all workflow and mission YAML files discovered under the working directory
   * (`./workflows/` and `./missions/` subdirectories).
   */
  listWorkflows: () => Array<{ name: string; path: string; type: 'workflow' | 'mission' }>;
  memory?: AgentMemory;
  close: () => Promise<void>;
};
