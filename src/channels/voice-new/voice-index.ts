// @ts-nocheck
/**
 * @fileoverview Voice and speech subsystem barrel exports.
 *
 * This barrel aggregates four sub-modules that together form the Wunderland
 * voice subsystem:
 *
 * ## Speech catalog (`speech-catalog.ts`)
 * TTS/STT provider lookup, configuration helpers, and environment variable
 * overrides. Used by both the CLI and programmatic API to resolve which
 * speech providers are available and configured.
 *
 * ## Call client (`call-client.ts`)
 * Telephony call management primitives: `CallManager` for orchestrating
 * inbound/outbound calls, codec conversion utilities (PCM/mu-law), and
 * the `SpeechRuntime`/`SpeechSession` abstractions for single-shot (non-
 * streaming) TTS/STT.
 *
 * ## Streaming pipeline (`streaming-pipeline.ts`)
 * Factory for creating reusable pipeline handles that wire streaming STT,
 * TTS, endpointing, barge-in, and diarization into the AgentOS
 * `VoicePipelineOrchestrator`.
 *
 * ## Servers (`ws-server.ts`, `telephony-webhook-server.ts`)
 * WebSocket server for browser and telephony media-stream connections, and
 * an HTTP webhook server for receiving inbound call events from Twilio,
 * Telnyx, and Plivo.
 *
 * @module wunderland/voice
 */

// ── Speech catalog (TTS/STT provider utilities) ───────────────────────────
export {
  DEFAULT_VOICE_EXTENSIONS,
  getDefaultVoiceExtensions,
  getSpeechProviders,
  getSpeechProviderEntry,
  isSpeechProviderConfigured,
  normalizePreferredSpeechProviderId,
  createSpeechExtensionEnvOverrides,
  getPreferredRuntimeTtsProviderId,
  fileExtensionForSpeechMimeType,
} from './speech-catalog.js';
export type { SpeechProviderDefaults } from './speech-catalog.js';

// ── Call client (telephony + speech runtime re-exports) ───────────────────
export {
  CallManager,
  convertPcmToMulaw8k,
  convertMulawToPcm16,
  escapeXml,
  validateE164,
  BuiltInAdaptiveVadProvider,
  ElevenLabsTextToSpeechProvider,
  OpenAITextToSpeechProvider,
  OpenAIWhisperSpeechToTextProvider,
  SpeechProviderRegistry,
  SpeechRuntime,
  SpeechSession,
  createSpeechRuntime,
  createSpeechRuntimeFromEnv,
  findSpeechProviderCatalogEntry,
  getDefaultSpeechProviderId,
  getSpeechProviderCatalog,
  getSpeechProviderKinds,
} from './call-client.js';

// ── Streaming pipeline (voice-pipeline orchestrator factory) ─────────────────
export { createStreamingPipeline } from './streaming-pipeline.js';
export type { StreamingPipelineOptions, StreamingPipelineHandle } from './streaming-pipeline.js';

// ── WebSocket voice server ────────────────────────────────────────────────────
export { startVoiceServer } from './ws-server.js';
export type { VoiceServerOptions, VoiceServerHandle } from './ws-server.js';

// ── Telephony webhook server ──────────────────────────────────────────────────
export { startTelephonyWebhookServer } from './telephony-webhook-server.js';
export type { TelephonyWebhookServerOptions } from './telephony-webhook-server.js';

// ── Call client type re-exports ───────────────────────────────────────────────
export type {
  /** Provider interface for initiating/managing telephony calls. */
  IVoiceCallProvider,
  /** Input for {@link IVoiceCallProvider.initiateCall}. */
  InitiateCallInput,
  /** Result of {@link IVoiceCallProvider.initiateCall}. */
  InitiateCallResult,
  /** Input for {@link IVoiceCallProvider.hangup}. */
  HangupCallInput,
  /** Input for {@link IVoiceCallProvider.playTts}. */
  PlayTtsInput,
  /** Input for {@link IVoiceCallProvider.startListening}. */
  StartListeningInput,
  /** Input for {@link IVoiceCallProvider.stopListening}. */
  StopListeningInput,
  /** Union of call manager event type strings. */
  CallManagerEventType,
  /** Discriminated event object emitted by {@link CallManager}. */
  CallManagerEvent,
  /** Handler callback type for {@link CallManager} events. */
  CallManagerEventHandler,
  /** Raw audio input descriptor for speech processing. */
  SpeechAudioInput,
  /** Static metadata entry for a speech provider in the catalog. */
  SpeechProviderCatalogEntry,
  /** Discriminated union: `'tts'` | `'stt'` | `'vad'` | `'wake-word'`. */
  SpeechProviderKind,
  /** Top-level configuration for {@link SpeechRuntime}. */
  SpeechRuntimeConfig,
  /** Per-session configuration within a {@link SpeechRuntime}. */
  SpeechRuntimeSessionConfig,
  /** Configuration for an individual {@link SpeechSession}. */
  SpeechSessionConfig,
  /** Lifecycle state of a {@link SpeechSession}. */
  SpeechSessionState,
  /** Options for a text-to-speech synthesis request. */
  SpeechSynthesisOptions,
  /** Result of a text-to-speech synthesis request. */
  SpeechSynthesisResult,
  /** Provider interface for speech-to-text transcription. */
  SpeechToTextProvider,
  /** Options for a speech-to-text transcription request. */
  SpeechTranscriptionOptions,
  /** Result of a speech-to-text transcription request. */
  SpeechTranscriptionResult,
  /** Provider interface for voice activity detection. */
  SpeechVadProvider,
  /** Provider interface for text-to-speech synthesis. */
  TextToSpeechProvider,
  /** Provider interface for wake-word detection. */
  WakeWordProvider,
} from './call-client.js';
