// @ts-nocheck
/**
 * @fileoverview Pairing and feed route handlers for the CLI HTTP server.
 * @module wunderland/cli/commands/start/routes/social
 *
 * Endpoints handled:
 *  - `GET  /pairing`           — Serve the pairing management HTML page
 *  - `GET  /pairing/requests`  — List pending pairing requests per channel
 *  - `GET  /pairing/allowlist` — List approved users per channel
 *  - `POST /pairing/approve`   — Approve a pairing request by channel+code
 *  - `POST /pairing/reject`    — Reject a pairing request by channel+code
 *  - `POST /api/feed`          — Post structured content to a Discord channel via webhook
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson, isHitlAuthorized, isFeedAuthorized } from './helpers.js';
import type { CliServerDeps, RouteHandlerResult } from './types.js';

/**
 * The pairing management HTML page — rendered inline as a self-contained SPA.
 * Contains connection UI, pending requests list, approved users, setup guides,
 * and FAQ/troubleshooting collapsible sections.
 */
export { PAIRING_PAGE_HTML } from './html-pages.js';

/**
 * Attempt to handle pairing/social-related routes.
 *
 * @returns `true` if the request was handled, `false` to fall through
 */
export async function handleSocialRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CliServerDeps,
): Promise<RouteHandlerResult> {
  if (!url.pathname.startsWith('/pairing')) return false;

  const { hitlSecret, pairing, pairingEnabled, adapterByPlatform, broadcastHitlUpdate } = deps;

  /* Serve the pairing management UI */
  if (req.method === 'GET' && url.pathname === '/pairing') {
    const { PAIRING_PAGE_HTML } = await import('./html-pages.js');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAIRING_PAGE_HTML);
    return true;
  }

  /* All other pairing routes require HITL authorization */
  if (!isHitlAuthorized(req, url, hitlSecret)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  const channels: string[] = Array.from(adapterByPlatform.keys()) as string[];

  if (req.method === 'GET' && url.pathname === '/pairing/requests') {
    const requestsByChannel: Record<string, unknown> = {};
    for (const channel of channels) {
      try {
        requestsByChannel[channel] = await pairing.listRequests(channel);
      } catch {
        requestsByChannel[channel] = [];
      }
    }
    sendJson(res, 200, { pairingEnabled, channels, requestsByChannel });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/pairing/allowlist') {
    const allowlistByChannel: Record<string, unknown> = {};
    for (const channel of channels) {
      try {
        allowlistByChannel[channel] = await pairing.readAllowlist(channel);
      } catch {
        allowlistByChannel[channel] = [];
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
    const result = await pairing.approveCode(channel, code);
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
    const ok = await pairing.rejectCode(channel, code);
    void broadcastHitlUpdate({ type: 'pairing_rejected', channel, code });
    sendJson(res, 200, { ok });
    return true;
  }

  /* Unknown pairing sub-route */
  sendJson(res, 404, { error: 'Not Found' });
  return true;
}

/**
 * Handle the feed ingestion API endpoint.
 * Accepts structured content (embeds, text) and posts to a Discord channel
 * via webhook. Used by external scrapers (e.g., Python news bots) that don't
 * have their own Discord gateway connection.
 *
 * @returns `true` if the request was handled, `false` to fall through
 */
export async function handleFeedRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CliServerDeps,
): Promise<RouteHandlerResult> {
  if (req.method !== 'POST' || url.pathname !== '/api/feed') return false;

  const { feedSecret, adapterByPlatform } = deps;

  if (!isFeedAuthorized(req, url, feedSecret)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  const body = await readBody(req);
  let parsed: any;
  try {
    parsed = JSON.parse(body || '{}');
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return true;
  }

  const channelId = typeof parsed.channelId === 'string' ? parsed.channelId.trim() : '';
  if (!channelId) {
    sendJson(res, 400, { error: 'Missing "channelId" in JSON body.' });
    return true;
  }

  const embeds = Array.isArray(parsed.embeds) ? parsed.embeds : [];
  const content = typeof parsed.content === 'string' ? parsed.content.trim() : '';
  if (embeds.length === 0 && !content) {
    sendJson(res, 400, { error: 'Provide at least one of "embeds" or "content".' });
    return true;
  }

  /* Find the Discord channel adapter to post through. */
  const discordAdapter = adapterByPlatform.get('discord');
  if (!discordAdapter) {
    sendJson(res, 503, { error: 'Discord channel adapter not loaded. Ensure "discord" is in agent.config.json channels.' });
    return true;
  }

  try {
    /* Access the underlying discord.js Client via the adapter's service. */
    const client = (discordAdapter as any)?.service?.getClient?.();
    if (!client) {
      sendJson(res, 503, { error: 'Discord client not available.' });
      return true;
    }

    const channel = await client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      sendJson(res, 404, { error: `Channel ${channelId} not found or not a text channel.` });
      return true;
    }

    const sendOptions: any = {};
    if (content) sendOptions.content = content;
    if (embeds.length > 0) sendOptions.embeds = embeds;
    /* Forward message flags (e.g. SUPPRESS_NOTIFICATIONS = 4096). */
    if (typeof parsed.flags === 'number' && parsed.flags > 0) {
      sendOptions.flags = parsed.flags;
    }

    /*
     * If a username is provided, send via webhook so the message
     * appears with a custom identity (e.g. "Wunderland News").
     */
    const webhookUsername = typeof parsed.username === 'string' ? parsed.username.trim() : '';
    const webhookAvatar = typeof parsed.avatar_url === 'string' ? parsed.avatar_url.trim() : '';
    let msg: any;
    if (webhookUsername) {
      const textChannel = channel as any;
      let webhook: any;
      try {
        const webhooks = await textChannel.fetchWebhooks();
        webhook = webhooks.find((w: any) => w.name === 'Wunderland Feed');
        if (!webhook) {
          webhook = await textChannel.createWebhook({ name: 'Wunderland Feed' });
        }
      } catch {
        /* Fallback to regular send if webhook creation fails (missing perms). */
        webhook = null;
      }
      if (webhook) {
        const whOpts: any = { ...sendOptions, username: webhookUsername };
        if (webhookAvatar) whOpts.avatarURL = webhookAvatar;
        msg = await webhook.send(whOpts);
      } else {
        msg = await textChannel.send(sendOptions);
      }
    } else {
      msg = await (channel as any).send(sendOptions);
    }

    const category = typeof parsed.category === 'string' ? parsed.category : '';
    if (category) {
      console.log(`[feed] Posted to #${(channel as any).name || channelId} (${category}): ${msg?.id || 'ok'}`);
    }

    sendJson(res, 200, { ok: true, messageId: msg?.id || null });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[feed] Error posting to ${channelId}:`, errMsg);
    sendJson(res, 500, { error: `Failed to post: ${errMsg}` });
  }
  return true;
}
