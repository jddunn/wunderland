/**
 * @fileoverview Pairing route handlers for the Wunderland API server.
 * @module wunderland/api/routes/social
 *
 * Endpoints handled:
 *  - `GET  /pairing`           — Serve the pairing management HTML page
 *  - `GET  /pairing/requests`  — List pending pairing requests per channel
 *  - `GET  /pairing/allowlist` — List approved users per channel
 *  - `POST /pairing/approve`   — Approve a pairing request by channel+code
 *  - `POST /pairing/reject`    — Reject a pairing request by channel+code
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson, isHitlAuthorized, PAIRING_PAGE_HTML } from '../server-helpers.js';
import type { ServerDeps, RouteHandlerResult } from './types.js';

/**
 * Attempt to handle pairing/social-related routes.
 *
 * @param req  - Incoming HTTP request
 * @param res  - Server response
 * @param url  - Parsed request URL
 * @param deps - Shared server dependencies
 * @returns `true` if the request was handled, `false` to fall through
 */
export async function handleSocialRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServerDeps,
): Promise<RouteHandlerResult> {
  if (!url.pathname.startsWith('/pairing')) return false;

  const { hitlSecret, pairing, pairingEnabled, adapterByPlatform, broadcastHitlUpdate } = deps;

  /* Serve the pairing management UI */
  if (req.method === 'GET' && url.pathname === '/pairing') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAIRING_PAGE_HTML);
    return true;
  }

  /* All other pairing routes require HITL authorization */
  if (!isHitlAuthorized(req, url, hitlSecret)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  const channels = Array.from(adapterByPlatform.keys());

  if (req.method === 'GET' && url.pathname === '/pairing/requests') {
    const requestsByChannel: Record<string, unknown> = {};
    for (const channel of channels) {
      try {
        (requestsByChannel as any)[channel] = await pairing.listRequests(channel as any);
      } catch {
        (requestsByChannel as any)[channel] = [];
      }
    }
    sendJson(res, 200, { pairingEnabled, channels, requestsByChannel });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/pairing/allowlist') {
    const allowlistByChannel: Record<string, unknown> = {};
    for (const channel of channels) {
      try {
        (allowlistByChannel as any)[channel] = await pairing.readAllowlist(channel as any);
      } catch {
        (allowlistByChannel as any)[channel] = [];
      }
    }
    sendJson(res, 200, { channels, allowlistByChannel });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/pairing/approve') {
    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : {};
    const channel = typeof parsed?.channel === 'string' ? parsed.channel.trim() : '';
    const code = typeof parsed?.code === 'string' ? parsed.code.trim() : '';
    if (!channel || !code) {
      sendJson(res, 400, { error: 'Missing channel/code' });
      return true;
    }
    const result = await pairing.approveCode(channel as any, code);
    void broadcastHitlUpdate({ type: 'pairing_approved', channel, code });
    sendJson(res, 200, { ok: true, result });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/pairing/reject') {
    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : {};
    const channel = typeof parsed?.channel === 'string' ? parsed.channel.trim() : '';
    const code = typeof parsed?.code === 'string' ? parsed.code.trim() : '';
    if (!channel || !code) {
      sendJson(res, 400, { error: 'Missing channel/code' });
      return true;
    }
    const ok = await pairing.rejectCode(channel as any, code);
    void broadcastHitlUpdate({ type: 'pairing_rejected', channel, code });
    sendJson(res, 200, { ok });
    return true;
  }

  /* Unknown pairing sub-route */
  sendJson(res, 404, { error: 'Not Found' });
  return true;
}
