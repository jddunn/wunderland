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

/**
 * Minimal shape of the `agent.config.json` schema used by Wunderland CLI/runtime.
 * This is the "control-plane" config you export from dashboards and run with
 * `wunderland start`.
 */
export type WunderlandAgentConfig = {
  seedId?: string;
  displayName?: string;
  bio?: string;
  systemPrompt?: string;
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
  securityTier?: SecurityTierName | string | null;
  permissionSet?: PermissionSetName | string | null;
  toolAccessProfile?: ToolAccessProfileName | string | null;
  executionMode?: WunderlandExecutionMode | string | null;
  lazyTools?: boolean;
  extensions?: {
    tools?: string[];
    voice?: string[];
    productivity?: string[];
  };
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

  /** Capability discovery configuration. */
  discovery?: {
    /** Enable/disable discovery. Default: auto-detect based on embedding availability. */
    enabled?: boolean;
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
    /** Embedding provider override. */
    embeddingProvider?: string;
    /** Embedding model override. */
    embeddingModel?: string;
    /** Scan ~/.wunderland/capabilities/ for manifests. Default: true. */
    scanManifests?: boolean;
  };
};

export type WunderlandProviderId = 'openai' | 'openrouter' | 'ollama' | 'anthropic';

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
