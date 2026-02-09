/**
 * @fileoverview ElevenLabs TTS Tool — backward-compat re-export from agentos-extensions.
 * @deprecated Use TextToSpeechTool from ToolRegistry or agentos-extensions directly.
 */

export { TextToSpeechTool as ElevenLabsTool } from '@framers/agentos-ext-voice-synthesis';
export type { TTSInput as ElevenLabsTTSInput, TTSOutput as ElevenLabsTTSResult } from '@framers/agentos-ext-voice-synthesis';
