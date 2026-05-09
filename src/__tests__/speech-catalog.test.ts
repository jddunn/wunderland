// @ts-nocheck
/**
 * @fileoverview Tests for the speech provider catalog utility functions.
 *
 * Validates three core catalog behaviors:
 * - **Alias normalization**: User-facing provider names (e.g. `'openai'`) are
 *   mapped to the canonical runtime provider IDs (e.g. `'openai-tts'` for TTS,
 *   `'openai-whisper'` for STT).
 * - **Extension env overrides**: The `createSpeechExtensionEnvOverrides` helper
 *   correctly populates both `speech-runtime` and `voice-synthesis` extension
 *   option blocks from provider defaults and environment variables.
 * - **Preferred provider resolution**: `getPreferredRuntimeTtsProviderId` honors
 *   an explicit preference before falling back to env-based provider detection.
 *
 * @module wunderland/__tests__/speech-catalog
 */

import { describe, expect, it } from 'vitest';

import {
  createSpeechExtensionEnvOverrides,
  getPreferredRuntimeTtsProviderId,
  normalizePreferredSpeechProviderId,
} from '../channels/voice-new/speech-catalog.js';

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

  it('maps provider defaults and env vars into voice-synthesis extension overrides', () => {
    const overrides = createSpeechExtensionEnvOverrides({
      env: {
        OPENAI_API_KEY: 'sk-openai',
        DEEPGRAM_API_KEY: 'dg-test',
        WHISPER_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1',
      },
      providerDefaults: {
        tts: 'openai',
        stt: 'whisper-local',
      },
    });

    expect(overrides['voice-synthesis']?.options).toMatchObject({
      openaiApiKey: 'sk-openai',
      deepgramApiKey: 'dg-test',
      whisperLocalBaseUrl: 'http://127.0.0.1:8080/v1',
      defaultProvider: 'openai',
      defaultSttProvider: 'whisper-local',
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
