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
});
