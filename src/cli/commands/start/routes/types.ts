// @ts-nocheck
/**
 * @fileoverview Shared dependency type for CLI HTTP server route handlers.
 * @module wunderland/cli/commands/start/routes/types
 *
 * Every route file receives a `CliServerDeps` object — the runtime context
 * created during `createAgentHttpServer()` — so route handlers stay focused
 * on request/response logic without owning lifecycle state.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HumanInteractionManager } from '@framers/agentos';

import type { ToolInstance } from '../../../../runtime/tools/tool-calling.js';
import type { WunderlandSessionTextLogger } from '../../../../platform/observability/session-text-log.js';

/**
 * Shared dependencies injected into CLI HTTP server route handler functions.
 *
 * Assembled once in `createAgentHttpServer()` and passed to each
 * `handleXxxRoutes(req, res, url, deps)` call.
 */
export interface CliServerDeps {
  /* ── identity ─────────────────────────────────────────────────────────── */
  seedId: string;
  displayName: string;
  activePersonaId: string;
  selectedPersona: unknown;
  availablePersonas: any[];
  seed: any;

  /* ── LLM ──────────────────────────────────────────────────────────────── */
  providerId: string;
  model: string;
  llmApiKey: string;
  llmBaseUrl: string | undefined;
  canUseLLM: boolean;
  openrouterFallback: any;
  oauthGetApiKey?: (provider: string) => string | undefined;

  /* ── runtime ──────────────────────────────────────────────────────────── */
  cfg: any;
  rawAgentConfig: any;
  globalConfig: any;
  configDir: string | undefined;
  policy: any;
  toolMap: Map<string, ToolInstance>;
  sessions: Map<string, Array<Record<string, unknown>>>;
  systemPrompt: string;
  adaptiveRuntime: any;
  discoveryManager: any;
  strictToolNames: boolean;
  autoApproveToolCalls: boolean;
  /** Pre-built LLM judge handler for tool approval decisions (--llm-judge). */
  llmJudgeHandler?: (tool: { name: string; hasSideEffects?: boolean }, args: Record<string, unknown>) => Promise<boolean>;
  dangerouslySkipPermissions: boolean;
  turnApprovalMode: 'off' | 'after-each-turn' | 'after-each-round';
  defaultTenantId: string | undefined;
  workspaceAgentId: string;
  workspaceBaseDir: string;
  lazyTools: boolean;
  skillsPrompt: string;
  port: number;
  startTime: number;

  /* ── HITL / pairing ──────────────────────────────────────────────────── */
  hitlSecret: string;
  chatSecret: string;
  feedSecret: string;
  hitlManager: HumanInteractionManager;
  sseClients: Set<ServerResponse>;
  broadcastHitlUpdate: (payload: Record<string, unknown>) => Promise<void>;
  pairingEnabled: boolean;
  pairing: any;

  /* ── channels ─────────────────────────────────────────────────────────── */
  adapterByPlatform: Map<string, any>;
  loadedHttpHandlers: Array<
    (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean
  >;

  /* ── observability ────────────────────────────────────────────────────── */
  sessionTextLogger: WunderlandSessionTextLogger;

  /* ── dashboard ──────────────────────────────────────────────────────── */
  /** Extension packs loaded at startup (used by dashboard extensions tab). */
  activePacks?: any[];
  /** Connected SSE clients for the agent event stream. */
  eventSseClients?: Set<import('node:http').ServerResponse>;
  /** Push an agent event to all connected dashboard SSE clients. */
  broadcastAgentEvent?: (payload: Record<string, unknown>) => void;
}

/**
 * Result of attempting to handle a request in a route group.
 * `true` means the request was handled; `false` means fall through.
 */
export type RouteHandlerResult = boolean;
