// @ts-nocheck
/**
 * @fileoverview Extracted HTTP server from `wunderland start`.
 * @module wunderland/cli/commands/start/http-server
 *
 * Creates the HTTP server with CORS middleware, RAG proxy pass-through,
 * and delegates all route handling to extracted modules under `./routes/`.
 * Keeps only lifecycle concerns (server creation, middleware wiring).
 */

import { createServer, type ServerResponse } from 'node:http';
import { maybeProxyAgentosRagRequest } from '../../../memory-new/rag/http-proxy.js';
import { resolveWunderlandTextLogConfig, WunderlandSessionTextLogger } from '../../../platform/observability/session-text-log.js';
import { dispatchRoute } from './routes/index.js';
import type { CliServerDeps } from './routes/types.js';
import { sendJson } from './routes/helpers.js';

// ── Server factory ──────────────────────────────────────────────────────────

export function createAgentHttpServer(ctx: any): import('node:http').Server {
  const {
    hitlSecret,
    chatSecret,
    feedSecret,
    hitlManager,
    pairing,
    pairingEnabled,
    sessions,
    systemPrompt,
    toolMap,
    canUseLLM,
    seed,
    seedId,
    displayName,
    providerId,
    model,
    llmApiKey,
    llmBaseUrl,
    policy,
    adaptiveRuntime,
    discoveryManager,
    autoApproveToolCalls,
    dangerouslySkipPermissions,
    strictToolNames,
    openrouterFallback,
    oauthGetApiKey,
    workspaceAgentId,
    workspaceBaseDir,
    sseClients,
    broadcastHitlUpdate,
    adapterByPlatform,
    loadedHttpHandlers,
    turnApprovalMode,
    defaultTenantId,
    port,
    startTime,
    cfg,
    rawAgentConfig,
    globalConfig,
    configDir,
    lazyTools,
    skillsPrompt,
    selectedPersona,
    availablePersonas,
  } = ctx;
  const activePersonaId =
    typeof cfg?.selectedPersonaId === 'string' && cfg.selectedPersonaId.trim()
      ? cfg.selectedPersonaId.trim()
      : seed.seedId;
  const sessionTextLogger = new WunderlandSessionTextLogger(
    resolveWunderlandTextLogConfig({
      agentConfig: cfg,
      workingDirectory: process.cwd(),
      workspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
      defaultAgentId: workspaceAgentId,
      configBacked: true,
    }),
  );

  /* ── Dashboard event SSE infrastructure ───────────────────────────────── */
  const eventSseClients = new Set<ServerResponse>();
  const broadcastAgentEvent = (payload: Record<string, unknown>) => {
    const data = JSON.stringify(payload);
    for (const client of Array.from(eventSseClients)) {
      try {
        client.write(`event: agent_event\ndata: ${data}\n\n`);
      } catch {
        eventSseClients.delete(client);
      }
    }
  };

  /* ── Assemble shared deps for extracted route handlers ─────────────────── */
  const routeDeps: CliServerDeps = {
    seedId,
    displayName,
    activePersonaId,
    selectedPersona,
    availablePersonas: availablePersonas ?? [],
    seed,
    providerId,
    model,
    llmApiKey,
    llmBaseUrl,
    canUseLLM,
    openrouterFallback,
    oauthGetApiKey,
    cfg,
    rawAgentConfig,
    globalConfig,
    configDir,
    policy,
    toolMap,
    sessions,
    systemPrompt,
    adaptiveRuntime,
    discoveryManager,
    strictToolNames,
    autoApproveToolCalls,
    llmJudgeHandler: ctx.llmJudgeHandler,
    dangerouslySkipPermissions,
    turnApprovalMode,
    defaultTenantId,
    workspaceAgentId,
    workspaceBaseDir,
    lazyTools,
    skillsPrompt,
    port,
    startTime,
    hitlSecret,
    chatSecret,
    feedSecret,
    hitlManager,
    sseClients,
    broadcastHitlUpdate,
    pairingEnabled,
    pairing,
    adapterByPlatform,
    loadedHttpHandlers,
    sessionTextLogger,
    activePacks: ctx.activePacks ?? [],
    eventSseClients,
    broadcastAgentEvent,
  };

  const server = createServer(async (req, res) => {
    try {
      /* ── CORS ───────────────────────────────────────────────────────────── */
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-API-Key, X-Auto-Approve, X-Wunderland-HITL-Secret, X-Wunderland-Chat-Secret, X-Wunderland-Feed-Secret',
      );

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      /* ── RAG proxy pass-through ─────────────────────────────────────────── */
      if (await maybeProxyAgentosRagRequest({ req, res, url, agentConfig: cfg })) {
        return;
      }

      /* ── Dispatch to extracted route handlers ───────────────────────────── */
      if (await dispatchRoute(req, res, url, routeDeps)) {
        return;
      }

      /* ── Extension HTTP handlers (webhooks, etc.) ───────────────────────── */
      for (const handler of loadedHttpHandlers) {
        try {
          const handled = await handler(req, res);
          if (handled) return;
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : 'HTTP handler error' });
          return;
        }
      }

      sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Server error' });
    }
  });

  return server;
}
