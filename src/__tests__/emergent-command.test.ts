import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function captureConsole() {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  return {
    logs,
    restore() {
      console.log = originalLog;
    },
  };
}

describe('wunderland emergent CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WUNDERLAND_SEED_ID;
    delete process.env.WUNDERLAND_AUTH_TOKEN;
    delete process.env.WUNDERLAND_INTERNAL_API_SECRET;
  });

  it('lists preview/demo tools when no seed is provided', async () => {
    const { default: cmdEmergent } = await import('../cli/commands/emergent.js');
    const cap = captureConsole();
    try {
      await cmdEmergent(['list'], {}, { yes: false, verbose: false } as any);
      const output = cap.logs.join('\n');
      expect(output).toContain('Emergent Tools');
      expect(output).toContain('fetch_github_pr_summary');
      expect(output).toContain('Preview mode');
    } finally {
      cap.restore();
    }
  });

  it('warns instead of mutating when promote is called without a seed', async () => {
    const { default: cmdEmergent } = await import('../cli/commands/emergent.js');
    const cap = captureConsole();
    try {
      await cmdEmergent(['promote', 'demo_tool'], {}, { yes: false, verbose: false } as any);
      const output = cap.logs.join('\n');
      expect(output).toContain('Preview mode only');
    } finally {
      cap.restore();
    }
  });

  it('sends Bearer auth when WUNDERLAND_AUTH_TOKEN is set for live mode', async () => {
    const { default: cmdEmergent } = await import('../cli/commands/emergent.js');
    process.env.WUNDERLAND_AUTH_TOKEN = 'token-abc';

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({
        ok: true,
        json: async () => ({ tools: [] }),
        text: async () => '',
      } as Response);

    const cap = captureConsole();
    try {
      await cmdEmergent(['list'], { seed: 'seed-123' }, { yes: false, verbose: false } as any);
      const [, init] = fetchMock.mock.calls[0]!;
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer token-abc');
    } finally {
      cap.restore();
    }
  });

  it('blocks shared promotion for redacted sandbox tools before sending a mutate request', async () => {
    const { default: cmdEmergent } = await import('../cli/commands/emergent.js');
    process.env.WUNDERLAND_SEED_ID = 'seed-123';

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          tools: [
            {
              id: 'tool-redacted',
              name: 'tool-redacted',
              tier: 'agent',
              totalUses: 4,
              confidenceScore: 0.9,
              implementationMode: 'sandbox',
              description: 'Sandbox tool',
              createdByAgent: 'agent-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              implementationSource: '[sandbox source redacted at rest]',
              implementationSourcePersisted: false,
              isActive: true,
            },
          ],
        }),
        text: async () => '',
      } as Response);

    const cap = captureConsole();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await cmdEmergent(['promote', 'tool-redacted'], {}, { yes: false, verbose: false } as any);
      const output = cap.logs.join('\n');
      expect(output).toContain('Shared promotion blocked');
      expect(output).toContain('redacted at rest');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      cap.restore();
    }
  });

  it('exports a live emergent tool package to disk', async () => {
    const { default: cmdEmergent } = await import('../cli/commands/emergent.js');
    process.env.WUNDERLAND_SEED_ID = 'seed-123';

    const tempDir = await mkdtemp(join(tmpdir(), 'wunderland-emergent-export-'));
    const outputPath = join(tempDir, 'tool.yaml');

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tools: [
            {
              id: 'tool-1',
              name: 'tool-1',
              tier: 'agent',
              totalUses: 4,
              confidenceScore: 0.9,
              implementationMode: 'compose',
              description: 'Compose tool',
              createdByAgent: 'agent-1',
              createdAt: '2026-03-25T00:00:00.000Z',
              implementationSource: 'compose spec',
              isActive: true,
            },
          ],
        }),
        text: async () => '',
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          fileName: 'tool-1.emergent-tool.yaml',
          format: 'yaml',
          portable: true,
          warnings: [],
          content: 'schemaVersion: agentos.emergent-tool.v1\n',
        }),
        text: async () => '',
      } as Response);

    const cap = captureConsole();
    try {
      await cmdEmergent(
        ['export', 'tool-1'],
        { output: outputPath },
        { yes: false, verbose: false } as any,
      );
      const written = await readFile(outputPath, 'utf-8');
      expect(written).toContain('agentos.emergent-tool.v1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      cap.restore();
    }
  });

  it('imports a package file into a target seed', async () => {
    const { default: cmdEmergent } = await import('../cli/commands/emergent.js');
    process.env.WUNDERLAND_SEED_ID = 'seed-123';

    const tempDir = await mkdtemp(join(tmpdir(), 'wunderland-emergent-import-'));
    const packagePath = join(tempDir, 'tool.yaml');
    await writeFile(packagePath, 'schemaVersion: agentos.emergent-tool.v1\npackageType: emergent-tool\nexportedAt: 2026-03-25T00:00:00.000Z\nportability:\n  portable: true\n  warnings: []\ntool:\n  originalToolId: emergent:test\n  originalTier: agent\n  name: imported_tool\n  description: test\n  inputSchema: { type: object, properties: {} }\n  outputSchema: { type: object, properties: {} }\n  implementation:\n    mode: compose\n    steps: []\n  createdBy: seed-a\n  createdAt: 2026-03-25T00:00:00.000Z\n  source: forged\n  judgeVerdicts: []\n  usageStats:\n    totalUses: 0\n    successCount: 0\n    failureCount: 0\n    avgExecutionTimeMs: 0\n    confidenceScore: 0\n    lastUsedAt: null\n', 'utf-8');

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          tool: {
            id: 'tool-imported',
            name: 'imported_tool',
            tier: 'agent',
          },
          portable: true,
          warnings: [],
        }),
        text: async () => '',
      } as Response);

    const cap = captureConsole();
    try {
      await cmdEmergent(['import', packagePath], {}, { yes: false, verbose: false } as any);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const output = cap.logs.join('\n');
      expect(output).toContain('Imported: imported_tool');
    } finally {
      cap.restore();
    }
  });
});
