// @ts-nocheck
/**
 * @fileoverview HTTP server factory for the multi-agent dashboard.
 * @module wunderland/cli/commands/dashboard/dashboard-server
 *
 * Minimal server — no LLM, no tools, no per-agent runtime state.
 * Handles CORS, OPTIONS preflight, and delegates to the route dispatcher.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dispatchDashboardRoute } from './routes/index.js';
import type { DashboardDeps } from './routes/types.js';

/**
 * Create a standalone HTTP server for the multi-agent hub dashboard.
 *
 * @param deps - Shared dependencies (admin secret, startup metadata).
 * @returns The configured `http.Server` instance (not yet listening).
 */
export function createDashboardServer(deps: DashboardDeps): import('node:http').Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      /* ── CORS ──────────────────────────────────────────────────────────── */
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Wunderland-Secret',
      );

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      /* ── Route dispatch ────────────────────────────────────────────────── */
      if (await dispatchDashboardRoute(req, res, url, deps)) {
        return;
      }

      /* ── 404 fallback ──────────────────────────────────────────────────── */
      const json = JSON.stringify({ error: 'Not Found' });
      res.writeHead(404, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
      });
      res.end(json);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Server error';
      const json = JSON.stringify({ error: msg });
      try {
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json),
        });
        res.end(json);
      } catch {
        /* Response may already be flushed — nothing we can do. */
      }
    }
  });

  return server;
}
