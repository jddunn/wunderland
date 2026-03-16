/**
 * @fileoverview Public type definitions for the Wunderland library API.
 * Extracted from public/index.ts for readability.
 */

import type { ITool } from '@framers/agentos';
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
import type { WunderlandDiscoveryConfig, WunderlandDiscoveryStats, DiscoverySkillEntry } from '../discovery/index.js';
import type { ToolInstance, LLMProviderConfig } from '../runtime/tool-calling.js';
import type { ToolRegistryConfig } from '../tools/ToolRegistry.js';

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

export type WunderlandSession = {
  readonly id: string;
  messages: () => WunderlandMessage[];
  sendText: (
    text: string,
    opts?: {
      userId?: string;
      tenantId?: string;
      toolFailureMode?: WunderlandToolFailureMode;
      toolSelectionMode?: TurnToolSelectionMode;
    },
  ) => Promise<WunderlandTurnResult>;
};

export type WunderlandApp = {
  session: (sessionId?: string) => WunderlandSession;
  diagnostics: () => WunderlandDiagnostics;
  close: () => Promise<void>;
};
