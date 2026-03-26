/**
 * @fileoverview Factory that creates a prewired streaming voice pipeline handle
 * for Wunderland CLI and library consumers.
 *
 * The returned handle creates a fresh `VoicePipelineOrchestrator` per session so
 * concurrent WebSocket connections do not share state. Streaming STT/TTS
 * providers are loaded lazily from the curated AgentOS voice extension packs.
 *
 * ## Pipeline handle pattern
 *
 * The factory resolves all provider dependencies (STT, TTS, endpointing,
 * barge-in, diarization) once during `createStreamingPipeline()`, then stores
 * them in the returned handle. Each call to `handle.startSession()` creates a
 * fresh `VoicePipelineOrchestrator` that receives a *new* endpoint detector and
 * barge-in handler (via the factory functions), but shares the same STT/TTS
 * provider instances. This avoids redundant network round-trips for provider
 * initialization while keeping per-session state (VAD buffers, transcript
 * history, etc.) isolated.
 *
 * ## Provider resolution
 *
 * Provider IDs are normalized to canonical short names (`'whisper-chunked'`,
 * `'deepgram'`, `'openai'`, `'elevenlabs'`). Unknown aliases for common
 * providers (e.g. `'openai-tts'` -> `'openai'`) are mapped automatically.
 * Resolution uses dynamic `import()` against the curated AgentOS extension
 * packs — packages that are not installed will throw at import time with a
 * descriptive error message.
 *
 * @module wunderland/voice/streaming-pipeline
 */

/**
 * Minimal transport identity token for a single voice connection.
 *
 * Typically backed by a `WebSocketStreamTransport` or
 * `TelephonyStreamTransport` from the AgentOS voice-pipeline package.
 */
export interface StreamingPipelineTransport {
  /** Opaque transport identifier, unique per connection. */
  readonly id: string;
}

/**
 * Agent-side session interface consumed by the voice pipeline orchestrator.
 *
 * The orchestrator calls `sendText()` each time the STT engine produces a
 * final transcript, and iterates the returned async iterable to stream the
 * agent's reply tokens into the TTS engine. `abort()` is invoked on barge-in
 * to cancel the in-flight LLM request.
 */
export interface StreamingPipelineAgentSession {
  /**
   * Processes a user utterance and streams the agent's reply tokens.
   *
   * @param text - Transcribed user speech (final, not interim).
   * @param metadata - Provider-specific metadata attached to the transcript
   *   (e.g. confidence, language, diarization speaker ID).
   * @returns Async iterable of reply text tokens for TTS synthesis.
   */
  sendText(text: string, metadata: unknown): AsyncIterable<string>;

  /**
   * Immediately cancels the in-flight LLM generation.
   *
   * Called by the orchestrator when the user barges in while the agent is
   * still producing audio. Implementations should abort any pending HTTP
   * requests to save tokens and reduce latency.
   */
  abort?(): void;
}

/**
 * Live session returned by {@link StreamingPipelineHandle.startSession}.
 *
 * Represents a single bidirectional voice conversation. The session
 * transitions through states (`'connecting'` -> `'listening'` ->
 * `'speaking'` -> `'listening'` -> ... -> `'closed'`).
 */
export interface StreamingPipelineSession {
  /** Unique identifier for this session, used in logs and telemetry. */
  readonly sessionId: string;
  /** Current lifecycle state (e.g. `'listening'`, `'speaking'`, `'closed'`). */
  readonly state: string;
  /** The transport this session is bound to. */
  readonly transport: StreamingPipelineTransport;
  /**
   * Gracefully closes the session, flushing any pending audio.
   *
   * @param reason - Optional human-readable close reason for logging.
   */
  close(reason?: string): Promise<void>;
}

/**
 * Streaming speech-to-text provider interface.
 *
 * Implementations must be able to create per-connection sessions that accept
 * raw audio chunks and emit transcript events.
 */
interface IStreamingSTT {
  /** Creates a new STT session bound to a single audio stream. */
  startSession(...args: unknown[]): Promise<unknown> | unknown;
}

/**
 * Streaming text-to-speech provider interface.
 *
 * Implementations must be able to create per-connection sessions that accept
 * text tokens and emit synthesized audio chunks.
 */
interface IStreamingTTS {
  /** Creates a new TTS session bound to a single output audio stream. */
  startSession(...args: unknown[]): Promise<unknown> | unknown;
}

