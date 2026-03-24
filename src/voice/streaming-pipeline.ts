/**
 * @fileoverview Factory that creates a fully-wired VoicePipelineOrchestrator from
 * Wunderland CLI config. Wraps the dynamic import of the AgentOS voice-pipeline
 * module so the rest of the CLI does not hard-depend on it at load time.
 *
 * @module wunderland/voice/streaming-pipeline
 */

// ── Option types ─────────────────────────────────────────────────────────────

/**
 * Options accepted by {@link createStreamingPipeline}.
 * All fields are optional; sensible defaults are applied for each.
 */
export interface StreamingPipelineOptions {
  /** Speech-to-text provider ID (e.g. `'whisper-chunked'`, `'deepgram'`). */
  stt?: string;
  /** Text-to-speech provider ID (e.g. `'openai'`, `'elevenlabs'`). */
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
   * - `'hard-cut'`  — immediately stop synthesis (default)
   * - `'soft-fade'` — fade out over ~300 ms
   * - `'disabled'`  — ignore user speech until synthesis finishes
   */
  bargeIn?: 'hard-cut' | 'soft-fade' | 'disabled';
  /** Specific voice name/ID passed to the TTS provider. */
  voice?: string;
  /** BCP-47 language tag for STT (e.g. `'en-US'`). Default: `'en-US'`. */
  language?: string;
  /** WebSocket port hint (informational; actual binding handled by ws-server). */
  port?: number;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates and returns a configured `VoicePipelineOrchestrator` instance.
 *
 * The import of `@framers/agentos/voice-pipeline` is deferred so that the CLI
 * remains functional on installations where the voice-pipeline package is not
 * present.
 *
 * @param options - {@link StreamingPipelineOptions} controlling provider selection
 *   and runtime behaviour.
 * @returns A `VoicePipelineOrchestrator` ready to accept sessions.
 * @throws If `@framers/agentos/voice-pipeline` cannot be resolved.
 */
export async function createStreamingPipeline(
  options: StreamingPipelineOptions,
): Promise<any> {
  // Dynamic import keeps voice-pipeline optional at the module level.
  const { VoicePipelineOrchestrator } = await import('@framers/agentos/voice-pipeline');

  const config = {
    stt: options.stt ?? 'whisper-chunked',
    tts: options.tts ?? 'openai',
    endpointing: options.endpointing ?? 'heuristic',
    diarization: options.diarization ?? false,
    bargeIn: options.bargeIn ?? 'hard-cut',
    voice: options.voice,
    language: options.language ?? 'en-US',
  };

  return new VoicePipelineOrchestrator(config);
}
