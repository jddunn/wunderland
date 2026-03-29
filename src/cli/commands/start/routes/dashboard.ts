/**
 * @fileoverview Dashboard route handlers for the CLI HTTP server.
 * @module wunderland/cli/commands/start/routes/dashboard
 *
 * Endpoints handled:
 *  - `GET  /`                 — Serve the dashboard SPA HTML
 *  - `GET  /api/extensions`   — List loaded extension packs and tools
 *  - `GET  /api/events/stream`— SSE stream for real-time agent events
 *  - `GET  /api/graph`        — Current workflow graph nodes and edges
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { sendJson, isHitlAuthorized } from './helpers.js';
import { DASHBOARD_PAGE_HTML } from './dashboard-html.js';
import type { CliServerDeps, RouteHandlerResult } from './types.js';

/**
 * Attempt to handle dashboard-related routes.
 *
 * Serves the main dashboard SPA at `GET /` and provides API endpoints
 * for extensions, event streaming, and workflow graph data.
 *
 * @param req - Incoming HTTP request.
 * @param res - Server response object.
 * @param url - Parsed URL of the request.
 * @param deps - Shared CLI server dependencies.
 * @returns `true` if the request was handled, `false` to fall through.
 */
export async function handleDashboardRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CliServerDeps,
): Promise<RouteHandlerResult> {

  /* ── GET / — serve the dashboard HTML ────────────────────────────────── */
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_PAGE_HTML);
    return true;
  }

  /* ── GET /api/extensions — list loaded packs + tools ─────────────────── */
  if (req.method === 'GET' && url.pathname === '/api/extensions') {
    if (!isHitlAuthorized(req, url, deps.hitlSecret)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }

    const tools: Array<{
      name: string;
      description: string;
      category: string;
      hasSideEffects: boolean;
    }> = [];

    for (const [name, tool] of deps.toolMap) {
      tools.push({
        name,
        description: typeof tool.description === 'string' ? tool.description : '',
        category: typeof tool.category === 'string' ? tool.category : '',
        hasSideEffects: tool.hasSideEffects === true,
      });
    }

    const packs: Array<{ name: string; descriptorCount: number }> = [];
    if (Array.isArray(deps.activePacks)) {
      for (const pack of deps.activePacks) {
        packs.push({
          name: typeof pack?.name === 'string' ? pack.name : 'unnamed',
          descriptorCount: Array.isArray(pack?.descriptors) ? pack.descriptors.length : 0,
        });
      }
    }

    sendJson(res, 200, { tools, packs });
    return true;
  }

  /* ── GET /api/events/stream — SSE event stream ───────────────────────── */
  if (req.method === 'GET' && url.pathname === '/api/events/stream') {
    if (!isHitlAuthorized(req, url, deps.hitlSecret)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Wunderland-HITL-Secret',
    });
    res.write('event: ready\ndata: {}\n\n');

    /* Register this client for agent event broadcasts. */
    const clients = deps.eventSseClients;
    if (clients) {
      clients.add(res);
    }

    /* Keepalive ping every 15 seconds. */
    const ping = setInterval(() => {
      try {
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch {
        /* Connection already closed — cleaned up below. */
      }
    }, 15_000);

    req.on('close', () => {
      clearInterval(ping);
      if (clients) clients.delete(res);
    });

    return true;
  }

  /* ── GET /api/graph — current workflow graph ─────────────────────────── */
  if (req.method === 'GET' && url.pathname === '/api/graph') {
    if (!isHitlAuthorized(req, url, deps.hitlSecret)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }

    /*
     * Placeholder response — no graph runtime is wired yet.
     * When a workflow engine is integrated, this will return the compiled
     * graph nodes and edges for the currently running workflow.
     */
    sendJson(res, 200, { status: 'idle', nodes: [], edges: [] });
    return true;
  }

  return false;
}