/**
 * End-of-utterance detector that determines when the user has finished speaking.
 *
 * Implementations range from simple silence/energy-based VAD to LLM-assisted
 * semantic completeness checks.
 */
interface IEndpointDetector {}

/**
 * Speaker diarization engine that attributes audio segments to individual speakers.
 *
 * Only active when the `diarization` option is enabled; otherwise `undefined`.
 */
interface IDiarizationEngine {}

/**
 * Barge-in handler that decides what to do when the user interrupts the agent.
 *
 * Strategies include hard-cut (immediately stop TTS), soft-fade (duck volume
 * then stop), or disabled (ignore user speech during agent output).
 */
interface IBargeinHandler {}

/**
 * Resolved configuration snapshot passed to `VoicePipelineOrchestrator`.
 *
 * All optional user-facing fields from {@link StreamingPipelineOptions} have
 * been normalized and defaulted by the time this config is constructed.
 */
interface VoicePipelineConfig {
  /** Canonical STT provider identifier (e.g. `'whisper-chunked'`, `'deepgram'`). */
  stt: string;
  /** Canonical TTS provider identifier (e.g. `'openai'`, `'elevenlabs'`). */
  tts: string;
  /** Endpointing strategy. @defaultValue `'heuristic'` */
  endpointing?: 'acoustic' | 'heuristic' | 'semantic';
  /** Whether speaker diarization is active. @defaultValue `false` */
  diarization?: boolean;
  /** Barge-in handling strategy. @defaultValue `'hard-cut'` */
  bargeIn?: 'hard-cut' | 'soft-fade' | 'disabled';
  /** TTS voice name/ID. Provider-specific (e.g. `'nova'` for OpenAI). */
  voice?: string;
  /** Output audio encoding format for TTS. */
  format?: 'pcm' | 'mp3' | 'opus';
  /** BCP-47 language tag. @defaultValue `'en-US'` */
  language?: string;
  /** Provider-specific STT overrides forwarded verbatim. */
  sttOptions?: Record<string, unknown>;
  /** Provider-specific TTS overrides forwarded verbatim. */
  ttsOptions?: Record<string, unknown>;
}

/**
 * Options accepted by {@link createStreamingPipeline}.
 * All fields are optional; sensible defaults are applied for each.
 */
export interface StreamingPipelineOptions {
  /** Streaming speech-to-text provider ID (for example `'whisper-chunked'` or `'deepgram'`). */
  stt?: string;
  /** Streaming text-to-speech provider ID (for example `'openai'` or `'elevenlabs'`). */
  tts?: string;
  /**
   * Endpointing strategy for detecting end-of-utterance.
   * - `'acoustic'`  — energy/silence-based VAD
   * - `'heuristic'` — punctuation + pause length heuristics (default)
   * - `'semantic'`  — LLM-assisted intent completion check
   */
  endpointing?: 'acoustic' | 'heuristic' | 'semantic';
  /** Whether to enable speaker diarization. Default: `false`. */
  diarization?: boolean;
  /**
   * Barge-in strategy — how to handle the user speaking while the agent is
   * mid-response.
   */
  bargeIn?: 'hard-cut' | 'soft-fade' | 'disabled';
  /** Specific voice name/ID passed to the TTS provider. */
  voice?: string;
  /** Output audio format for TTS. */
  format?: 'pcm' | 'mp3' | 'opus';
  /** BCP-47 language tag for STT/TTS. Default: `'en-US'`. */
  language?: string;
  /** WebSocket port hint (informational; actual binding handled by ws-server). */
  port?: number;
  /** Provider-specific STT configuration forwarded into the pipeline config. */
  sttOptions?: Record<string, unknown>;
  /** Provider-specific TTS configuration forwarded into the pipeline config. */
  ttsOptions?: Record<string, unknown>;
  /** Optional LLM callback for semantic endpoint detection. */
  llmCall?: (prompt: string) => Promise<string>;
  /**
   * Optional manual component overrides for tests or advanced manual wiring.
   * When supplied, the corresponding curated extension pack will not be loaded.
   */
  overrides?: {
    streamingSTT?: IStreamingSTT;
    streamingTTS?: IStreamingTTS;
    endpointDetectorFactory?: () => IEndpointDetector;
    bargeinHandlerFactory?: () => IBargeinHandler;
    diarizationEngine?: IDiarizationEngine;
  };
}

/**
 * Handle returned by {@link createStreamingPipeline}.
 *
 * Each `startSession()` call creates a fresh `VoicePipelineOrchestrator` and
 * wires in the resolved STT/TTS/endpoint/barge-in providers.
 */
