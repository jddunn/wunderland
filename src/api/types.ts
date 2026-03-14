/**
 * @fileoverview High-level API types for Wunderland.
 * @module wunderland/api/types
 */

import type { SecurityTierName, PermissionSetName } from '../security/SecurityTiers.js';
import type { ToolAccessProfileName } from '../social/ToolAccessProfiles.js';
import type { FolderPermissionConfig } from '../security/FolderPermissions.js';
import type { StorageResolutionOptions } from '@framers/sql-storage-adapter';

export type WunderlandExecutionMode = 'autonomous' | 'human-all' | 'human-dangerous';
export type WunderlandToolFailureMode = 'fail_open' | 'fail_closed';
export type WunderlandTaskOutcomeTelemetryScope =
  | 'global'
  | 'session'
  | 'persona'
  | 'tenant'
  | 'tenant_persona';

export interface WunderlandTaskOutcomeTelemetryConfig {
  /**
   * Enables rolling task-outcome KPI tracking.
   * Default: true
   */
  enabled?: boolean;
  /**
   * Number of recent outcomes retained per scope.
   * Default: 100
   */
  rollingWindowSize?: number;
  /**
   * KPI aggregation scope.
   * Default: tenant_persona
   */
  scope?: WunderlandTaskOutcomeTelemetryScope;
  /**
   * Persist KPI windows to SQL storage.
   * Default: true
   */
  persist?: boolean;
  /**
   * SQL table used for KPI window storage.
   * Default: wunderland_task_outcome_kpi_windows
   */
  tableName?: string;
  /**
   * SQL adapter resolution config passed to @framers/sql-storage-adapter.
   */
  storage?: StorageResolutionOptions;
  /**
   * Emit low-success alerts in runtime logs.
   * Default: true
   */
  emitAlerts?: boolean;
  /**
   * Alert threshold for weighted success rate.
   * Default: 0.55
   */
  alertBelowWeightedSuccessRate?: number;
  /**
   * Minimum samples required before alert evaluation.
   * Default: 8
   */
  alertMinSamples?: number;
  /**
   * Minimum milliseconds between repeated alerts per scope.
   * Default: 60000
   */
  alertCooldownMs?: number;
}

export interface WunderlandAdaptiveExecutionConfig {
  /**
   * Enables adaptive execution changes driven by rolling KPI.
   * Default: true
   */
  enabled?: boolean;
  /**
   * Minimum samples before adaptive rules can apply.
   * Default: 5
   */
  minSamples?: number;
  /**
   * Minimum weighted success rate required to avoid degraded mode.
   * Default: 0.7
   */
  minWeightedSuccessRate?: number;
  /**
   * Force full tool schema exposure when degraded.
   * Default: true
   */
  forceAllToolsWhenDegraded?: boolean;
  /**
   * Force fail-open mode when degraded (unless explicitly requested fail-closed).
   * Default: true
   */
  forceFailOpenWhenDegraded?: boolean;
}

export type WunderlandExtensionConfig = {
  tools?: string[];
  voice?: string[];
  productivity?: string[];
  channels?: string[];
  [category: string]: string[] | undefined;
};

export interface WunderlandAgentDiscoveryConfig {
  /** Enable/disable discovery. Default: auto-detect based on embedding availability. */
  enabled?: boolean;
  /**
   * Recall profile for discovery context.
   * - aggressive: higher recall (default)
   * - balanced: AgentOS default budgets/topK
   * - precision: lower token footprint, tighter TopK
   */
  recallProfile?: 'aggressive' | 'balanced' | 'precision';
  /** Tier 0 token budget. Default: 200. */
  tier0Budget?: number;
  /** Tier 1 token budget. Default: 800. */
  tier1Budget?: number;
  /** Tier 2 token budget. Default: 2000. */
  tier2Budget?: number;
  /** Number of Tier 1 candidates. Default: 5. */
  tier1TopK?: number;
  /** Number of Tier 2 candidates. Default: 2. */
  tier2TopK?: number;
  /** Minimum relevance threshold for Tier 1 retrieval. */
  tier1MinRelevance?: number;
  /** Graph re-ranking multiplier when graph edges support a match. */
  graphBoostFactor?: number;
  /** Embedding provider override. */
  embeddingProvider?: string;
  /** Embedding model override. */
  embeddingModel?: string;
  /** Scan ~/.wunderland/capabilities/ for manifests. Default: true. */
  scanManifests?: boolean;
  /** Advanced passthrough overrides for AgentOS discovery config. */
  config?: Record<string, unknown>;
}

