/**
 * @fileoverview Minimal HTTP server for receiving telephony provider webhooks.
 *
 * Starts a plain `node:http` server that listens for POST requests on
 * `{basePath}/webhook/:provider` and `{basePath}/status/:provider`.  For each
 * request the server:
 *
 * 1. Resolves the named provider from the supplied `providers` Map.
 * 2. Reads the raw body.
 * 3. Verifies the HMAC/signature via {@link IVoiceCallProvider.verifyWebhook}.
 * 4. Parses the event payload and forwards each normalised event to
 *    {@link CallManager.processNormalizedEvent}.
 * 5. Returns the provider-specific XML/JSON response (e.g. TwiML `<Response/>`).
 *
 * @module wunderland/voice/telephony-webhook-server
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Construction-time options for {@link startTelephonyWebhookServer}.
 */
export interface TelephonyWebhookServerOptions {
  /**
   * TCP port to listen on.  `0` lets the OS pick an available ephemeral port.
   * @defaultValue 0
   */
  port?: number;

  /**
   * Network interface address to bind to.
   * @defaultValue '127.0.0.1'
   */
  host?: string;

  /**
   * URL path prefix for all webhook routes.
   * @defaultValue '/api/voice'
   */
  basePath?: string;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Start a telephony webhook HTTP server and return a handle.
 *
 * ## Routing
 * - `POST {basePath}/webhook/:provider` — inbound call / status events
 * - `POST {basePath}/status/:provider`  — asynchronous status callbacks
 *
 * Both routes share the same handler; the distinction is meaningful only to
 * the provider and is transparent to this server.
 *
 * @param callManager - AgentOS {@link CallManager}-compatible instance whose
 *   `processNormalizedEvent()` method receives parsed events.
 * @param providers - Map from provider name (e.g. `'twilio'`, `'telnyx'`) to a
 *   provider instance implementing `verifyWebhook()` and `parseWebhookEvent()`.
 * @param pipeline - Streaming pipeline handle (reserved for future use; passed
 *   for API symmetry with other factory functions).
 * @param options - Optional server configuration overrides.
 * @returns Resolves to a handle with the bound `port`, the full `url` prefix,
 *   and a `close()` method that drains active connections before resolving.
 */
export async function startTelephonyWebhookServer(
  callManager: any,
  providers: Map<string, any>,
  pipeline: any,
  options?: TelephonyWebhookServerOptions,
): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  // ── Config ────────────────────────────────────────────────────────────────

  const basePath = options?.basePath ?? '/api/voice';
  const host = options?.host ?? '127.0.0.1';
  const port = options?.port ?? 0;

  // Escape the basePath so it is safe to embed in a RegExp literal.
  const escapedBase = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Matches `{basePath}/webhook/<name>` and `{basePath}/status/<name>`. */
  const routeRe = new RegExp(`^${escapedBase}/(?:webhook|status)/(.+)$`);

  // ── Request handler ───────────────────────────────────────────────────────

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );

    // ── Route matching ──────────────────────────────────────────────────────

    const routeMatch = url.pathname.match(routeRe);

    if (!routeMatch || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const providerName = routeMatch[1];
    const provider = providers.get(providerName);

    if (!provider) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Unknown provider: ${providerName}`);
      return;
    }

    // ── Read body ───────────────────────────────────────────────────────────

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString();

    // ── Signature verification ──────────────────────────────────────────────

    const ctx = {
      url: `${url.origin}${url.pathname}`,
      headers: req.headers as Record<string, string>,
      body: rawBody,
      rawBody,
      method: req.method ?? 'POST',
    };

    const verification = provider.verifyWebhook(ctx);
    if (!verification.valid) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Invalid signature');
      return;
    }

    // ── Parse and dispatch events ───────────────────────────────────────────

    const parseResult = provider.parseWebhookEvent(ctx);

    if (parseResult?.events) {
      for (const event of parseResult.events) {
        try {
          callManager.processNormalizedEvent?.(event);
        } catch {
          // Individual event dispatch errors are non-fatal; the HTTP response
          // must still be sent so the provider does not retry the webhook.
        }
      }
    }

    // ── Send provider-specific response ─────────────────────────────────────

    res.writeHead(200, {
      'Content-Type': parseResult?.responseContentType ?? 'text/xml',
    });
    res.end(parseResult?.responseBody ?? '');
  });

  // ── Listen ────────────────────────────────────────────────────────────────

  await new Promise<void>((resolve) => server.listen(port, host, resolve));

  const addr = server.address() as { port?: number } | null;
  const actualPort = addr?.port ?? port;

  return {
    port: actualPort,
    url: `http://${host}:${actualPort}${basePath}`,

    /**
     * Gracefully stop the server.
     *
     * Calls `server.close()` which prevents new connections; resolves once all
     * existing keep-alive connections have drained.
     */
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
