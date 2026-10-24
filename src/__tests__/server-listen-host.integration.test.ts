// @ts-nocheck
/**
 * @fileoverview Integration tests for the address the agent HTTP servers listen on.
 * @module wunderland/__tests__/server-listen-host.integration.test
 *
 * POST /chat answers without a secret unless one is configured, so
 * `wunderland start` and createWunderlandServer() listen on 127.0.0.1 unless
 * a host is named (`--host`, or the `host` option). These tests bind real
 * servers and read the address each one listens on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const captured = vi.hoisted(() => ({ errorTitles: [] as string[] }));

// Startup records each agent in ~/.wunderland; keep the tests out of the home folder.
vi.mock('../cli/config/agent-history.js', () => ({
  recordAgentStart: vi.fn(async () => undefined),
}));

vi.mock('../cli/ui/format.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    errorBlock: (title: string) => {
      captured.errorTitles.push(title);
    },
  };
});

import { createWunderlandServer } from '../channels/api/server.js';
import cmdStart from '../cli/commands/start/index.js';
import { startServerAndDisplay } from '../cli/commands/start/startup-display.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** The context the start command's last phase reads, for an agent with nothing loaded. */
function startContext(host?: string) {
  return {
    host,
    port: 0,
    displayName: 'Listen Test',
    seedId: 'seed_listen_test',
    providerId: 'openai',
    model: 'gpt-test',
    canUseLLM: false,
    openrouterFallback: undefined,
    toolMap: new Map(),
    adapterByPlatform: new Map(),
    discoveryManager: { getStats: () => ({ initialized: false, capabilityCount: 0 }), close: async () => {} },
    adaptiveRuntime: { close: async () => {} },
    pairingEnabled: false,
    autoApproveToolCalls: false,
    policy: { executionMode: 'human-dangerous' },
    hitlSecret: 'hitl-test-secret',
    chatSecret: '',
    turnApprovalMode: 'off',
    channelUnsubs: [],
    activePacks: [],
    startupLines: [],
    origLog: console.log,
    origInfo: console.info,
    origWarn: console.warn,
  };
}

describe('wunderland start', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))),
    );
  });

  async function listenThroughStartup(host?: string): Promise<string> {
    const server = createServer((_req, res) => res.end('ok'));
    servers.push(server);
    await startServerAndDisplay(startContext(host), server);
    return server.address().address;
  }

  it('listens on 127.0.0.1 when --host is not given', async () => {
    expect(await listenThroughStartup(undefined)).toBe('127.0.0.1');
  });

  it('listens on the address --host names', async () => {
    expect(await listenThroughStartup('0.0.0.0')).toBe('0.0.0.0');
  });

  it('refuses --host without an address before any startup work', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wunderland-listen-host-'));
    const exitCode = process.exitCode;
    captured.errorTitles.length = 0;
    try {
      // The config path names no file: had startup begun, it would stop on "Missing config file".
      await cmdStart([], { host: true, config: path.join(root, 'agent.config.json') }, { quiet: true });
      expect(captured.errorTitles).toEqual(['Invalid --host']);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createWunderlandServer', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wunderland-listen-host-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function serverAddress(host?: string) {
    const handle = await createWunderlandServer({
      loadEnv: false,
      workingDirectory: root,
      ...(host === undefined ? {} : { host }),
      port: 0,
      lazyTools: true,
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      workspace: { agentId: 'listen-test', baseDir: path.join(root, 'agents') },
      agentConfig: { seedId: 'seed_listen_test', discovery: { enabled: false } },
      taskOutcomeTelemetry: { enabled: false },
      adaptiveExecution: { enabled: false },
      logger: quiet,
    });
    try {
      return { host: handle.host, address: handle.server.address().address, url: handle.url, port: handle.port };
    } finally {
      await handle.close();
    }
  }

  it('listens on 127.0.0.1 when no host is given', async () => {
    const result = await serverAddress(undefined);
    expect(result.host).toBe('127.0.0.1');
    expect(result.address).toBe('127.0.0.1');
    expect(result.url).toBe(`http://127.0.0.1:${result.port}`);
  });

  it('listens on the host it is given', async () => {
    const result = await serverAddress('0.0.0.0');
    expect(result.address).toBe('0.0.0.0');
    expect(result.url).toBe(`http://localhost:${result.port}`);
  });
});
