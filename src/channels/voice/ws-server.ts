// @ts-nocheck
/**
 * @fileoverview Starts a local WebSocket server for voice pipeline sessions.
 *
 * Each inbound WebSocket connection is handed to the `VoicePipelineOrchestrator`
 * via the appropriate stream transport:
 *
 * - **Telephony media streams** (Twilio / Telnyx / Plivo) send a JSON
 *   `{ event: 'connected' }` or `{ event: 'start' }` message as their first
 *   frame.  The server auto-detects this shape, selects the matching
 *   {@link TelephonyStreamTransport} + {@link MediaStreamParser}, and wires
 *   the session into the pipeline automatically — no manual setup required.
 * - **Browser clients** send binary PCM audio or a `{ type: 'config' }` JSON
 *   message.  These use the standard `WebSocketStreamTransport`.
 *
 * The caller supplies an agent-session factory so that each connection receives
 * its own isolated session state.
 *
 * @module wunderland/voice/ws-server
 */

// @ts-ignore — ws types may not be installed in all environments
import { WebSocketServer } from 'ws';
import type { StreamingPipelineAgentSession, StreamingPipelineHandle } from './streaming-pipeline.js';

// ── Option / result types ────────────────────────────────────────────────────

/**
 * Configuration for {@link startVoiceServer}.
 */
export interface VoiceServerOptions {
  /**
   * TCP port to listen on. Passing `0` (the default) lets the OS assign a
   * random free port, which is then reflected in the returned `port` field.
   */
  port?: number;
  /**
   * Host/IP to bind to. Defaults to `'127.0.0.1'` (loopback only) for
   * security — change to `'0.0.0.0'` only when remote access is intentional.
   */
  host?: string;
}

/**
 * Handle returned by {@link startVoiceServer} once the server is ready.
 */
export interface VoiceServerHandle {
  /** The TCP port the server is actually bound to. */
  port: number;
  /** Full `ws://` URL clients should connect to. */
  url: string;
  /** Gracefully closes the WebSocket server and resolves when done. */
  close: () => Promise<void>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Detect whether the first WebSocket message indicates a telephony media stream
 * and, if so, which provider sent it.
 *
 * Telephony providers all send a JSON message with an `event` field of
 * `'connected'` or `'start'` as the very first frame.  Provider-specific
 * fields in that envelope identify the exact provider:
 *
 * - **Twilio** — `{ event: 'start'|'connected', streamSid: string, … }`
 * - **Telnyx** — `{ event: 'start', stream_id: string, call_control_id: string, … }`
 * - **Plivo**  — `{ event: 'start', stream_id: string, call_uuid: string, … }`
 *
 * Browser clients send either raw binary PCM or a `{ type: 'config' }` JSON
 * object — neither of which contains `event: 'connected'|'start'`.
 *
 * @param data - The raw first WebSocket message (string or Buffer).
 * @returns An object with `isTelephony` flag and, when `true`, the detected
 *   `providerName` (`'twilio'`, `'telnyx'`, `'plivo'`, or `'unknown'`).
 */
function detectTelephonyProvider(data: unknown): { isTelephony: boolean; providerName: string } {
  const raw = typeof data === 'string' ? data : (data as Buffer).toString('utf8');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Binary or non-JSON — definitely a browser client.
    return { isTelephony: false, providerName: 'unknown' };
  }

  const event = parsed['event'] as string | undefined;
  if (event !== 'connected' && event !== 'start') {
    return { isTelephony: false, providerName: 'unknown' };
  }

  // All three providers send these lifecycle events; narrow by envelope shape.
  if (typeof parsed['streamSid'] === 'string') {
    // Twilio always includes streamSid at the top level.
    return { isTelephony: true, providerName: 'twilio' };
  }

  if (typeof parsed['stream_id'] === 'string') {
    if (typeof parsed['call_control_id'] === 'string') {
      // Telnyx: stream_id + call_control_id.
      return { isTelephony: true, providerName: 'telnyx' };
    }
    if (typeof parsed['call_uuid'] === 'string') {
      // Plivo: stream_id + call_uuid.
      return { isTelephony: true, providerName: 'plivo' };
    }
    // stream_id present but can't narrow further — still telephony.
    return { isTelephony: true, providerName: 'unknown' };
  }

  return { isTelephony: true, providerName: 'unknown' };
}

/**
 * Instantiate the correct {@link MediaStreamParser} for the given provider.
 *
 * Falls back to `TwilioMediaStreamParser` for unrecognised provider names
 * since Twilio's format is the most widely adopted baseline.
 *
 * @param providerName - Lower-case provider identifier (`'twilio'`, `'telnyx'`, `'plivo'`).
 * @returns A `MediaStreamParser` instance ready to use with {@link TelephonyStreamTransport}.
 */
