// @ts-nocheck
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../index.js';

function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

describe('CLI subcommand help', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints command-specific help for init', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['init', '--help', '--quiet']);

    const output = stripAnsi(log.mock.calls.flat().join('\n'));
    expect(output).toContain('Command: init');
    expect(output).toContain('wunderland init <dir>');
    expect(output).not.toContain('Open TUI dashboard');
  });

  it('prints command-specific help for skills', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['skills', '--help', '--quiet']);

    const output = stripAnsi(log.mock.calls.flat().join('\n'));
    expect(output).toContain('Command: skills');
    expect(output).toContain('wunderland skills [list|info|enable|disable] [options]');
  });

  it('prints command-specific help for extensions', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['extensions', '--help', '--quiet']);

    const output = stripAnsi(log.mock.calls.flat().join('\n'));
    expect(output).toContain('Command: extensions');
    expect(output).toContain('wunderland extensions <list|info|enable|disable|configure|set-default> [options]');
  });

  it('prints command-specific help for voice', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['voice', '--help', '--quiet']);

    const output = stripAnsi(log.mock.calls.flat().join('\n'));
    expect(output).toContain('Command: voice');
    expect(output).toContain('wunderland voice [status|tts|stt|test <text>|clone]');
  });

  it('prints command-specific help for setup', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['setup', '--help', '--quiet']);

    const output = stripAnsi(log.mock.calls.flat().join('\n'));
    expect(output).toContain('Command: setup');
    expect(output).toContain('wunderland setup');
  });

  it('prints the voice help topic', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['help', 'voice', '--quiet']);

    const output = stripAnsi(log.mock.calls.flat().join('\n'));
    expect(output).toContain('Voice & Speech');
    expect(output).toContain('wunderland voice test "Hello"');
    expect(output).toContain('OPENAI_API_KEY');
  });

  it('prints global help with both HITL guardrail flags', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['--help', '--quiet']);

    const output = stripAnsi(log.mock.calls.flat().join('\n'));
    expect(output).toContain('--llm-judge');
    expect(output).toContain('--no-guardrail-override');
  });
});
