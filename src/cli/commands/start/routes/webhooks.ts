// @ts-nocheck
/**
 * @fileoverview Generic authenticated webhook wake endpoints for the agent server.
 * @module wunderland/cli/commands/start/routes/webhooks
 *
 * `POST /webhooks/:hookId` lets external systems wake an agent.
 *
 * Auth (either form):
 *  - HMAC-SHA256 over `${timestamp}.${rawBody}` in `X-Wunderland-Signature`
 *    with `X-Wunderland-Timestamp` (±5 min tolerance, constant-time compare).
 *  - `Authorization: Bearer <secret>` for simple callers.
 *
 * Unknown hook id and failed auth return the SAME generic 404 so the hook
 * surface cannot be probed. Every accepted hit is rate-limited per hook.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** One configured webhook (from agent config `webhooks[]`). */
export interface WebhookHookConfig {
  /** URL path segment: POST /webhooks/<id>. */
  id: string;
  /** Shared secret for HMAC or bearer auth. */
  secret: string;
  /** `turn` wakes the agent with the payload; `notify` only broadcasts it. */
  mode: 'turn' | 'notify';
}

/** Injected dependencies (host wiring supplies these). */
export interface WebhookDeps {
  hooks: WebhookHookConfig[];
  /** Wake the agent with the payload as a turn. */
  enqueueTurn: (hookId: string, payload: string) => Promise<void>;
  /** Broadcast the payload to observers without waking a turn. */
  appendFeed: (hookId: string, payload: string) => Promise<void>;
  /** Clock seam (tests). */
  now?: () => number;
}

const TOLERANCE_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_PER_MIN = 60;

/** Fixed-window token buckets keyed by hook id. */
const buckets = new Map<string, { windowStart: number; count: number }>();

/** Reset the rate limiter (tests). */
export function resetWebhookRateLimiter(): void {
  buckets.clear();
}

function rateLimited(hookId: string, now: number): boolean {
  const bucket = buckets.get(hookId);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    buckets.set(hookId, { windowStart: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_PER_MIN;
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function authenticated(
  hook: WebhookHookConfig,
  req: IncomingMessage,
  rawBody: string,
  now: number,
): boolean {
  const auth = String(req.headers['authorization'] ?? '');
  if (auth.startsWith('Bearer ')) {
    return constantTimeEqual(Buffer.from(auth.slice(7)), Buffer.from(hook.secret));
  }

  const timestamp = String(req.headers['x-wunderland-timestamp'] ?? '');
  const signatureHex = String(req.headers['x-wunderland-signature'] ?? '');
  if (!timestamp || !signatureHex) return false;

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > TOLERANCE_MS) return false;

  const expected = createHmac('sha256', hook.secret).update(`${timestamp}.${rawBody}`).digest();
  try {
    return constantTimeEqual(Buffer.from(signatureHex, 'hex'), expected);
  } catch {
    return false;
  }
}

/**
 * Handle `POST /webhooks/:hookId`.
 *
 * @returns `true` when this module claimed the request, `false` to let the
 *   dispatch chain continue.
 */
export async function handleWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: string,
  deps: WebhookDeps,
): Promise<boolean> {
  const pathname = (req.url ?? '').split('?')[0] ?? '';
  const match = /^\/webhooks\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (!match) return false;

  const send = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method !== 'POST') {
    send(404, { error: 'Not Found' });
    return true;
  }

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    send(413, { error: 'Payload too large' });
    return true;
  }

  const now = (deps.now ?? Date.now)();
  const hook = deps.hooks.find((candidate) => candidate.id === match[1]);

  // Unknown hook and failed auth are indistinguishable by design.
  if (!hook || !authenticated(hook, req, rawBody, now)) {
    send(404, { error: 'Not Found' });
    return true;
  }

  if (rateLimited(hook.id, now)) {
    send(429, { error: 'Too Many Requests' });
    return true;
  }

  try {
    if (hook.mode === 'turn') await deps.enqueueTurn(hook.id, rawBody);
    else await deps.appendFeed(hook.id, rawBody);
  } catch (err) {
    console.warn(`[webhooks] hook=${hook.id} processing failed:`, err);
    send(500, { error: 'Webhook processing failed' });
    return true;
  }

  send(202, { accepted: true });
  return true;
}
