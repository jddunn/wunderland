// @ts-nocheck
/**
 * @fileoverview E2E tests for `wunderland voice` CLI command.
 * @module wunderland/__tests__/cli-voice.e2e.test
 *
 * Tests all voice subcommands (status, tts, stt, test, clone) by mocking
 * the env/secrets layer and verifying command behavior and exit codes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../cli/config/env-manager.js', () => ({
  loadEnv: vi.fn().mockResolvedValue({}),
}));

vi.mock('../cli/config/config-manager.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock('../cli/config/secrets.js', () => ({
  checkEnvSecrets: vi.fn().mockReturnValue([]),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@framers/agentos/speech', () => ({
  getSpeechProviderCatalog: vi.fn((kind?: string) => {
    const entries = [
      { id: 'twilio', kind: 'telephony', label: 'Twilio', envVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], local: false },
      { id: 'openai-tts', kind: 'tts', label: 'OpenAI TTS', envVars: ['OPENAI_API_KEY'], local: false, streaming: true },
      { id: 'elevenlabs', kind: 'tts', label: 'ElevenLabs', envVars: ['ELEVENLABS_API_KEY'], local: false, streaming: true },
      { id: 'piper', kind: 'tts', label: 'Piper', envVars: [], local: true, streaming: false },
      { id: 'openai-whisper', kind: 'stt', label: 'OpenAI Whisper', envVars: ['OPENAI_API_KEY'], local: false, streaming: false },
      { id: 'deepgram', kind: 'stt', label: 'Deepgram', envVars: ['DEEPGRAM_API_KEY'], local: false, streaming: true },
      { id: 'whisper-local', kind: 'stt', label: 'Whisper.cpp', envVars: [], local: true, streaming: false },
    ];
    return kind ? entries.filter((entry) => entry.kind === kind) : entries;
  }),
  findSpeechProviderCatalogEntry: vi.fn((id: string) => {
    const entries = [
      { id: 'openai-tts', kind: 'tts', label: 'OpenAI TTS', envVars: ['OPENAI_API_KEY'], local: false },
      { id: 'elevenlabs', kind: 'tts', label: 'ElevenLabs', envVars: ['ELEVENLABS_API_KEY'], local: false },
      { id: 'piper', kind: 'tts', label: 'Piper', envVars: [], local: true },
      { id: 'openai-whisper', kind: 'stt', label: 'OpenAI Whisper', envVars: ['OPENAI_API_KEY'], local: false },
      { id: 'deepgram', kind: 'stt', label: 'Deepgram', envVars: ['DEEPGRAM_API_KEY'], local: false },
      { id: 'whisper-local', kind: 'stt', label: 'Whisper.cpp', envVars: [], local: true },
    ];
    return entries.find((entry) => entry.id === id);
  }),
  createSpeechRuntimeFromEnv: vi.fn(() => ({
    createSession: vi.fn(() => ({
      speak: vi.fn().mockResolvedValue({
        audioBuffer: Buffer.from('fake-audio'),
        mimeType: 'audio/mpeg',
      }),
    })),
    getProvider: vi.fn(() => ({
      getProviderName: () => 'OpenAI TTS',
    })),
  })),
}));

import { writeFile } from 'node:fs/promises';
import { createSpeechRuntimeFromEnv } from '@framers/agentos/speech';
import { loadEnv } from '../cli/config/env-manager.js';
import { loadConfig } from '../cli/config/config-manager.js';
import cmdVoice from '../cli/commands/voice.js';

// ── Globals ──────────────────────────────────────────────────────────────────

const mockGlobals: any = { config: '/tmp/test-config', verbose: false };

// ── Lifecycle ────────────────────────────────────────────────────────────────

let savedExitCode: number | undefined;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(loadEnv).mockResolvedValue({});
  vi.mocked(loadConfig).mockResolvedValue({});
  vi.mocked(writeFile).mockClear();
  vi.mocked(createSpeechRuntimeFromEnv).mockClear();
});

afterEach(() => {
  process.exitCode = savedExitCode;
  consoleSpy.mockRestore();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('wunderland voice', () => {
  it('default (no args) runs status subcommand without error', async () => {
    await cmdVoice([], {}, mockGlobals);
    // Should not set an error exit code
    expect(process.exitCode).toBeUndefined();
  });

  it('status subcommand runs without error', async () => {
    await cmdVoice(['status'], {}, mockGlobals);
    expect(process.exitCode).toBeUndefined();
  });

  it('tts subcommand lists TTS providers without error', async () => {
    await cmdVoice(['tts'], {}, mockGlobals);
    expect(process.exitCode).toBeUndefined();
  });

  it('stt subcommand lists STT providers without error', async () => {
    await cmdVoice(['stt'], {}, mockGlobals);
    expect(process.exitCode).toBeUndefined();
  });

  it('test subcommand runs with provided text', async () => {
    await cmdVoice(['test', 'Hello', 'world'], {}, mockGlobals);
    expect(process.exitCode).toBeUndefined();
  });

  it('test subcommand synthesizes audio when a runtime-backed provider is configured', async () => {
    vi.mocked(loadEnv).mockResolvedValue({ OPENAI_API_KEY: 'sk-test' });

    await cmdVoice(['test', 'Hello', 'runtime'], {}, mockGlobals);

    expect(process.exitCode).toBeUndefined();
    expect(createSpeechRuntimeFromEnv).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('test subcommand honors configured TTS provider defaults over env fallback order', async () => {
    vi.mocked(loadEnv).mockResolvedValue({
      OPENAI_API_KEY: 'sk-openai',
      ELEVENLABS_API_KEY: 'sk-elevenlabs',
    });
    vi.mocked(loadConfig).mockResolvedValue({
      providerDefaults: { tts: 'elevenlabs' },
    });

    await cmdVoice(['test', 'Prefer', 'ElevenLabs'], {}, mockGlobals);

    expect(createSpeechRuntimeFromEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENAI_API_KEY: 'sk-openai',
        ELEVENLABS_API_KEY: 'sk-elevenlabs',
      }),
    );
    const runtime = vi.mocked(createSpeechRuntimeFromEnv).mock.results[0]?.value as
      | { createSession?: ReturnType<typeof vi.fn> }
      | undefined;
    expect(runtime?.createSession).toHaveBeenCalledWith({ ttsProviderId: 'elevenlabs' });
  });

  it('test subcommand shows error for missing text and sets exitCode=1', async () => {
    await cmdVoice(['test'], {}, mockGlobals);
    expect(process.exitCode).toBe(1);
  });

  it('clone subcommand runs without error', async () => {
    await cmdVoice(['clone'], {}, mockGlobals);
    expect(process.exitCode).toBeUndefined();
  });

  it('unknown subcommand shows error and sets exitCode=1', async () => {
    await cmdVoice(['invalid'], {}, mockGlobals);
    expect(process.exitCode).toBe(1);
  });
});
