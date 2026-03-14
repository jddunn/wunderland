/**
 * @fileoverview Voice and speech client wrapper for Wunderland.
 * Re-exports telephony call primitives plus the consolidated speech runtime from AgentOS.
 * @module wunderland/voice/call-client
 */

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
} from '@framers/agentos';

export type {
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
} from '@framers/agentos/speech';

export {
  CallManager,
  convertPcmToMulaw8k,
  convertMulawToPcm16,
  escapeXml,
  validateE164,
} from '@framers/agentos';

export {
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
} from '@framers/agentos/speech';
