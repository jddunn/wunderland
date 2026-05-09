// @ts-nocheck
/**
 * @fileoverview Barrel export and route dispatch helper for the Wunderland API server.
 * @module wunderland/api/routes
 *
 * Re-exports all individual route handlers and provides a single `dispatchRoute()`
 * function that tries each handler group in priority order, returning `true` when
 * a handler claims the request.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerDeps } from './types.js';

export type { ServerDeps, RouteHandlerResult, LoggerLike } from './types.js';
export { handleConfigRoutes } from './config.js';
export { handleSocialRoutes } from './social.js';
export { handleHealthRoutes, handleHitlRoutes } from './health.js';
export { handleChatRoutes } from './chat.js';
export { handleAgentRoutes } from './agents.js';

/* ── re-import for the dispatch helper ─────────────────────────────────────── */
import { handleConfigRoutes } from './config.js';
import { handleSocialRoutes } from './social.js';
import { handleHealthRoutes, handleHitlRoutes } from './health.js';
import { handleChatRoutes } from './chat.js';
import { handleAgentRoutes } from './agents.js';

/**
 * Try all route handler groups in order. The first handler that returns `true`
 * wins and no further groups are attempted.
 *
 * Order:
 *  1. Config / personas  (sync, fast path)
 *  2. Pairing / social   (async)
 *  3. HITL               (async)
 *  4. Health              (sync, fast path)
 *  5. Chat                (async, heavy)
 *  6. Agent / tools       (async)
 *
 * @returns `true` if any handler claimed the request, `false` otherwise.
 */
export async function dispatchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServerDeps,
): Promise<boolean> {
  /* 1. Config / personas — sync fast path */
  if (handleConfigRoutes(req, res, url, deps)) return true;

  /* 2. Pairing */
  if (await handleSocialRoutes(req, res, url, deps)) return true;

  /* 3. HITL */
  if (await handleHitlRoutes(req, res, url, deps)) return true;

  /* 4. Health — sync fast path */
  if (handleHealthRoutes(req, res, url, deps)) return true;

  /* 5. Chat */
  if (await handleChatRoutes(req, res, url, deps)) return true;

  /* 6. Tools / agents */
  if (await handleAgentRoutes(req, res, url, deps)) return true;

  return false;
}
