/**
 * @fileoverview Factory that creates a prewired streaming voice pipeline handle
 * for Wunderland CLI and library consumers.
 *
 * The returned handle creates a fresh `VoicePipelineOrchestrator` per session so
 * concurrent WebSocket connections do not share state. Streaming STT/TTS
 * providers are loaded lazily from the curated AgentOS voice extension packs.
 *
 * @module wunderland/voice/streaming-pipeline
 */

export interface StreamingPipelineTransport {
  readonly id: string;
}

export interface StreamingPipelineAgentSession {
  sendText(text: string, metadata: unknown): AsyncIterable<string>;
  abort?(): void;
}

export interface StreamingPipelineSession {
  readonly sessionId: string;
  readonly state: string;
  readonly transport: StreamingPipelineTransport;
  close(reason?: string): Promise<void>;
}

interface IStreamingSTT {
  startSession(...args: unknown[]): Promise<unknown> | unknown;
}

interface IStreamingTTS {
  startSession(...args: unknown[]): Promise<unknown> | unknown;
}

interface IEndpointDetector {}
interface IDiarizationEngine {}
interface IBargeinHandler {}

interface VoicePipelineConfig {
  stt: string;
  tts: string;
  endpointing?: 'acoustic' | 'heuristic' | 'semantic';
  diarization?: boolean;
  bargeIn?: 'hard-cut' | 'soft-fade' | 'disabled';
  voice?: string;
  format?: 'pcm' | 'mp3' | 'opus';
  language?: string;
  sttOptions?: Record<string, unknown>;
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

type EndpointFactory = () => IEndpointDetector;
type BargeinFactory = () => IBargeinHandler;

function normalizeStreamingSttId(providerId: string | undefined): string {
  const normalized = providerId?.trim().toLowerCase() ?? '';
  if (!normalized || normalized === 'openai' || normalized === 'whisper' || normalized === 'openai-whisper') {
    return 'whisper-chunked';
  }
  if (normalized === 'deepgram-streaming') return 'deepgram';
  return normalized;
}

function normalizeStreamingTtsId(providerId: string | undefined): string {
  const normalized = providerId?.trim().toLowerCase() ?? '';
  if (!normalized || normalized === 'openai-tts' || normalized === 'openai-streaming-tts') {
    return 'openai';
  }
  if (normalized === 'elevenlabs-streaming-tts') return 'elevenlabs';
  return normalized;
}

function requireEnv(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. ${hint}`);
  }
  return value;
}

async function resolveStreamingStt(options: StreamingPipelineOptions): Promise<IStreamingSTT> {
  const providerId = normalizeStreamingSttId(options.stt);

  if (providerId === 'deepgram') {
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
      console.warn('[wunderland/voice] semantic endpointing requested without llmCall; falling back to heuristic endpointing.');
      return () => new HeuristicEndpointDetector();
    case 'heuristic':
    default:
      return () => new HeuristicEndpointDetector();
  }
}

async function resolveBargeinFactory(options: StreamingPipelineOptions): Promise<BargeinFactory> {
  const voicePipelineModule = await import('@framers/agentos/voice-pipeline') as any;
  const { HardCutBargeinHandler, SoftFadeBargeinHandler } = voicePipelineModule;

  switch (options.bargeIn ?? 'hard-cut') {
    case 'soft-fade':
      return () => new SoftFadeBargeinHandler();
    case 'disabled':
      return () => ({
        mode: 'hard-cut',
        handleBargein: () => ({ type: 'ignore' }),
      });
    case 'hard-cut':
    default:
      return () => new HardCutBargeinHandler();
  }
}

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
