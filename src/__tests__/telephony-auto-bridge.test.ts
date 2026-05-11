// @ts-nocheck
/**
 * @fileoverview Tests for the telephony media-stream auto-bridge.
 *
 * Covers:
 * 1. Webhook returns TwiML with stream URL when `wsServerUrl` is provided.
 * 2. Webhook returns Plivo XML when provider is 'plivo'.
 * 3. Webhook returns Telnyx XML when provider is 'telnyx'.
 * 4. Webhook returns empty body when provider supplies its own `responseBody`.
 * 5. WS server detects a Twilio media stream from the first message.
 * 6. WS server detects a Telnyx media stream from the first message.
 * 7. WS server detects a Plivo media stream from the first message.
 * 8. WS server falls back to browser WebSocket transport for non-JSON first messages.
 * 9. WS server falls back to browser transport for JSON without `event: start|connected`.
 * 10. Telephony transport is wired to the pipeline (startSession called with transport).
 *
 * @module wunderland/__tests__/telephony-auto-bridge
 */

import { EventEmitter } from 'node:events';
import http from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock @framers/agentos/voice ───────────────────────────────────────────────

class MockTwilioMediaStreamParser {
  readonly _type = 'twilio';
  parseIncoming() { return null; }
  formatOutgoing() { return '{}'; }
  formatConnected() { return '{}'; }
}

class MockTelnyxMediaStreamParser {
  readonly _type = 'telnyx';
  parseIncoming() { return null; }
  formatOutgoing(audio: Buffer) { return audio; }
  formatConnected() { return null; }
}

class MockPlivoMediaStreamParser {
  readonly _type = 'plivo';
  parseIncoming() { return null; }
  formatOutgoing() { return '{}'; }
}

/** Mock TelephonyStreamTransport captures constructor args for assertions. */
class MockTelephonyStreamTransport extends EventEmitter {
  readonly id = 'telephony-transport-id';
  readonly state = 'connecting';
  readonly parser: unknown;

  constructor(_ws: unknown, parser: unknown, _config?: unknown) {
    super();
    this.parser = parser;
  }

  async sendAudio() {}
  async sendControl() {}
  close() {}
}

