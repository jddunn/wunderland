// @ts-nocheck
/**
 * @fileoverview Barrel export and route dispatch helper for the CLI HTTP server.
 * @module wunderland/cli/commands/start/routes
 *
 * Re-exports all individual route handlers and provides a single `dispatchRoute()`
 * function that tries each handler group in priority order, returning `true` when
 * a handler claims the request.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CliServerDeps } from './types.js';

export type { CliServerDeps, RouteHandlerResult } from './types.js';
export { handleDashboardRoutes } from './dashboard.js';
export { handleConfigRoutes } from './config.js';
export { handleSocialRoutes, handleFeedRoutes } from './social.js';
export { handleHealthRoutes, handleHitlRoutes } from './health.js';
export { handleChatRoutes } from './chat.js';
export { handleWebhookRequest, resetWebhookRateLimiter } from './webhooks.js';
export type { WebhookHookConfig, WebhookDeps } from './webhooks.js';

/* ── re-import for the dispatch helper ─────────────────────────────────────── */
import { handleDashboardRoutes } from './dashboard.js';
import { handleConfigRoutes } from './config.js';
import { handleSocialRoutes, handleFeedRoutes } from './social.js';
import { handleHealthRoutes, handleHitlRoutes } from './health.js';
import { handleChatRoutes } from './chat.js';
import { handleWebhookRequest, type WebhookHookConfig } from './webhooks.js';
import { readBody } from './helpers.js';

/**
 * Try all route handler groups in order. The first handler that returns `true`
 * wins and no further groups are attempted.
 *
 * Order:
 *  0. Dashboard           (GET /, /api/extensions, /api/events/stream, /api/graph)
 *  1. Config / personas   (sync, fast path)
 *  2. Pairing / social    (async)
 *  3. HITL                (async)
 *  4. Health / info        (sync, fast path)
 *  5. Chat                 (async, heavy)
 *  6. Feed ingestion       (async)
 *
 * @returns `true` if any handler claimed the request, `false` otherwise.
 */
export async function dispatchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CliServerDeps,
): Promise<boolean> {
  /* 0. Dashboard */
  if (await handleDashboardRoutes(req, res, url, deps)) return true;

  /* 1. Config / personas */
  if (handleConfigRoutes(req, res, url, deps)) return true;

  /* 2. Pairing */
  if (await handleSocialRoutes(req, res, url, deps)) return true;

  /* 3. HITL */
  if (await handleHitlRoutes(req, res, url, deps)) return true;

  /* 4. Health / GET /chat info */
  if (handleHealthRoutes(req, res, url, deps)) return true;

  /* 5. Chat */
  if (await handleChatRoutes(req, res, url, deps)) return true;

  /* 6. Feed ingestion */
  if (await handleFeedRoutes(req, res, url, deps)) return true;

  /* 7. Webhook wake endpoints (POST /webhooks/:hookId) */
  if (url.pathname.startsWith('/webhooks/')) {
    const hooks: WebhookHookConfig[] = Array.isArray(deps.cfg?.webhooks) ? deps.cfg.webhooks : [];
    const rawBody = req.method === 'POST' ? await readBody(req) : '';
    return handleWebhookRequest(req, res, rawBody, {
      hooks,
      enqueueTurn: async (hookId, payload) => {
        // Wake the agent: append the payload as a user turn on a hook-scoped
        // session, which the chat runtime drains on its next pass.
        const sessionKey = `webhook:${hookId}`;
        const history = deps.sessions.get(sessionKey) ?? [];
        history.push({ role: 'user', content: payload, source: `webhook:${hookId}` });
        deps.sessions.set(sessionKey, history);
        deps.broadcastAgentEvent?.({ type: 'webhook_turn', hookId, payload });
      },
      appendFeed: async (hookId, payload) => {
        deps.broadcastAgentEvent?.({ type: 'webhook_notify', hookId, payload });
      },
    });
  }

  return false;
}