// @ts-ignore — @framers/agentos/voice subpath resolves at runtime after agentos build
async function resolveMediaStreamParser(providerName: string): Promise<any> {
  // @ts-ignore
  const mod = await import('@framers/agentos/voice');
  switch (providerName) {
    case 'telnyx':
      return new mod.TelnyxMediaStreamParser();
    case 'plivo':
      return new mod.PlivoMediaStreamParser();
    case 'twilio':
    default:
      // Unknown providers default to Twilio format (most common baseline).
      return new mod.TwilioMediaStreamParser();
  }
}

// ── Server factory ────────────────────────────────────────────────────────────

/**
 * Starts a WebSocket server that bridges incoming audio streams to the voice
 * pipeline orchestrator.
 *
 * The server automatically distinguishes between telephony media-stream
 * connections (Twilio / Telnyx / Plivo) and browser WebSocket clients by
 * inspecting the first message received on each new connection.  No additional
 * configuration is required beyond what is already needed for the pipeline.
 *
 * ```ts
 * const pipeline = await createStreamingPipeline({ tts: 'openai' });
 * const server   = await startVoiceServer(pipeline, () => myAgentSession, { port: 8765 });
 * console.log(`Voice server listening at ${server.url}`);
 * // Twilio / Telnyx / Plivo: point <Stream url="ws://host:8765" /> here.
 * // Browser:                 connect a standard WebSocket here.
 * ```
 *
 * @param pipeline - A prewired streaming pipeline handle created by
 *   {@link createStreamingPipeline}.
 * @param agentSessionFactory - Zero-arg factory called once per WebSocket
 *   connection. Must return an `IVoicePipelineAgentSession`-compatible object.
 * @param options - {@link VoiceServerOptions} for port/host binding.
 * @returns A {@link VoiceServerHandle} with the bound address and a `close()`
 *   method for clean shutdown.
 */
export async function startVoiceServer(
  pipeline: StreamingPipelineHandle,
  agentSessionFactory: () => StreamingPipelineAgentSession,
  options?: VoiceServerOptions,
): Promise<VoiceServerHandle> {
  const port = options?.port ?? 0;
  const host = options?.host ?? '127.0.0.1';

  const wss = new WebSocketServer({ port, host });

  // Wait until the server has bound its port before resolving.
  await new Promise<void>((resolve) => wss.on('listening', resolve));

  const actualPort = (wss.address() as { port?: number } | null)?.port ?? port;
  const url = `ws://${host}:${actualPort}`;

  wss.on('connection', async (ws: any) => {
    try {
      // ── Step 1: read first message to determine connection type ────────────
      //
      // We must not attach a permanent `message` listener yet; the first frame
      // decides the transport type. A one-time listener avoids double-delivery.
      const firstMessage = await new Promise<unknown>((resolve) => {
        ws.once('message', (data: any) => resolve(data));
      });

      const { isTelephony, providerName } = detectTelephonyProvider(firstMessage);

      if (isTelephony) {
        // ── Telephony path ─────────────────────────────────────────────────
        //
        // The first message is the provider's `connected` or `start` envelope.
        // We create the transport first, then re-emit the message so the
        // transport's internal `ws.on('message')` handler can process it
        // (it handles the `start` event to transition state to 'open').
        // @ts-ignore — subpath resolves at runtime
        const { TelephonyStreamTransport } = await import('@framers/agentos/voice');
        const parser = await resolveMediaStreamParser(providerName);

        const transport = new TelephonyStreamTransport(ws, parser, {
          outputSampleRate: 16000,
        });

        // Re-emit the first message so the transport can process the `start`
        // or `connected` lifecycle event it has already seen on the wire.
        ws.emit('message', firstMessage);

        const agentSession = agentSessionFactory();
        await pipeline.startSession(transport, agentSession);
      } else {
        // ── Browser path ────────────────────────────────────────────────────
        //
        // Use the standard WebSocketStreamTransport. Re-emit the first message
        // so the transport receives it along with all subsequent frames.
        const { WebSocketStreamTransport } = await import('@framers/agentos/io/voice-pipeline');

        const transport = new WebSocketStreamTransport(ws, { sampleRate: 16000 });

        // Re-emit so the transport sees this frame in its `message` handler.
        ws.emit('message', firstMessage);

        const agentSession = agentSessionFactory();
        await pipeline.startSession(transport, agentSession);
      }
    } catch (err) {
      // Surface the error as a WebSocket close frame (code 1011 = internal error).
      ws.close(1011, String(err));
    }
  });

  return {
    port: actualPort,
    url,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}
