/**
 * @fileoverview HITL (Human-In-The-Loop) and health route handlers for the Wunderland API server.
 * @module wunderland/api/routes/health
 *
 * Endpoints handled:
 *  - `GET  /health`                               — Basic health check with uptime, tool/channel counts
 *  - `GET  /hitl`                                  — Serve the HITL management HTML page
 *  - `GET  /hitl/pending`                          — List pending approval/checkpoint requests
 *  - `GET  /hitl/stats`                            — HITL subsystem statistics
 *  - `GET  /hitl/stream`                           — SSE stream for real-time HITL updates
 *  - `POST /hitl/approvals/:actionId/approve`      — Approve a pending tool-call action
 *  - `POST /hitl/approvals/:actionId/reject`       — Reject a pending tool-call action
 *  - `POST /hitl/checkpoints/:checkpointId/continue` — Continue past a checkpoint
 *  - `POST /hitl/checkpoints/:checkpointId/pause`    — Pause at a checkpoint
 *  - `POST /hitl/checkpoints/:checkpointId/abort`    — Abort at a checkpoint
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson, isHitlAuthorized, HITL_PAGE_HTML } from '../server-helpers.js';
import type { ServerDeps, RouteHandlerResult } from './types.js';

/**
 * Attempt to handle health check routes.
 *
 * @param req  - Incoming HTTP request
 * @param res  - Server response
 * @param url  - Parsed request URL
 * @param deps - Shared server dependencies
 * @returns `true` if the request was handled, `false` to fall through
 */
export function handleHealthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServerDeps,
): RouteHandlerResult {
  if (req.method !== 'GET' || url.pathname !== '/health') return false;

  const { seedId, displayName, selectedPersona, activePersonaId, availablePersonas } = deps;

  sendJson(res, 200, {
    ok: true,
    seedId,
    name: displayName,
    persona: selectedPersona ?? (activePersonaId !== seedId ? { id: activePersonaId } : undefined),
    personasAvailable: Array.isArray(availablePersonas) ? availablePersonas.length : 0,
  });
  return true;
}

/**
 * Attempt to handle HITL-related routes (approvals, checkpoints, SSE stream).
 *
 * @param req  - Incoming HTTP request
 * @param res  - Server response
 * @param url  - Parsed request URL
 * @param deps - Shared server dependencies
 * @returns `true` if the request was handled, `false` to fall through
 */
export async function handleHitlRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServerDeps,
): Promise<RouteHandlerResult> {
  if (!url.pathname.startsWith('/hitl')) return false;

  const { hitlSecret, hitlManager, sseClients, broadcastHitlUpdate } = deps;

  /* Serve the HITL management UI */
  if (req.method === 'GET' && url.pathname === '/hitl') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HITL_PAGE_HTML);
    return true;
  }

  /* All other HITL routes require authorization */
  if (!isHitlAuthorized(req, url, hitlSecret)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/hitl/pending') {
    const pending = await hitlManager.getPendingRequests();
    sendJson(res, 200, pending);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/hitl/stats') {
    sendJson(res, 200, hitlManager.getStatistics());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/hitl/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: ready\ndata: {}\n\n');
    sseClients.add(res);

    /* Push an initial snapshot so the UI is immediately populated. */
    try {
      const pending = await hitlManager.getPendingRequests();
      res.write(`event: hitl\ndata: ${JSON.stringify({ type: 'snapshot', pending })}\n\n`);
    } catch {
      // ignore
    }

    const ping = setInterval(() => {
      try {
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch {
        // ignore
      }
    }, 15_000);

    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return true;
  }

  /* Approval decisions */
  if (req.method === 'POST' && url.pathname.startsWith('/hitl/approvals/')) {
    const parts = url.pathname.split('/').filter(Boolean);
    const actionId = parts[2] || '';
    const action = parts[3] || '';
    if (!actionId || (action !== 'approve' && action !== 'reject')) {
      sendJson(res, 404, { error: 'Not Found' });
      return true;
    }
    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : {};
    const decidedBy =
      typeof parsed?.decidedBy === 'string' && parsed.decidedBy.trim() ? parsed.decidedBy.trim() : 'operator';
    const rejectionReason = typeof parsed?.reason === 'string' ? parsed.reason : undefined;

    await hitlManager.submitApprovalDecision({
      actionId,
      approved: action === 'approve',
      decidedBy,
      decidedAt: new Date(),
      ...(action === 'reject' && rejectionReason ? { rejectionReason } : null),
    });

    void broadcastHitlUpdate({ type: 'approval_decision', actionId, approved: action === 'approve', decidedBy });
    sendJson(res, 200, { ok: true });
    return true;
  }

  /* Checkpoint decisions */
  if (req.method === 'POST' && url.pathname.startsWith('/hitl/checkpoints/')) {
    const parts = url.pathname.split('/').filter(Boolean);
    const checkpointId = parts[2] || '';
    const action = parts[3] || '';
    if (!checkpointId || (action !== 'continue' && action !== 'pause' && action !== 'abort')) {
      sendJson(res, 404, { error: 'Not Found' });
      return true;
    }
    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : {};
    const decidedBy =
      typeof parsed?.decidedBy === 'string' && parsed.decidedBy.trim() ? parsed.decidedBy.trim() : 'operator';
    const instructions = typeof parsed?.instructions === 'string' ? parsed.instructions : undefined;

    await hitlManager.submitCheckpointDecision({
      checkpointId,
      decision: action as any,
      decidedBy,
      decidedAt: new Date(),
      ...(instructions ? { instructions } : null),
    } as any);

    void broadcastHitlUpdate({ type: 'checkpoint_decision', checkpointId, decision: action, decidedBy });
    sendJson(res, 200, { ok: true });
    return true;
  }

  /* Unknown HITL sub-route */
  sendJson(res, 404, { error: 'Not Found' });
  return true;
}
