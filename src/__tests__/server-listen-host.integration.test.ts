// @ts-nocheck
/**
 * @fileoverview Integration tests for the address the agent HTTP servers listen on.
 * @module wunderland/__tests__/server-listen-host.integration.test
 *
 * POST /chat answers without a secret unless one is configured, so
 * `wunderland start` and createWunderlandServer() listen on 127.0.0.1 unless
 * a host is named (`--host`, or the `host` option), and refuse a host other
 * machines can reach until a chat secret is set. These tests bind real servers
 * and read the address each one listens on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
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

const CHAT_SECRET = 'listen-test-chat-secret';

/** The context the start command's last phase reads, for an agent with nothing loaded. */
function startContext(host?: string, chatSecret = '') {
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
    chatSecret,
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

  async function listenThroughStartup(host?: string, chatSecret = ''): Promise<string> {
    const server = createServer((_req, res) => res.end('ok'));
    servers.push(server);
    await startServerAndDisplay(startContext(host, chatSecret), server);
    return server.address().address;
  }

  it('listens on 127.0.0.1 when --host is not given', async () => {
    expect(await listenThroughStartup(undefined)).toBe('127.0.0.1');
  });

  it('listens on the address --host names once a chat secret is set', async () => {
    expect(await listenThroughStartup('0.0.0.0', CHAT_SECRET)).toBe('0.0.0.0');
  });

  it('refuses to listen beyond this machine while /chat has no secret', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    servers.push(server);
    await expect(startServerAndDisplay(startContext('0.0.0.0', ''), server)).rejects.toThrow(
      /Refusing to listen on 0\.0\.0\.0/,
    );
    expect(server.listening).toBe(false);
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

  function startLibraryServer(extra: Record<string, unknown> = {}, agentConfig: Record<string, unknown> = {}) {
    return createWunderlandServer({
      loadEnv: false,
      workingDirectory: root,
      port: 0,
      lazyTools: true,
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      workspace: { agentId: 'listen-test', baseDir: path.join(root, 'agents') },
      agentConfig: { seedId: 'seed_listen_test', discovery: { enabled: false }, ...agentConfig },
      taskOutcomeTelemetry: { enabled: false },
      adaptiveExecution: { enabled: false },
      logger: quiet,
      ...extra,
    });
  }

  async function serverAddress(extra: Record<string, unknown> = {}) {
    const handle = await startLibraryServer(extra);
    try {
      return { host: handle.host, address: handle.server.address().address, url: handle.url, port: handle.port };
    } finally {
      await handle.close();
    }
  }

  /** POSTs JSON to the server and resolves with the status code. */
  function post(
    port: number,
    body: unknown,
    headers: Record<string, string> = {},
    { host = '127.0.0.1', path: urlPath = '/chat' }: { host?: string; path?: string } = {},
  ): Promise<number> {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host,
          port,
          path: urlPath,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  it('listens on 127.0.0.1 when no host is given', async () => {
    const result = await serverAddress();
    expect(result.host).toBe('127.0.0.1');
    expect(result.address).toBe('127.0.0.1');
    expect(result.url).toBe(`http://127.0.0.1:${result.port}`);
  });

  it('listens on the host it is given once a chat secret is set', async () => {
    const result = await serverAddress({ host: '0.0.0.0', chatSecret: CHAT_SECRET });
    expect(result.address).toBe('0.0.0.0');
    expect(result.url).toBe(`http://localhost:${result.port}`);
  });

  it('refuses a host other machines can reach while /chat has no secret', async () => {
    const outcome = await startLibraryServer({ host: '0.0.0.0' }).then(
      async (handle) => {
        await handle.close();
        return 'listened';
      },
      (err: Error) => err,
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).toMatch(/Refusing to listen on 0\.0\.0\.0/);
  });

  /** An address of this machine that is not loopback, so the server sees the request as coming from another machine. */
  const otherAddress = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)?.address;

  it.skipIf(!otherAddress)('answers the tool API from another address only with WUNDERLAND_TOOL_API_KEY', async () => {
    const handle = await startLibraryServer({ host: '0.0.0.0', chatSecret: CHAT_SECRET });
    try {
      // POST /api/tools/<name> runs a tool in autonomous mode, so with no tool key it serves this machine only.
      expect(await post(handle.port, {}, {}, { host: otherAddress, path: '/api/tools/no_such_tool' })).toBe(401);
      // From loopback the request reaches the route, which answers an unknown tool with 404.
      expect(await post(handle.port, {}, {}, { path: '/api/tools/no_such_tool' })).toBe(404);
    } finally {
      await handle.close();
    }
  });

  describe('POST /chat', () => {
    // A reply would need the model; the tests stop at the secret check or at the empty-message check.
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('requires the chatSecret option as the x-wunderland-chat-secret header', async () => {
      const handle = await startLibraryServer({ chatSecret: CHAT_SECRET });
      try {
        expect(await post(handle.port, { message: 'hello' })).toBe(401);
        expect(await post(handle.port, { message: 'hello' }, { 'x-wunderland-chat-secret': 'wrong' })).toBe(401);
        // With the secret the request reaches the handler, which answers an empty message with 400.
        expect(await post(handle.port, {}, { 'x-wunderland-chat-secret': CHAT_SECRET })).toBe(400);
      } finally {
        await handle.close();
      }
    });

    it('takes the chat secret from the agent config', async () => {
      const handle = await startLibraryServer({}, { chat: { secret: 'secret-from-config' } });
      try {
        expect(await post(handle.port, { message: 'hello' })).toBe(401);
        expect(await post(handle.port, {}, { 'x-wunderland-chat-secret': 'secret-from-config' })).toBe(400);
      } finally {
        await handle.close();
      }
    });
  });
});
