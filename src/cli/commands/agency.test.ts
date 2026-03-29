import { afterEach, describe, expect, it, vi } from 'vitest';
import cmdAgency from './agency.js';

vi.mock('../config/env-manager.js', () => ({
  loadDotEnvIntoProcessUpward: vi.fn().mockResolvedValue(undefined),
}));

function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  return {
    logs,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}

describe('wunderland agency', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
  });

  it('uses live backend data for agency status when a seed is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        agencies: [
          {
            name: 'live-agency',
            strategy: 'graph',
            agents: ['researcher', 'writer'],
            status: 'running',
            totalRuns: 4,
            lastRun: '2026-03-27T18:00:00.000Z',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const cap = captureConsole();
    try {
      await cmdAgency(['status', 'live-agency'], { seed: 'seed-123' }, {});
    } finally {
      cap.restore();
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/agencies?seedId=seed-123',
    );
    const output = cap.logs.join('\n');
    expect(output).toContain('Agency: live-agency');
    expect(output).toContain('running');
    expect(output).toContain('researcher');
    expect(process.exitCode).toBeUndefined();
  });

  it('does not leak demo agencies when the live backend returns an empty list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ agencies: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const cap = captureConsole();
    try {
      await cmdAgency(['list'], { seed: 'seed-123' }, {});
    } finally {
      cap.restore();
    }

    const output = cap.logs.join('\n');
    expect(output).toContain('No agencies configured');
    expect(output).not.toContain('research-team');
    expect(process.exitCode).toBeUndefined();
  });
});