export interface WunderlandAgentRagConfig {
  /** Enable RAG-backed memory/query tools for this agent. */
  enabled?: boolean;
  /**
   * Backend base URL.
   * Accepts forms like:
   * - http://localhost:3001
   * - http://localhost:3001/api
   * - http://localhost:3001/api/agentos/rag
   */
  backendUrl?: string;
  /** Static bearer token for hosted backends. */
  authToken?: string;
  /** Environment variable containing the bearer token. */
  authTokenEnvVar?: string;
  /** Default collections to search across. */
  collectionIds?: string[];
  /** Convenience alias when targeting one primary collection. */
  defaultCollectionId?: string;
  /** Default Top-K for memory retrieval. */
  defaultTopK?: number;
  /** Retrieval preset. */
  preset?: 'fast' | 'balanced' | 'accurate';
  /** Include GraphRAG context in default queries. */
  includeGraphRag?: boolean;
  /** Include audit trail in default queries. */
  includeAudit?: boolean;
  /** Include pipeline debug trace in default queries. */
  includeDebug?: boolean;
  /** Minimum similarity threshold. */
  similarityThreshold?: number;
  /** Include metadata in returned chunks. */
  includeMetadata?: boolean;
  /** Optional metadata filters. */
  filters?: Record<string, unknown>;
  /** Optional post-retrieval strategy. */
  strategy?: 'similarity' | 'mmr' | 'hybrid_search';
  /** Strategy-specific parameters. */
  strategyParams?: {
    mmrLambda?: number;
    mmrCandidateMultiplier?: number;
  };
  /** Extra query variants to merge with the primary query. */
  queryVariants?: string[];
  /** Optional query rewrite controls. */
  rewrite?: {
    enabled?: boolean;
    maxVariants?: number;
  };
  /** Expose the read-oriented memory tool. Default: true when rag.enabled=true. */
  exposeMemoryRead?: boolean;
  /** Expose the explicit rag_query tool. Default: true when rag.enabled=true. */
  exposeRagQuery?: boolean;
}

export interface WunderlandAgentPersonaRegistryConfig {
  /** Enable AgentOS persona registry loading. */
  enabled?: boolean;
  /** Include AgentOS built-in personas. Default: true. */
  includeBuiltIns?: boolean;
  /** Additional local directories containing persona JSON files. */
  paths?: string[];
  /** Recursively scan persona directories. Default: true. */
  recursive?: boolean;
  /** File extension to load (for example `.json` or `.persona.json`). */
  fileExtension?: string;
  /** Default selected AgentOS persona ID. */
  selectedPersonaId?: string;
}

/**
 * Minimal shape of the `agent.config.json` schema used by Wunderland CLI/runtime.
 * This is the "control-plane" config you export from dashboards and run with
 * `wunderland start`.
 */
