/**
 * @fileoverview ElevenLabs TTS Tool — backward-compat re-export from agentos-extensions.
 * @deprecated Use TextToSpeechTool from ToolRegistry or agentos-extensions directly.
 */

export { TextToSpeechTool as ElevenLabsTool } from '../../../agentos-extensions/registry/curated/media/voice-synthesis/src/tools/textToSpeech.js';
export type { TTSInput as ElevenLabsTTSInput, TTSOutput as ElevenLabsTTSResult } from '../../../agentos-extensions/registry/curated/media/voice-synthesis/src/tools/textToSpeech.js';