export interface StreamingPipelineHandle {
  readonly config: VoicePipelineConfig;
  startSession(
    transport: StreamingPipelineTransport,
    agentSession: StreamingPipelineAgentSession,
  ): Promise<StreamingPipelineSession>;
}

/** Factory function that creates a fresh endpoint detector per session. */
type EndpointFactory = () => IEndpointDetector;
/** Factory function that creates a fresh barge-in handler per session. */
type BargeinFactory = () => IBargeinHandler;

/**
 * Maps user-facing STT provider aliases to the canonical internal identifier.
 *
 * Common aliases like `'openai'`, `'whisper'`, `'openai-whisper'` all resolve
 * to `'whisper-chunked'` because the streaming STT extension uses chunked
 * Whisper transcription under the hood.
 *
 * @param providerId - Raw user-supplied provider string (may be undefined).
 * @returns Canonical STT provider identifier.
 */
function normalizeStreamingSttId(providerId: string | undefined): string {
  const normalized = providerId?.trim().toLowerCase() ?? '';
  // Default and common OpenAI aliases all map to chunked Whisper.
  if (!normalized || normalized === 'openai' || normalized === 'whisper' || normalized === 'openai-whisper') {
    return 'whisper-chunked';
  }
  if (normalized === 'deepgram-streaming') return 'deepgram';
  return normalized;
}

/**
 * Maps user-facing TTS provider aliases to the canonical internal identifier.
 *
 * @param providerId - Raw user-supplied provider string (may be undefined).
 * @returns Canonical TTS provider identifier.
 */
function normalizeStreamingTtsId(providerId: string | undefined): string {
  const normalized = providerId?.trim().toLowerCase() ?? '';
  // Default and verbose OpenAI aliases resolve to the short canonical name.
  if (!normalized || normalized === 'openai-tts' || normalized === 'openai-streaming-tts') {
    return 'openai';
  }
  if (normalized === 'elevenlabs-streaming-tts') return 'elevenlabs';
  return normalized;
}

/**
 * Reads a required environment variable or throws a descriptive error.
 *
 * @param name - Environment variable name (e.g. `'OPENAI_API_KEY'`).
 * @param hint - Human-readable setup instruction shown in the error message.
 * @returns The trimmed, non-empty value.
 * @throws {Error} When the variable is missing or empty.
 */
