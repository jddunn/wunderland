/**
 * @fileoverview Voice and speech subsystem barrel exports.
 *
 * Re-exports the speech provider catalog utilities (TTS/STT provider lookup,
 * configuration helpers, environment overrides) and the telephony call-client
 * primitives (CallManager, codec conversion, SpeechRuntime).
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
export type { StreamingPipelineOptions } from './streaming-pipeline.js';

// ── WebSocket voice server ────────────────────────────────────────────────────
export { startVoiceServer } from './ws-server.js';
export type { VoiceServerOptions, VoiceServerHandle } from './ws-server.js';

// ── Telephony webhook server ──────────────────────────────────────────────────
export { startTelephonyWebhookServer } from './telephony-webhook-server.js';
export type { TelephonyWebhookServerOptions } from './telephony-webhook-server.js';

export type {
  IVoiceCallProvider,
  InitiateCallInput,
  InitiateCallResult,
  HangupCallInput,
  PlayTtsInput,
  StartListeningInput,
  StopListeningInput,
  CallManagerEventType,
  CallManagerEvent,
  CallManagerEventHandler,
  SpeechAudioInput,
  SpeechProviderCatalogEntry,
  SpeechProviderKind,
  SpeechRuntimeConfig,
  SpeechRuntimeSessionConfig,
  SpeechSessionConfig,
  SpeechSessionState,
  SpeechSynthesisOptions,
  SpeechSynthesisResult,
  SpeechToTextProvider,
  SpeechTranscriptionOptions,
  SpeechTranscriptionResult,
  SpeechVadProvider,
  TextToSpeechProvider,
  WakeWordProvider,
} from './call-client.js';
