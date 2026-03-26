/**
 * @fileoverview Tests for the streaming pipeline factory (`createStreamingPipeline`).
 *
 * These tests validate the "pipeline handle" pattern:
 * - The factory resolves provider dependencies once.
 * - Each `startSession()` call creates a fresh `VoicePipelineOrchestrator`
 *   with new endpoint detector and barge-in handler instances (via factories),
 *   while sharing the same STT/TTS provider instances.
 * - Graceful fallback when semantic endpointing is requested without an LLM callback.
 *
 * All AgentOS voice-pipeline dependencies are mocked via `vi.mock()` to avoid
 * requiring the actual extension packs to be installed during unit testing.
 *
 * @module wunderland/__tests__/streaming-pipeline
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock for `VoicePipelineOrchestrator.startSession()`.
 * Captures call arguments so tests can inspect which overrides were passed.
 */
const startSessionMock = vi.fn(async (transport: unknown, _agentSession: unknown, overrides: unknown) => ({
  sessionId: 'voice-session',
  state: 'listening',
  transport,
  overrides,
  close: vi.fn(),
}));

/**
 * Mock constructor for `VoicePipelineOrchestrator`.
 * Tracks how many times the orchestrator was instantiated (should be once per
 * `startSession()` call to ensure session isolation).
 */
const VoicePipelineOrchestrator = vi.fn(function MockVoicePipelineOrchestrator(this: any, config: unknown) {
  this.config = config;
  this.startSession = startSessionMock;
});

/** Stub: heuristic endpoint detector (default strategy). */
class MockHeuristicEndpointDetector {
  readonly mode = 'heuristic';
}

/** Stub: acoustic (energy/silence-based VAD) endpoint detector. */
class MockAcousticEndpointDetector {
  readonly mode = 'acoustic';
}

/** Stub: hard-cut barge-in handler (immediately stop TTS). */
class MockHardCutBargeinHandler {
  readonly mode = 'hard-cut' as const;
  handleBargein() {
    return { type: 'cancel' as const };
  }
}

/** Stub: soft-fade barge-in handler (duck audio then stop). */
class MockSoftFadeBargeinHandler {
  readonly mode = 'soft-fade' as const;
  handleBargein() {
    return { type: 'pause' as const };
  }
}

// Replace the real voice-pipeline module with lightweight stubs.
vi.mock('@framers/agentos/voice-pipeline', () => ({
  VoicePipelineOrchestrator,
  HeuristicEndpointDetector: MockHeuristicEndpointDetector,
  AcousticEndpointDetector: MockAcousticEndpointDetector,
  HardCutBargeinHandler: MockHardCutBargeinHandler,
  SoftFadeBargeinHandler: MockSoftFadeBargeinHandler,
}));

import { createStreamingPipeline } from '../voice/streaming-pipeline.js';

describe('createStreamingPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_BASE_URL'];
  });

  it('creates a reusable handle that instantiates a fresh orchestrator per session', async () => {
    const pipeline = await createStreamingPipeline({
      stt: 'whisper-chunked',
      tts: 'openai',
      diarization: true,
      voice: 'nova',
      format: 'opus',
      overrides: {
        streamingSTT: { providerId: 'whisper-chunked' } as any,
        streamingTTS: { providerId: 'openai-streaming-tts' } as any,
        diarizationEngine: { providerId: 'diarization-local' } as any,
      },
    });

    const transport = { id: 'transport-1' } as any;
    const agentSession = { sendText: async function* () { yield 'hello '; } } as any;

    await pipeline.startSession(transport, agentSession);
    await pipeline.startSession(transport, agentSession);

    expect(VoicePipelineOrchestrator).toHaveBeenCalledTimes(2);
    const firstOverrides = startSessionMock.mock.calls[0]?.[2] as Record<string, unknown>;
    const secondOverrides = startSessionMock.mock.calls[1]?.[2] as Record<string, unknown>;

    expect(firstOverrides['streamingSTT']).toEqual({ providerId: 'whisper-chunked' });
    expect(firstOverrides['streamingTTS']).toEqual({ providerId: 'openai-streaming-tts' });
    expect(firstOverrides['endpointDetector']).toBeInstanceOf(MockHeuristicEndpointDetector);
    // Use structural matching for the barge-in handler instead of instanceof,
    // because `resolveBargeinFactory` captures the class from a separate
    // dynamic `import()` call — vitest resolves these to the same mock module,
    // but the class reference equality check that `toBeInstanceOf` relies on
    // can fail when the import is evaluated in a different module scope.
    expect(firstOverrides['bargeinHandler']).toEqual(
      expect.objectContaining({ mode: 'hard-cut' }),
    );
    expect(typeof (firstOverrides['bargeinHandler'] as any).handleBargein).toBe('function');
    expect(firstOverrides['diarizationEngine']).toEqual({ providerId: 'diarization-local' });
    expect(secondOverrides['endpointDetector']).toBeInstanceOf(MockHeuristicEndpointDetector);
    expect(secondOverrides['endpointDetector']).not.toBe(firstOverrides['endpointDetector']);
  });

  it('falls back to heuristic endpointing when semantic mode has no llmCall', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pipeline = await createStreamingPipeline({
      stt: 'whisper-chunked',
      tts: 'openai',
      endpointing: 'semantic',
      overrides: {
        streamingSTT: { providerId: 'whisper-chunked' } as any,
        streamingTTS: { providerId: 'openai-streaming-tts' } as any,
      },
    });

    await pipeline.startSession({ id: 'transport-2' } as any, {
      sendText: async function* () {
        yield 'ok ';
      },
    } as any);

    const overrides = startSessionMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('semantic endpointing requested without llmCall'),
    );
    expect(overrides['endpointDetector']).toBeInstanceOf(MockHeuristicEndpointDetector);
  });
});