vi.mock('@framers/agentos/voice', () => ({
  TwilioMediaStreamParser: MockTwilioMediaStreamParser,
  TelnyxMediaStreamParser: MockTelnyxMediaStreamParser,
  PlivoMediaStreamParser: MockPlivoMediaStreamParser,
  TelephonyStreamTransport: MockTelephonyStreamTransport,
  twilioConversationTwiml: (url: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Connect><Stream url="${url}" /></Connect></Response>`,
  plivoStreamXml: (url: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Stream bidirectional="true" keepCallAlive="true">${url}</Stream></Response>`,
  telnyxStreamXml: (url: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Stream url="${url}" /></Response>`,
}));

// ── Mock @framers/agentos/io/voice-pipeline ──────────────────────────────────────

class MockWebSocketStreamTransport extends EventEmitter {
  readonly id = 'ws-transport-id';
  readonly sampleRate: number;

  constructor(_ws: unknown, opts?: { sampleRate?: number }) {
    super();
    this.sampleRate = opts?.sampleRate ?? 16000;
  }
}

vi.mock('@framers/agentos/io/voice-pipeline', () => ({
  WebSocketStreamTransport: MockWebSocketStreamTransport,
  VoicePipelineOrchestrator: vi.fn(),
  HeuristicEndpointDetector: vi.fn(),
  AcousticEndpointDetector: vi.fn(),
  HardCutBargeinHandler: vi.fn(),
  SoftFadeBargeinHandler: vi.fn(),
}));

// ── Imports under test (after mocks) ─────────────────────────────────────────

import { startTelephonyWebhookServer } from '../channels/voice/telephony-webhook-server.js';
import { startVoiceServer } from '../channels/voice/ws-server.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal telephony provider mock that always validates and returns
 * either a supplied `responseBody` or `undefined` to trigger auto-TwiML.
 */
function makeProvider(responseBody?: string) {
  return {
    verifyWebhook: () => ({ valid: true }),
    parseWebhookEvent: () => ({
      events: [],
      responseContentType: 'text/xml',
      responseBody,
    }),
  };
}

/**
 * POST a request to a local HTTP server and return the full response body.
 */
async function httpPost(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Minimal fake WebSocket that quacks like `ws.WebSocket` for testing.
 *
 * Emits 'message' immediately via a deferred microtask to allow the server's
 * `ws.once('message', …)` listener to be registered first.
 */
function makeFakeWs(firstMessage: string | Buffer): EventEmitter & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const ws = new EventEmitter() as EventEmitter & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  ws.send = vi.fn();
  ws.close = vi.fn();

  // Queue the first message emission so the server can attach its once-listener.
  Promise.resolve().then(() => ws.emit('message', firstMessage));

  return ws;
}

/**
 * Build a minimal pipeline mock where `startSession` captures the transport.
 */
function makePipeline() {
  const sessions: unknown[] = [];
  const pipeline = {
    config: { stt: 'whisper-chunked', tts: 'openai' },
    startSession: vi.fn(async (transport: unknown) => {
      sessions.push(transport);
      return { sessionId: 'sid', state: 'listening', transport, close: vi.fn() };
    }),
  };
  return { pipeline, sessions };
}

// ── Webhook server tests ──────────────────────────────────────────────────────

describe('startTelephonyWebhookServer — TwiML auto-generation', () => {
  let server: Awaited<ReturnType<typeof startTelephonyWebhookServer>>;

  afterEach(async () => {
    await server?.close();
  });

  it('returns Twilio TwiML containing the wsServerUrl when provider is twilio', async () => {
    const callManager = { processNormalizedEvent: vi.fn() };
    const providers = new Map([['twilio', makeProvider()]]);

    server = await startTelephonyWebhookServer(callManager, providers, undefined, {
      port: 0,
      wsServerUrl: 'ws://localhost:8765',
    });

    const res = await httpPost(
      `http://127.0.0.1:${server.port}/api/voice/webhook/twilio`,
      'CallSid=CA123&From=%2B15551234567',
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toContain('<Stream');
    expect(res.body).toContain('ws://localhost:8765');
    expect(res.body).toContain('<Connect>');
  });

  it('returns Plivo XML containing the wsServerUrl when provider is plivo', async () => {
    const callManager = { processNormalizedEvent: vi.fn() };
    const providers = new Map([['plivo', makeProvider()]]);

    server = await startTelephonyWebhookServer(callManager, providers, undefined, {
      port: 0,
      wsServerUrl: 'ws://localhost:8765',
    });

    const res = await httpPost(
      `http://127.0.0.1:${server.port}/api/voice/webhook/plivo`,
      'CallUUID=abc&From=15551234567',
    );

    expect(res.status).toBe(200);
    expect(res.body).toContain('<Stream');
    expect(res.body).toContain('ws://localhost:8765');
    expect(res.body).toContain('bidirectional');
  });

  it('returns Telnyx XML containing the wsServerUrl when provider is telnyx', async () => {
    const callManager = { processNormalizedEvent: vi.fn() };
    const providers = new Map([['telnyx', makeProvider()]]);

    server = await startTelephonyWebhookServer(callManager, providers, undefined, {
      port: 0,
      wsServerUrl: 'wss://voice.example.com/stream',
    });

    const res = await httpPost(
      `http://127.0.0.1:${server.port}/api/voice/webhook/telnyx`,
      '{}',
    );

    expect(res.status).toBe(200);
    expect(res.body).toContain('<Stream');
    expect(res.body).toContain('wss://voice.example.com/stream');
  });

  it('uses the provider-supplied responseBody when present (no auto-TwiML)', async () => {
    const providerXml = '<Response><Reject/></Response>';
    const callManager = { processNormalizedEvent: vi.fn() };
    const providers = new Map([['twilio', makeProvider(providerXml)]]);

    server = await startTelephonyWebhookServer(callManager, providers, undefined, {
      port: 0,
      wsServerUrl: 'ws://localhost:8765',
    });

    const res = await httpPost(
      `http://127.0.0.1:${server.port}/api/voice/webhook/twilio`,
      'CallSid=CA123',
    );

    expect(res.status).toBe(200);
    // Must use the provider body verbatim, not the auto-generated TwiML.
    expect(res.body).toBe(providerXml);
    expect(res.body).not.toContain('<Stream');
  });

  it('returns empty body when wsServerUrl is not set and provider supplies no body', async () => {
    const callManager = { processNormalizedEvent: vi.fn() };
    const providers = new Map([['twilio', makeProvider()]]);

    server = await startTelephonyWebhookServer(callManager, providers, undefined, {
      port: 0,
      // wsServerUrl intentionally omitted
    });

    const res = await httpPost(
      `http://127.0.0.1:${server.port}/api/voice/webhook/twilio`,
      'CallSid=CA123',
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe('');
  });
});

// ── WebSocket server provider-detection tests ─────────────────────────────────

describe('startVoiceServer — telephony auto-detection', () => {
  let server: Awaited<ReturnType<typeof startVoiceServer>>;

  afterEach(async () => {
    await server?.close();
  });

  it('detects Twilio media stream and uses TelephonyStreamTransport', async () => {
    const { pipeline } = makePipeline();
    server = await startVoiceServer(pipeline as any, () => ({ sendText: async function* () {} } as any));

    const twilioStart = JSON.stringify({
      event: 'start',
      streamSid: 'MZ123abc',
      start: { callSid: 'CA456', streamSid: 'MZ123abc' },
    });

    const fakeWs = makeFakeWs(twilioStart);
    // Trigger the server's 'connection' handler manually.
    (server as any); // server is already listening; emit connection event on wss
    // Access the underlying wss via a second server instantiation is complex,
    // so we test detectTelephonyProvider logic directly through the pipeline mock.
    // We simulate by calling the connection handler: patch wss via re-export.
    // Instead: test the exported helper indirectly by verifying pipeline receives
    // a TelephonyStreamTransport when a Twilio start message arrives.
    // This is done by starting a real server and connecting to it:
    const WebSocket = (await import('ws')).WebSocket;
    const ws = new WebSocket(server.url);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(twilioStart);
        // Give the server a tick to process.
        setTimeout(resolve, 50);
      });
      ws.on('error', reject);
    });

    ws.close();

    // pipeline.startSession should have been called once.
    expect(pipeline.startSession).toHaveBeenCalledOnce();
    const transport = pipeline.startSession.mock.calls[0]?.[0];
    // The transport should be a MockTelephonyStreamTransport (our vi.mock).
    expect(transport).toBeInstanceOf(MockTelephonyStreamTransport);
    // And the parser should be the Twilio one.
    expect((transport as MockTelephonyStreamTransport).parser).toBeInstanceOf(
      MockTwilioMediaStreamParser,
    );
  });

  it('detects Telnyx media stream and uses TelephonyStreamTransport with Telnyx parser', async () => {
    const { pipeline } = makePipeline();
    server = await startVoiceServer(pipeline as any, () => ({ sendText: async function* () {} } as any));

    const telnyxStart = JSON.stringify({
      event: 'start',
      stream_id: 'telnyx-stream-abc',
      call_control_id: 'ctrl-xyz',
    });

    const WebSocket = (await import('ws')).WebSocket;
    const ws = new WebSocket(server.url);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(telnyxStart);
        setTimeout(resolve, 50);
      });
      ws.on('error', reject);
    });

    ws.close();

    expect(pipeline.startSession).toHaveBeenCalledOnce();
    const transport = pipeline.startSession.mock.calls[0]?.[0];
    expect(transport).toBeInstanceOf(MockTelephonyStreamTransport);
    expect((transport as MockTelephonyStreamTransport).parser).toBeInstanceOf(
      MockTelnyxMediaStreamParser,
    );
  });

  it('detects Plivo media stream and uses TelephonyStreamTransport with Plivo parser', async () => {
    const { pipeline } = makePipeline();
    server = await startVoiceServer(pipeline as any, () => ({ sendText: async function* () {} } as any));

    const plivoStart = JSON.stringify({
      event: 'start',
      stream_id: 'plivo-stream-def',
      call_uuid: 'call-uuid-123',
    });

    const WebSocket = (await import('ws')).WebSocket;
    const ws = new WebSocket(server.url);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(plivoStart);
        setTimeout(resolve, 50);
      });
      ws.on('error', reject);
    });

    ws.close();

    expect(pipeline.startSession).toHaveBeenCalledOnce();
    const transport = pipeline.startSession.mock.calls[0]?.[0];
    expect(transport).toBeInstanceOf(MockTelephonyStreamTransport);
    expect((transport as MockTelephonyStreamTransport).parser).toBeInstanceOf(
      MockPlivoMediaStreamParser,
    );
  });

  it('falls back to WebSocketStreamTransport for a non-JSON (binary) first message', async () => {
    const { pipeline } = makePipeline();
    server = await startVoiceServer(pipeline as any, () => ({ sendText: async function* () {} } as any));

    // Raw PCM bytes — not JSON.
    const rawPcm = Buffer.alloc(320, 0);

    const WebSocket = (await import('ws')).WebSocket;
    const ws = new WebSocket(server.url);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(rawPcm);
        setTimeout(resolve, 50);
      });
      ws.on('error', reject);
    });

    ws.close();

    expect(pipeline.startSession).toHaveBeenCalledOnce();
    const transport = pipeline.startSession.mock.calls[0]?.[0];
    expect(transport).toBeInstanceOf(MockWebSocketStreamTransport);
  });

  it('falls back to WebSocketStreamTransport for JSON without telephony event field', async () => {
    const { pipeline } = makePipeline();
    server = await startVoiceServer(pipeline as any, () => ({ sendText: async function* () {} } as any));

    // Browser config message — no `event` field.
    const browserConfig = JSON.stringify({ type: 'config', sampleRate: 16000 });

    const WebSocket = (await import('ws')).WebSocket;
    const ws = new WebSocket(server.url);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(browserConfig);
        setTimeout(resolve, 50);
      });
      ws.on('error', reject);
    });

    ws.close();

    expect(pipeline.startSession).toHaveBeenCalledOnce();
    const transport = pipeline.startSession.mock.calls[0]?.[0];
    expect(transport).toBeInstanceOf(MockWebSocketStreamTransport);
  });

  it('wires telephony transport to pipeline (startSession called with transport)', async () => {
    const { pipeline } = makePipeline();
    const agentSession = { sendText: async function* () {} };
    server = await startVoiceServer(pipeline as any, () => agentSession as any);

    const twilioStart = JSON.stringify({
      event: 'connected',
      streamSid: 'MZconnected',
    });

    const WebSocket = (await import('ws')).WebSocket;
    const ws = new WebSocket(server.url);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(twilioStart);
        setTimeout(resolve, 50);
      });
      ws.on('error', reject);
    });

    ws.close();

    // Verify pipeline.startSession received both transport and agentSession.
    expect(pipeline.startSession).toHaveBeenCalledWith(
      expect.any(MockTelephonyStreamTransport),
      agentSession,
    );
  });
});
