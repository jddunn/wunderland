/**
 * @fileoverview Shared dependency type for route handler registration functions.
 * @module wunderland/api/routes/types
 *
 * Every route file receives a `ServerDeps` object that carries the runtime
 * context created during server bootstrap (sessions, tool map, HITL manager,
 * pairing, adapters, etc.). This avoids passing dozens of individual parameters
 * and keeps the registration signatures uniform.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HumanInteractionManager } from '@framers/agentos';

import type { ToolInstance } from '../../runtime/tool-calling.js';
import type { NormalizedRuntimePolicy } from '../../runtime/policy.js';
import type { WunderlandAdaptiveExecutionRuntime } from '../../runtime/adaptive-execution.js';
import type { WunderlandDiscoveryManager } from '../../discovery/index.js';
import type { PairingManager } from '../../pairing/PairingManager.js';
import type { WunderlandSessionTextLogger } from '../../observability/session-text-log.js';
import type { WunderlandAgentConfig, WunderlandProviderId } from '../types.js';

/** Minimal logger contract accepted by route handlers. */
export type LoggerLike = {
  debug?: (msg: string, meta?: unknown) => void;
  info?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
  error?: (msg: string, meta?: unknown) => void;
};

/**
 * Shared dependencies injected into every route registration function.
 *
 * Created once during `createWunderlandServer()` and threaded through
 * `registerXxxRoutes(deps)` calls so route files stay focused on
 * request/response logic without owning any lifecycle state.
 */
export interface ServerDeps {
  /* ── identity ─────────────────────────────────────────────────────────── */
  seedId: string;
  displayName: string;
  activePersonaId: string;
  selectedPersona: unknown;
  availablePersonas: any[];

  /* ── LLM ──────────────────────────────────────────────────────────────── */
  providerId: WunderlandProviderId;
  model: string;
  llmApiKey: string;
  llmBaseUrl: string | undefined;
  canUseLLM: boolean;
  openrouterFallback: any;

  /* ── runtime ──────────────────────────────────────────────────────────── */
  seed: any;
  cfg: WunderlandAgentConfig;
  rawAgentConfig: WunderlandAgentConfig;
  policy: NormalizedRuntimePolicy;
  toolMap: Map<string, ToolInstance>;
  sessions: Map<string, Array<Record<string, unknown>>>;
  systemPrompt: string;
  adaptiveRuntime: WunderlandAdaptiveExecutionRuntime;
  discoveryManager: WunderlandDiscoveryManager;
  strictToolNames: boolean;
  autoApproveToolCalls: boolean;
  turnApprovalMode: 'off' | 'after-each-turn' | 'after-each-round';
  defaultTenantId: string | undefined;
  workspaceAgentId: string;
  workspaceBaseDir: string;
  lazyTools: boolean;
  skillsPrompt: string;
  workingDirectory: string;

  /* ── HITL / pairing ──────────────────────────────────────────────────── */
  hitlSecret: string;
  hitlManager: HumanInteractionManager;
  sseClients: Set<ServerResponse>;
  broadcastHitlUpdate: (payload: Record<string, unknown>) => Promise<void>;
  pairingEnabled: boolean;
  pairing: PairingManager;

  /* ── channels ─────────────────────────────────────────────────────────── */
  adapterByPlatform: Map<string, any>;
  loadedChannelAdapters: any[];
  loadedHttpHandlers: Array<
    (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean
  >;

  /* ── observability ────────────────────────────────────────────────────── */
  sessionTextLogger: WunderlandSessionTextLogger;
  logger: LoggerLike;

  /* ── config / misc ────────────────────────────────────────────────────── */
  configDirOverride?: string;
  toolApiSecret: string;
  dangerouslySkipPermissions: boolean;
  oauthGetApiKey?: (provider: string) => string | undefined;
}

/**
 * Result of attempting to handle a request in a route group.
 * When `true`, the request was handled and the caller should stop
 * dispatching. When `false`, fall through to the next group.
 */
export type RouteHandlerResult = boolean;
