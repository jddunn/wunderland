import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@framers/agentos-extensions-registry', () => ({
  createCuratedManifest: vi.fn(async (options?: any) => ({
    packs: [
      {
        factory: async () => ({
          descriptors: [
            { kind: 'tool', payload: { name: 'text_to_speech' } },
            { kind: 'tool', payload: { name: 'speech_to_text' } },
          ],
        }),
        options,
      },
    ],
  })),
}));

import { createCuratedManifest } from '@framers/agentos-extensions-registry';
import { createWunderlandTools, getToolAvailability, WUNDERLAND_TOOL_IDS } from '../tools/ToolRegistry.js';

describe('ToolRegistry voice integration', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.WHISPER_LOCAL_BASE_URL;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.TTS_PROVIDER;
    delete process.env.STT_PROVIDER;
  });

  it('marks both voice tools available when OpenAI is configured', () => {
    const availability = getToolAvailability({ openaiApiKey: 'sk-openai' });

    expect(availability[WUNDERLAND_TOOL_IDS.TEXT_TO_SPEECH]).toMatchObject({ available: true });
    expect(availability[WUNDERLAND_TOOL_IDS.SPEECH_TO_TEXT]).toMatchObject({ available: true });
  });

  it('marks speech_to_text available for local whisper without cloud keys', () => {
    const availability = getToolAvailability({
      whisperLocalBaseUrl: 'http://127.0.0.1:8080/v1',
    });

    expect(availability[WUNDERLAND_TOOL_IDS.SPEECH_TO_TEXT]).toMatchObject({ available: true });
    expect(availability[WUNDERLAND_TOOL_IDS.TEXT_TO_SPEECH]).toMatchObject({ available: false });
  });

  it('passes voice-synthesis provider options into the curated manifest override', async () => {
    await createWunderlandTools({
      openaiApiKey: 'sk-openai',
      deepgramApiKey: 'dg-test',
      whisperLocalBaseUrl: 'http://127.0.0.1:8080/v1',
      defaultTtsProvider: 'openai',
      defaultSttProvider: 'whisper-local',
    });

    expect(createCuratedManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: expect.objectContaining({
          'voice-synthesis': {
            options: expect.objectContaining({
              openaiApiKey: 'sk-openai',
              deepgramApiKey: 'dg-test',
              whisperLocalBaseUrl: 'http://127.0.0.1:8080/v1',
              defaultProvider: 'openai',
              defaultSttProvider: 'whisper-local',
            }),
          },
        }),
      }),
    );
  });
});
