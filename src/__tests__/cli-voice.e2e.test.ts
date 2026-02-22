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

vi.mock('../cli/config/secrets.js', () => ({
  checkEnvSecrets: vi.fn().mockReturnValue([]),
}));

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
