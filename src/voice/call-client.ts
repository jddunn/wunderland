/**
 * @fileoverview Voice call client wrapper for Wunderland.
 * Re-exports voice call primitives from AgentOS.
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

export {
  CallManager,
  convertPcmToMulaw8k,
  convertMulawToPcm16,
  escapeXml,
  validateE164,
} from '@framers/agentos';
