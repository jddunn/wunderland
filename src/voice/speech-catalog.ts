import {
  findSpeechProviderCatalogEntry,
  getSpeechProviderCatalog,
  type SpeechProviderCatalogEntry,
  type SpeechProviderKind,
} from '@framers/agentos/speech';

export const DEFAULT_VOICE_EXTENSIONS = ['speech-runtime', 'voice-synthesis'] as const;
export type SpeechProviderDefaults = {
  tts?: string;
  stt?: string;
};

const TTS_PROVIDER_ALIASES: Record<string, string> = {
  openai: 'openai-tts',
  'openai-tts': 'openai-tts',
  elevenlabs: 'elevenlabs',
};

const STT_PROVIDER_ALIASES: Record<string, string> = {
  openai: 'openai-whisper',
  'openai-whisper': 'openai-whisper',
  deepgram: 'deepgram',
  'whisper-local': 'whisper-local',
};

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

export function normalizePreferredSpeechProviderId(
  kind: 'tts' | 'stt',
  providerId: string | undefined,
): string | undefined {
  if (typeof providerId !== 'string') return undefined;
  const normalized = providerId.trim().toLowerCase();
  if (!normalized) return undefined;
  return kind === 'tts'
    ? (TTS_PROVIDER_ALIASES[normalized] ?? normalized)
    : (STT_PROVIDER_ALIASES[normalized] ?? normalized);
}

export function createSpeechExtensionEnvOverrides(opts: {
  env?: Record<string, string | undefined>;
  providerDefaults?: SpeechProviderDefaults;
} = {}): Record<string, { options: Record<string, string | undefined> }> {
  const env = opts.env ?? process.env;
  const preferredTtsProvider = opts.providerDefaults?.tts?.trim().toLowerCase();
  const preferredSttProvider = opts.providerDefaults?.stt?.trim().toLowerCase();

  return {
    'speech-runtime': {
      options: {
        openAIWhisperModel: env['WHISPER_MODEL_DEFAULT'],
        openAITtsModel: env['OPENAI_TTS_DEFAULT_MODEL'],
        openAITtsVoice: env['OPENAI_TTS_DEFAULT_VOICE'],
        elevenLabsModel: env['ELEVENLABS_TTS_MODEL'],
        elevenLabsVoiceId: env['ELEVENLABS_VOICE_ID'],
        preferredTtsProviderId: normalizePreferredSpeechProviderId('tts', opts.providerDefaults?.tts),
        preferredSttProviderId: normalizePreferredSpeechProviderId('stt', opts.providerDefaults?.stt),
      },
    },
    'voice-synthesis': {
      options: {
        openaiApiKey: env['OPENAI_API_KEY'],
        openaiBaseUrl: env['OPENAI_BASE_URL'],
        elevenLabsApiKey: env['ELEVENLABS_API_KEY'],
        deepgramApiKey: env['DEEPGRAM_API_KEY'],
        deepgramBaseUrl: env['DEEPGRAM_BASE_URL'],
        whisperLocalBaseUrl: env['WHISPER_LOCAL_BASE_URL'],
        defaultProvider:
          preferredTtsProvider === 'openai-tts' ? 'openai'
            : preferredTtsProvider === 'elevenlabs' ? 'elevenlabs'
              : preferredTtsProvider,
        defaultSttProvider:
          preferredSttProvider === 'openai-whisper' ? 'openai' : preferredSttProvider,
      },
    },
  };
}

export function getPreferredRuntimeTtsProviderId(
  env: Record<string, string | undefined> = process.env,
  preferredProviderId?: string,
): string | undefined {
  const preferred = normalizePreferredSpeechProviderId('tts', preferredProviderId);
  if (preferred) {
    const provider = findSpeechProviderCatalogEntry(preferred);
    if (provider && isSpeechProviderConfigured(provider, env)) {
      return preferred;
    }
  }
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
