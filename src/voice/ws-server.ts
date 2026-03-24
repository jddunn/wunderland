/**
 * @fileoverview Starts a local WebSocket server for voice pipeline sessions.
 *
 * Each inbound WebSocket connection is handed to the `VoicePipelineOrchestrator`
 * via a `WebSocketStreamTransport`. The caller supplies a factory for agent
 * sessions so that each connection receives its own isolated session state.
 *
 * @module wunderland/voice/ws-server
 */

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

// ── Server factory ────────────────────────────────────────────────────────────

/**
 * Starts a WebSocket server that bridges incoming audio streams to the voice
 * pipeline orchestrator.
 *
 * ```ts
 * const pipeline = await createStreamingPipeline({ tts: 'openai' });
 * const server   = await startVoiceServer(pipeline, () => myAgentSession, { port: 8765 });
 * console.log(`Voice server listening at ${server.url}`);
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
  // Dynamic import keeps ws-related voice transport optional at load time.
  const { WebSocketStreamTransport } = await import('@framers/agentos/voice-pipeline');

  const port = options?.port ?? 0;
  const host = options?.host ?? '127.0.0.1';

  const wss = new WebSocketServer({ port, host });

  // Wait until the server has bound its port before resolving.
  await new Promise<void>((resolve) => wss.on('listening', resolve));

  const actualPort = (wss.address() as { port?: number } | null)?.port ?? port;
  const url = `ws://${host}:${actualPort}`;

  wss.on('connection', async (ws) => {
    // Each connection gets its own transport + agent session.
    const transport = new WebSocketStreamTransport(ws, { sampleRate: 16000 });
    const agentSession = agentSessionFactory();
    try {
      await pipeline.startSession(transport, agentSession);
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
