/**
 * @fileoverview High-level API types for Wunderland.
 * @module wunderland/api/types
 */

import type { SecurityTierName, PermissionSetName } from '../security/SecurityTiers.js';
import type { ToolAccessProfileName } from '../social/ToolAccessProfiles.js';
import type { FolderPermissionConfig } from '../security/FolderPermissions.js';

export type WunderlandExecutionMode = 'autonomous' | 'human-all' | 'human-dangerous';

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

