// @ts-nocheck
/**
 * @fileoverview Real-path check of the telephony webhook's media-stream XML.
 *
 * `telephony-auto-bridge.test.ts` mocks the AgentOS telephony helpers, so it
 * cannot see whether the path the webhook server imports exists in the
 * installed `@framers/agentos`. This file mocks nothing: the webhook server
 * loads the published TwiML helpers and must answer each provider with the
 * stream XML they produce.
 *
 * @module wunderland/__tests__/telephony-webhook-twiml
 */

import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { startTelephonyWebhookServer } from '../channels/voice/telephony-webhook-server.js';

function provider() {
  return {
    verifyWebhook: () => ({ valid: true }),
    parseWebhookEvent: () => ({ events: [] }),
  };
}

/** POSTs to the server; fails fast when the server never answers. */
function post(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.setTimeout(4000, () => req.destroy(new Error('webhook server sent no response')));
    req.on('error', reject);
    req.end(body);
  });
}

describe('telephony webhook server with the installed AgentOS helpers', () => {
  let server: Awaited<ReturnType<typeof startTelephonyWebhookServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it.each([
    ['twilio', '<Response><Connect><Stream url="wss://voice.example.com/stream" /></Connect></Response>'],
    ['plivo', '<Stream bidirectional="true" keepCallAlive="true">wss://voice.example.com/stream</Stream>'],
    ['telnyx', '<Response><Stream url="wss://voice.example.com/stream" /></Response>'],
  ])('answers a %s call with its media-stream XML', async (name, expected) => {
    server = await startTelephonyWebhookServer(
      { processNormalizedEvent: () => {} },
      new Map([[name, provider()]]),
      undefined,
      { port: 0, wsServerUrl: 'wss://voice.example.com/stream' },
    );

    const res = await post(`http://127.0.0.1:${server.port}/api/voice/webhook/${name}`, 'CallSid=CA1');

    expect(res.status).toBe(200);
    expect(res.body).toContain(expected);
  }, 15000);
});
