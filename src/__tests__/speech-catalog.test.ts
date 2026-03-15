import { describe, expect, it } from 'vitest';

import {
  createSpeechExtensionEnvOverrides,
  getPreferredRuntimeTtsProviderId,
  normalizePreferredSpeechProviderId,
} from '../voice/speech-catalog.js';

describe('speech-catalog', () => {
  it('normalizes provider aliases to runtime provider ids', () => {
    expect(normalizePreferredSpeechProviderId('tts', 'openai')).toBe('openai-tts');
    expect(normalizePreferredSpeechProviderId('stt', 'openai')).toBe('openai-whisper');
    expect(normalizePreferredSpeechProviderId('stt', 'deepgram')).toBe('deepgram');
  });

  it('applies configured provider defaults to speech-runtime overrides', () => {
    const overrides = createSpeechExtensionEnvOverrides({
      providerDefaults: {
        tts: 'elevenlabs',
        stt: 'deepgram',
      },
    });

    expect(overrides['speech-runtime']?.options).toMatchObject({
      preferredTtsProviderId: 'elevenlabs',
      preferredSttProviderId: 'deepgram',
    });
  });

  it('honors preferred TTS provider before env fallback order', () => {
    expect(
      getPreferredRuntimeTtsProviderId(
        {
          OPENAI_API_KEY: 'sk-openai',
          ELEVENLABS_API_KEY: 'sk-elevenlabs',
        },
        'elevenlabs',
      ),
    ).toBe('elevenlabs');
  });
});