function requireEnv(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. ${hint}`);
  }
  return value;
}

/**
 * Dynamically imports and instantiates the streaming STT provider.
 *
 * Uses a computed string for the module specifier (`[...].join('')`) to
 * prevent bundlers from statically analyzing the import — the extension
 * pack may not be installed in all environments.
 *
 * @param options - Pipeline options containing the raw STT provider ID.
 * @returns An initialized streaming STT provider instance.
 * @throws {Error} If the required API key environment variable is missing.
 * @throws {Error} If the provider ID is not recognized.
 */
async function resolveStreamingStt(options: StreamingPipelineOptions): Promise<IStreamingSTT> {
  const providerId = normalizeStreamingSttId(options.stt);

  if (providerId === 'deepgram') {
    // Dynamic import prevents static analysis by bundlers — the extension
    // pack is optional and may not be installed in all deployments.
    const moduleId = ['@framers/agentos-ext-streaming-stt-deepgram'].join('');
    const { createDeepgramStreamingSTT } = await import(moduleId) as any;
    const apiKey = requireEnv(
      'DEEPGRAM_API_KEY',
      'Install/configure the Deepgram streaming STT pack and set DEEPGRAM_API_KEY.',
    );
    return createDeepgramStreamingSTT(apiKey);
  }

  if (providerId === 'whisper-chunked') {
    const moduleId = ['@framers/agentos-ext-streaming-stt-whisper'].join('');
    const { createWhisperChunkedSTT } = await import(moduleId) as any;
    const apiKey = requireEnv(
      'OPENAI_API_KEY',
      'Install/configure the Whisper chunked STT pack and set OPENAI_API_KEY.',
    );
    return createWhisperChunkedSTT(apiKey, process.env['OPENAI_BASE_URL']);
  }

  throw new Error(
    `Unsupported streaming STT provider "${options.stt ?? providerId}". Supported providers: whisper-chunked, deepgram.`,
  );
}

/**
 * Dynamically imports and instantiates the streaming TTS provider.
 *
 * @param options - Pipeline options containing the raw TTS provider ID and
 *   optional voice/format/ttsOptions overrides.
 * @returns An initialized streaming TTS provider instance.
 * @throws {Error} If the required API key environment variable is missing.
 * @throws {Error} If the provider ID is not recognized.
 */
async function resolveStreamingTts(options: StreamingPipelineOptions): Promise<IStreamingTTS> {
  const providerId = normalizeStreamingTtsId(options.tts);

  if (providerId === 'openai') {
    const moduleId = ['@framers/agentos-ext-streaming-tts-openai'].join('');
    const { createOpenAIStreamingTTS } = await import(moduleId) as any;
    const apiKey = requireEnv(
      'OPENAI_API_KEY',
      'Install/configure the OpenAI streaming TTS pack and set OPENAI_API_KEY.',
    );
    return createOpenAIStreamingTTS(apiKey, {
      voice: options.voice,
      format: options.format,
      baseUrl: process.env['OPENAI_BASE_URL'],
      ...(options.ttsOptions ?? {}),
    });
  }

  if (providerId === 'elevenlabs') {
    const moduleId = ['@framers/agentos-ext-streaming-tts-elevenlabs'].join('');
    const { createElevenLabsStreamingTTS } = await import(moduleId) as any;
    const apiKey = requireEnv(
      'ELEVENLABS_API_KEY',
      'Install/configure the ElevenLabs streaming TTS pack and set ELEVENLABS_API_KEY.',
    );
    return createElevenLabsStreamingTTS(apiKey, {
      ...(options.voice ? { voiceId: options.voice } : null),
      ...(options.ttsOptions ?? {}),
    } as Record<string, unknown>);
  }

  throw new Error(
    `Unsupported streaming TTS provider "${options.tts ?? providerId}". Supported providers: openai, elevenlabs.`,
  );
}

/**
 * Resolves the endpoint detector factory for the configured strategy.
 *
 * Semantic endpointing requires an `llmCall` callback; if omitted the factory
 * logs a warning and falls back to heuristic detection. This graceful
 * degradation avoids runtime errors when the caller enables semantic mode
 * without providing the LLM integration.
 *
 * @param options - Pipeline options containing the endpointing strategy and
 *   optional `llmCall` callback for semantic detection.
 * @returns A zero-arg factory that produces a fresh detector per session.
 */
async function resolveEndpointFactory(options: StreamingPipelineOptions): Promise<EndpointFactory> {
  const voicePipelineModule = await import('@framers/agentos/voice-pipeline') as any;
  const { AcousticEndpointDetector, HeuristicEndpointDetector } = voicePipelineModule;

  switch (options.endpointing ?? 'heuristic') {
    case 'acoustic':
      return () => new AcousticEndpointDetector();
    case 'semantic':
      if (typeof options.llmCall === 'function') {
        const moduleId = ['@framers/agentos-ext-endpoint-semantic'].join('');
        const { createSemanticEndpointDetector } = await import(moduleId) as any;
        return () => createSemanticEndpointDetector(options.llmCall!);
      }
      // Graceful degradation: semantic endpointing without an LLM callback is
      // a configuration error, but we prefer to continue with heuristic mode
      // rather than crash the voice pipeline at startup.
      console.warn('[wunderland/voice] semantic endpointing requested without llmCall; falling back to heuristic endpointing.');
      return () => new HeuristicEndpointDetector();
    case 'heuristic':
    default:
      return () => new HeuristicEndpointDetector();
  }
}

/**
 * Resolves the barge-in handler factory for the configured strategy.
 *
 * The `'disabled'` strategy returns a no-op handler that always ignores
 * barge-in events — useful for non-interactive playback or IVR menus where
 * interrupting the agent is undesirable.
 *
 * @param options - Pipeline options containing the barge-in strategy.
 * @returns A zero-arg factory that produces a fresh handler per session.
 */
async function resolveBargeinFactory(options: StreamingPipelineOptions): Promise<BargeinFactory> {
  const voicePipelineModule = await import('@framers/agentos/voice-pipeline') as any;
  const { HardCutBargeinHandler, SoftFadeBargeinHandler } = voicePipelineModule;

  switch (options.bargeIn ?? 'hard-cut') {
    case 'soft-fade':
      return () => new SoftFadeBargeinHandler();
    case 'disabled':
      // No-op handler: reports `hard-cut` mode to satisfy the interface
      // contract, but always returns `'ignore'` so the pipeline never
      // interrupts TTS playback.
      return () => ({
        mode: 'hard-cut',
        handleBargein: () => ({ type: 'ignore' }),
      });
    case 'hard-cut':
    default:
      return () => new HardCutBargeinHandler();
  }
}

/**
 * Optionally loads the speaker diarization engine.
 *
 * Returns `undefined` when diarization is not requested, allowing the
 * orchestrator to skip the diarization phase entirely.
 *
 * @param enabled - Whether the user requested diarization.
 * @returns The diarization engine instance, or `undefined` if disabled.
 */
async function resolveDiarizationEngine(enabled: boolean | undefined): Promise<IDiarizationEngine | undefined> {
  if (!enabled) return undefined;
  const moduleId = ['@framers/agentos-ext-diarization'].join('');
  const { createDiarizationEngine } = await import(moduleId) as any;
  return createDiarizationEngine();
}

/**
 * Creates and returns a configured streaming pipeline handle.
 *
 * The handle is safe to reuse across multiple inbound sessions because it
 * constructs a fresh orchestrator per call to `startSession()`.
 *
 * All five provider dependencies (STT, TTS, endpointing, barge-in,
 * diarization) are resolved concurrently via `Promise.all` during this
 * factory call. If any required environment variable is missing or an
 * extension pack is not installed, the factory throws immediately rather
 * than deferring the error to the first session.
 *
 * @param options - User-facing pipeline configuration. All fields are
 *   optional; sensible defaults are applied (whisper-chunked STT, OpenAI TTS,
 *   heuristic endpointing, hard-cut barge-in, no diarization, en-US).
 * @returns A reusable handle whose `startSession()` creates isolated voice
 *   sessions.
 * @throws {Error} If a required API key is missing or a provider ID is
 *   unrecognized.
 *
 * @example
 * ```ts
 * // Minimal: defaults to whisper-chunked STT + OpenAI TTS
 * const handle = await createStreamingPipeline({});
 *
 * // With overrides
 * const handle = await createStreamingPipeline({
 *   stt: 'deepgram',
 *   tts: 'elevenlabs',
 *   voice: 'rachel',
 *   endpointing: 'acoustic',
 *   bargeIn: 'soft-fade',
 *   diarization: true,
 * });
 *
 * // Start a session
 * const session = await handle.startSession(transport, agentSession);
 * ```
 *
 * @see {@link StreamingPipelineHandle} for the returned handle API.
 * @see {@link StreamingPipelineOptions} for all configurable fields.
 */
export async function createStreamingPipeline(
  options: StreamingPipelineOptions,
): Promise<StreamingPipelineHandle> {
  const voicePipelineModule = await import('@framers/agentos/voice-pipeline') as any;
  const { VoicePipelineOrchestrator } = voicePipelineModule;

  const config: VoicePipelineConfig = {
    stt: normalizeStreamingSttId(options.stt),
    tts: normalizeStreamingTtsId(options.tts),
    endpointing: options.endpointing ?? 'heuristic',
    diarization: options.diarization ?? false,
    bargeIn: options.bargeIn ?? 'hard-cut',
    voice: options.voice,
    format: options.format,
    language: options.language ?? 'en-US',
    sttOptions: options.sttOptions,
    ttsOptions: options.ttsOptions,
  };

  const [streamingSTT, streamingTTS, createEndpointDetector, createBargeinHandler, diarizationEngine] = await Promise.all([
    options.overrides?.streamingSTT ? Promise.resolve(options.overrides.streamingSTT) : resolveStreamingStt(options),
    options.overrides?.streamingTTS ? Promise.resolve(options.overrides.streamingTTS) : resolveStreamingTts(options),
    options.overrides?.endpointDetectorFactory ? Promise.resolve(options.overrides.endpointDetectorFactory) : resolveEndpointFactory(options),
    options.overrides?.bargeinHandlerFactory ? Promise.resolve(options.overrides.bargeinHandlerFactory) : resolveBargeinFactory(options),
    options.overrides?.diarizationEngine !== undefined
      ? Promise.resolve(options.overrides.diarizationEngine)
      : resolveDiarizationEngine(options.diarization),
  ]);

  return {
    config,
    async startSession(transport, agentSession) {
      const orchestrator = new VoicePipelineOrchestrator(config);
      return orchestrator.startSession(transport, agentSession, {
        streamingSTT,
        streamingTTS,
        endpointDetector: createEndpointDetector(),
        bargeinHandler: createBargeinHandler(),
        diarizationEngine,
      });
    },
  };
}