export type WunderlandAgentConfig = {
  seedId?: string;
  presetId?: string;
  displayName?: string;
  /** Alias for displayName — used by global CLI config (`~/.wunderland/config.json`). */
  agentName?: string;
  bio?: string;
  systemPrompt?: string;
  /** Default selected AgentOS persona ID applied at runtime/tool context scope. */
  selectedPersonaId?: string;
  personality?: Partial<{
    honesty: number;
    emotionality: number;
    extraversion: number;
    agreeableness: number;
    conscientiousness: number;
    openness: number;
  }>;
  llmProvider?: string;
  llmModel?: string;
  /** Auth method for the LLM provider. 'api-key' (default) or 'oauth' for subscription-based tokens. */
  llmAuthMethod?: 'api-key' | 'oauth';
  /**
   * Tool-call failure behavior:
   * - fail_open: continue after tool failures (default)
   * - fail_closed: stop turn on first tool failure
   */
  toolFailureMode?: WunderlandToolFailureMode | string | null;
  toolCalling?: Partial<{
    /**
     * Enforce strict OpenAI function-name compatibility and fail fast when
     * rewrites/collision handling would otherwise be required.
     */
    strictToolNames: boolean;
  }>;
  securityTier?: SecurityTierName | string | null;
  permissionSet?: PermissionSetName | string | null;
  toolAccessProfile?: ToolAccessProfileName | string | null;
  executionMode?: WunderlandExecutionMode | string | null;
  lazyTools?: boolean;
  skills?: string[];
  extensions?: WunderlandExtensionConfig;
  extensionOverrides?: Record<
    string,
    {
      enabled?: boolean;
      priority?: number;
      options?: unknown;
    }
  >;
  /** Channel platform IDs (e.g., "telegram"). */
  channels?: string[];
  suggestedChannels?: string[];
  /** Optional secret overrides (in addition to env vars). */
  secrets?: Record<string, string>;
  /** Optional security overrides that the runtime reads. */
  security?: Partial<{
    tier: SecurityTierName | string;
    permissionSet: PermissionSetName | string;
    preLLMClassifier: boolean;
    preLlmClassifier: boolean;
    dualLLMAudit: boolean;
    dualLlmAuditor: boolean;
    outputSigning: boolean;
    storagePolicy: string;
    wrapToolOutputs: boolean;
    folderPermissions: FolderPermissionConfig;
  }>;
  hitl?: Partial<{
    secret: string;
    turnApprovalMode: 'off' | 'after-each-turn' | 'after-each-round' | string;
    turnApproval: 'off' | 'after-each-turn' | 'after-each-round' | string;
  }>;
  pairing?: Partial<{
    enabled: boolean;
    groupTrigger: string;
    pendingTtlMs: number;
    maxPending: number;
    codeLength: number;
  }>;
  observability?: Partial<{
    otel?: Partial<{
      enabled: boolean;
      exportLogs: boolean;
    }>;
  }>;
  /**
   * Rolling task-outcome KPI telemetry.
   */
  taskOutcomeTelemetry?: WunderlandTaskOutcomeTelemetryConfig;
  /**
   * Adaptive execution controls based on rolling KPI.
   */
  adaptiveExecution?: WunderlandAdaptiveExecutionConfig;

  /** Agent personal wallet configuration (crypto + virtual cards). */
  wallet?: import('../wallet/types.js').WalletConfig;

  /** Capability discovery configuration. */
  discovery?: WunderlandAgentDiscoveryConfig;
  /** Per-agent storage configuration (SQLite or cloud). */
  storage?: {
    /** Storage backend: 'local' (SQLite per agent, default) or 'cloud' (Postgres/Supabase). */
    backend?: 'local' | 'cloud';
    /** Override default DB path (~/.wunderland/agents/{seedId}/agent.db). */
    dbPath?: string;
    /** Connection string for cloud backend (reads DATABASE_URL env if not set). */
    connectionString?: string;
    /** Auto-ingest pipeline configuration. */
    autoIngest?: {
      /** Enable automatic memory extraction from conversations (default: true). */
      enabled?: boolean;
      /** Override personality-derived importance threshold (0.0-1.0). */
      importanceThreshold?: number;
      /** Max memories to extract per conversation turn (default: 3). */
      maxPerTurn?: number;
    };
  };
  /** RAG / long-term memory configuration. */
  rag?: WunderlandAgentRagConfig;
  /** AgentOS persona registry configuration. */
  personaRegistry?: WunderlandAgentPersonaRegistryConfig;
};

export type WunderlandProviderId = 'openai' | 'openrouter' | 'ollama' | 'anthropic' | 'gemini';

export type WunderlandLLMConfig = {
  providerId: WunderlandProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  /**
   * Optional OpenAI-compatible fallback provider (e.g., OpenRouter).
   * Only used if the primary provider supports it.
   */
  fallback?: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    extraHeaders?: Record<string, string>;
  };
};

export type WunderlandWorkspace = {
  agentId: string;
  baseDir: string;
};
