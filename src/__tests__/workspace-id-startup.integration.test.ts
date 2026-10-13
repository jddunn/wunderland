// @ts-nocheck
/**
 * @fileoverview Integration tests for where startup refuses a workspace id that names no folder of its own.
 * @module wunderland/__tests__/workspace-id-startup.integration.test
 *
 * The HTTP server and the start command's seed phase check the id first, so
 * a refused id stops them before telemetry is configured or any store opens.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createWunderlandServer } from '../channels/api/server.js';
import { initializeSeed } from '../cli/commands/start/seed-initializer.js';
import { InvalidAgentWorkspaceIdError } from '../runtime/tools/workspace.js';

/** The switches a config's `observability.otel` block writes before telemetry starts. */
const OTEL_ENV = ['WUNDERLAND_OTEL_ENABLED', 'WUNDERLAND_OTEL_LOGS_ENABLED'];

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

describe('startup with a workspace id that names no folder of its own', () => {
  let root: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wunderland-workspace-startup-'));
    savedEnv = Object.fromEntries(OTEL_ENV.map((name) => [name, process.env[name]]));
    for (const name of OTEL_ENV) delete process.env[name];
  });

  afterEach(() => {
    for (const name of OTEL_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['..', '.'])(
    'createWunderlandServer refuses the workspace agent id %j before telemetry is configured',
    async (agentId) => {
      await expect(
        createWunderlandServer({
          loadEnv: false,
          workingDirectory: root,
          host: '127.0.0.1',
          port: 0,
          lazyTools: true,
          llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
          workspace: { agentId, baseDir: path.join(root, 'agents') },
          agentConfig: {
            seedId: 'seed_server',
            discovery: { enabled: false },
            observability: { otel: { enabled: true, exportLogs: true } },
          },
          taskOutcomeTelemetry: { enabled: false },
          adaptiveExecution: { enabled: false },
          logger: quiet,
        }),
      ).rejects.toBeInstanceOf(InvalidAgentWorkspaceIdError);

      // The config's telemetry switches were never applied, and nothing was written.
      expect(process.env['WUNDERLAND_OTEL_ENABLED']).toBeUndefined();
      expect(process.env['WUNDERLAND_OTEL_LOGS_ENABLED']).toBeUndefined();
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it('the start command refuses the seed id ".." before telemetry is configured', async () => {
    const ctx = {
      cfg: { seedId: '..', observability: { otel: { enabled: true } } },
      globalConfig: {},
      flags: {},
    };

    await expect(initializeSeed(ctx)).rejects.toBeInstanceOf(InvalidAgentWorkspaceIdError);

    expect(process.env['WUNDERLAND_OTEL_ENABLED']).toBeUndefined();
    expect(ctx.seedId).toBeUndefined();
  });
});
