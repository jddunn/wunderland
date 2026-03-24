import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startSessionMock = vi.fn(async (transport: unknown, _agentSession: unknown, overrides: unknown) => ({
  sessionId: 'voice-session',
  state: 'listening',
  transport,
  overrides,
  close: vi.fn(),
}));

const VoicePipelineOrchestrator = vi.fn(function MockVoicePipelineOrchestrator(this: any, config: unknown) {
  this.config = config;
  this.startSession = startSessionMock;
});

class MockHeuristicEndpointDetector {
  readonly mode = 'heuristic';
}

class MockAcousticEndpointDetector {
  readonly mode = 'acoustic';
}

class MockHardCutBargeinHandler {
  readonly mode = 'hard-cut' as const;
  handleBargein() {
    return { type: 'cancel' as const };
  }
}

class MockSoftFadeBargeinHandler {
  readonly mode = 'soft-fade' as const;
  handleBargein() {
    return { type: 'pause' as const };
  }
}

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
    expect(firstOverrides['bargeinHandler']).toBeInstanceOf(MockHardCutBargeinHandler);
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
