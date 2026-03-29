/**
 * @fileoverview Shared HTTP helper utilities for CLI server route handlers.
 * @module wunderland/cli/commands/start/routes/helpers
 *
 * These are lightweight functions extracted from http-server.ts so that
 * individual route files can read request bodies, send JSON responses,
 * and check authorization without duplicating the logic.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Read the full request body (up to 1 MB) as a UTF-8 string. */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const maxBytes = 1_000_000;

    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Serialize a value as JSON and send it with the given HTTP status code. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/** Extract a single string value from a request header (first value if array). */
export function getHeaderString(req: IncomingMessage, header: string): string {
  const v = req.headers[header.toLowerCase()];
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return (v[0] || '').trim();
  return '';
}

/** Extract the HITL secret from the request header or query parameter. */
export function extractHitlSecret(req: IncomingMessage, url: URL): string {
  const fromHeader = getHeaderString(req, 'x-wunderland-hitl-secret');
  if (fromHeader) return fromHeader;
  return (url.searchParams.get('secret') || '').trim();
}

/** Check whether the request carries a valid HITL secret. */
export function isHitlAuthorized(req: IncomingMessage, url: URL, hitlSecret: string): boolean {
  if (!hitlSecret) return true;
  return extractHitlSecret(req, url) === hitlSecret;
}

/** Extract the chat secret from the request header or query parameter. */
export function extractChatSecret(req: IncomingMessage, url: URL): string {
  const fromHeader = getHeaderString(req, 'x-wunderland-chat-secret');
  if (fromHeader) return fromHeader;
  return (url.searchParams.get('chat_secret') || url.searchParams.get('secret') || '').trim();
}

/** Check whether the request carries a valid chat secret. */
export function isChatAuthorized(req: IncomingMessage, url: URL, chatSecret: string): boolean {
  if (!chatSecret) return true;
  return extractChatSecret(req, url) === chatSecret;
}

/** Check whether the request originates from the loopback interface. */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/** Extract the feed secret from the request header or query parameter. */
export function extractFeedSecret(req: IncomingMessage, url: URL): string {
  const fromHeader = getHeaderString(req, 'x-wunderland-feed-secret');
  if (fromHeader) return fromHeader;
  return (url.searchParams.get('feed_secret') || '').trim();
}

/** Check whether the request carries a valid feed secret. */
export function isFeedAuthorized(req: IncomingMessage, url: URL, feedSecret: string): boolean {
  if (!feedSecret) return true;
  return extractFeedSecret(req, url) === feedSecret;
}
