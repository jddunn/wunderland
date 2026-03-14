import {
  findSpeechProviderCatalogEntry,
  getSpeechProviderCatalog,
  type SpeechProviderCatalogEntry,
  type SpeechProviderKind,
} from '@framers/agentos/speech';

export const DEFAULT_VOICE_EXTENSIONS = ['speech-runtime', 'voice-synthesis'] as const;

export function getDefaultVoiceExtensions(): string[] {
  return [...DEFAULT_VOICE_EXTENSIONS];
}

export function getSpeechProviders(kind: SpeechProviderKind): SpeechProviderCatalogEntry[] {
  return getSpeechProviderCatalog(kind);
}

export function getSpeechProviderEntry(id: string): SpeechProviderCatalogEntry {
  const entry = findSpeechProviderCatalogEntry(id);
  if (!entry) {
    throw new Error(`Unknown speech provider catalog entry: ${id}`);
  }
  return entry;
}

export function isSpeechProviderConfigured(
  provider: Pick<SpeechProviderCatalogEntry, 'envVars' | 'local'>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return provider.local || provider.envVars.every((envVar) => Boolean(env[envVar] || process.env[envVar]));
}

export function createSpeechExtensionEnvOverrides(): Record<string, { options: Record<string, string | undefined> }> {
  return {
    'speech-runtime': {
      options: {
        openAIWhisperModel: process.env['WHISPER_MODEL_DEFAULT'],
        openAITtsModel: process.env['OPENAI_TTS_DEFAULT_MODEL'],
        openAITtsVoice: process.env['OPENAI_TTS_DEFAULT_VOICE'],
        elevenLabsModel: process.env['ELEVENLABS_TTS_MODEL'],
        elevenLabsVoiceId: process.env['ELEVENLABS_VOICE_ID'],
      },
    },
    'voice-synthesis': {
      options: {
        elevenLabsApiKey: process.env['ELEVENLABS_API_KEY'],
      },
    },
  };
}

export function getPreferredRuntimeTtsProviderId(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env['OPENAI_API_KEY']) return 'openai-tts';
  if (env['ELEVENLABS_API_KEY']) return 'elevenlabs';
  return undefined;
}

export function fileExtensionForSpeechMimeType(mimeType: string | undefined): string {
  switch (mimeType) {
    case 'audio/wav':
      return 'wav';
    case 'audio/flac':
      return 'flac';
    case 'audio/opus':
      return 'opus';
    case 'audio/aac':
      return 'aac';
    case 'audio/L16':
      return 'pcm';
    default:
      return 'mp3';
  }
}
