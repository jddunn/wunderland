// @ts-nocheck
/**
 * The WildWeave film studio pack in `start`: the agent config names `wildweave-film` in its tool
 * extensions, and `start`'s extension phase imports `@framers/agentos-ext-wildweave-film` from npm
 * by its package, with the options wunderland gives it, as it loads any pack the curated registry
 * does not list.
 *
 * With no key the pack's 22 tools reach the tool map. With the endpoint's bearer token in the agent
 * config's `secrets["wildweave.studio.http_token"]`, its one HTTP handler is mounted on `start`'s own
 * HTTP server at /mcp/wildweave-film, where an MCP client's `initialize` with
 * `Authorization: Bearer <token>` reaches the pack's server and a request without it answers 401.
 * With no token the tools still load and the endpoint is not mounted. With a key in the environment or in the agent config's `secrets` (a fake one),
 * `wildweave_film_list` calls the studio with it; the studio is a stubbed `fetch`. An agent whose
 * `tools.allow` keeps fewer than all 22 tools gets no endpoint, which would serve them all, token or not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadExtensions } from '../extension-loader.js';
import { createAgentHttpServer } from '../http-server.js';
import { getPermissionsForSet, normalizeRuntimePolicy } from '../../../../runtime/tools/policy.js';

/** Importing a pack from npm takes longer than vitest's 5 s default. */
const LOAD_TIMEOUT_MS = 120_000;

/** A key of the studio key's shape; synthetic, never a real one. */
const FAKE_KEY = `wld_live_${'f'.repeat(40)}`;

const MCP_PATH = '/mcp/wildweave-film';

/** The endpoint's bearer token: 64 hex characters, as `openssl rand -hex 32` writes one. Synthetic. */
const TOKEN = 'e5'.repeat(32);

/** The agent config's secrets holding the endpoint's token under the secret id the pack reads. */
const TOKEN_SECRETS = { secrets: { 'wildweave.studio.http_token': TOKEN } };

let workspaceBaseDir = '';
let savedKey: string | undefined;
let savedToken: string | undefined;

/**
 * Runs `start`'s extension phase for an agent whose only tool extension is `wildweave-film`, with
 * `extra` laid over its config.
 */
async function loadWildweaveFilm(extra: Record<string, unknown> = {}): Promise<any> {
  const cfg = {
    seedId: 'wildweave_film_test',
    permissionSet: 'unrestricted',
    toolAccessProfile: 'unrestricted',
    executionMode: 'autonomous',
    extensions: { tools: ['wildweave-film'], voice: [], productivity: [] },
    ...extra,
  };
  const policy = normalizeRuntimePolicy(cfg);
  const ctx: any = {
    cfg,
    globalConfig: {},
    policy,
    permissions: getPermissionsForSet(policy.permissionSet),
    dangerouslySkipCommandSafety: false,
    workspaceAgentId: cfg.seedId,
    workspaceBaseDir,
    lazyTools: false,
    LOCAL_ONLY_CHANNELS: new Set(['webchat']),
    CLI_REQUIRED_CHANNELS: new Set(['signal', 'zalouser']),
  };
  const log = console.log;
  const info = console.info;
  const warn = console.warn;
  try {
    await loadExtensions(ctx);
  } finally {
    // loadExtensions captures the console for the startup panel; put it back.
    console.log = log;
    console.info = info;
    console.warn = warn;
  }
  return ctx;
}

/** `start`'s HTTP server over the loaded tools and handlers, with the rest of its context inert. */
function startServer(loaded: any) {
  return createAgentHttpServer({
    hitlSecret: '',
    chatSecret: '',
    feedSecret: '',
    hitlManager: {
      requestApproval: vi.fn(async () => ({ approved: false })),
      checkpoint: vi.fn(async () => ({ decision: 'continue' })),
      cancelRequest: vi.fn(async () => undefined),
    },
    pairing: null,
    pairingEnabled: false,
    sessions: new Map(),
    systemPrompt: 'system prompt',
    toolMap: loaded.toolMap,
    canUseLLM: false,
    seed: { seedId: 'wildweave_film_test' },
    seedId: 'wildweave_film_test',
    displayName: 'WildWeave film test',
    providerId: 'openai',
    model: 'gpt-test',
    llmApiKey: '',
    llmBaseUrl: 'https://api.openai.com/v1',
    policy: loaded.policy,
    adaptiveRuntime: {
      resolveTurnDecision: vi.fn(() => ({ toolFailureMode: 'fail_open', degraded: false, reason: undefined, actions: undefined, kpi: undefined })),
      recordTurnOutcome: vi.fn(async () => undefined),
    },
    discoveryManager: { discoverForTurn: vi.fn(async () => null) },
    autoApproveToolCalls: false,
    dangerouslySkipPermissions: false,
    strictToolNames: false,
    openrouterFallback: undefined,
    oauthGetApiKey: undefined,
    workspaceAgentId: 'wildweave_film_test',
    workspaceBaseDir,
    sseClients: new Set(),
    broadcastHitlUpdate: vi.fn(),
    adapterByPlatform: new Map(),
    loadedHttpHandlers: loaded.loadedHttpHandlers,
    turnApprovalMode: 'off',
    defaultTenantId: undefined,
    port: 0,
    startTime: Date.now(),
    cfg: loaded.cfg,
    rawAgentConfig: {},
    globalConfig: {},
    configDir: workspaceBaseDir,
    lazyTools: false,
    skillsPrompt: '',
    selectedPersona: undefined,
    availablePersonas: [],
  });
}

/** One POST to the server; answers its status, content type, `WWW-Authenticate` challenge and body. */
function post(port: number, urlPath: string, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; type: string; challenge: string; text: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers['content-type'] ?? ''),
            challenge: String(res.headers['www-authenticate'] ?? ''),
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** The JSON-RPC message of an MCP answer, sent as JSON or as one server-sent event. */
function rpcOf(answer: { type: string; text: string }): any {
  if (!answer.type.includes('text/event-stream')) return JSON.parse(answer.text);
  const data = answer.text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .find((line) => line.length > 0);
  return JSON.parse(data ?? 'null');
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wunderland-test', version: '1.0.0' } },
};

beforeEach(async () => {
  workspaceBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-wildweave-film-'));
  savedKey = process.env['WILDWEAVE_STUDIO_KEY'];
  delete process.env['WILDWEAVE_STUDIO_KEY'];
  savedToken = process.env['WILDWEAVE_STUDIO_HTTP_TOKEN'];
  delete process.env['WILDWEAVE_STUDIO_HTTP_TOKEN'];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env['WILDWEAVE_STUDIO_KEY'];
  else process.env['WILDWEAVE_STUDIO_KEY'] = savedKey;
  if (savedToken === undefined) delete process.env['WILDWEAVE_STUDIO_HTTP_TOKEN'];
  else process.env['WILDWEAVE_STUDIO_HTTP_TOKEN'] = savedToken;
  await fs.rm(workspaceBaseDir, { recursive: true, force: true });
});

describe('wunderland start with the WildWeave film studio pack', () => {
  it('loads its 22 tools and mounts its MCP endpoint at /mcp/wildweave-film behind the bearer token from the secrets, with no key', async () => {
    const ctx = await loadWildweaveFilm(TOKEN_SECRETS);

    const names = [...ctx.toolMap.keys()].filter((name) => name.startsWith('wildweave_film_'));
    expect(names).toHaveLength(22);
    for (const name of names) {
      const tool = ctx.toolMap.get(name);
      expect(tool.name).toBe(name);
      expect(typeof tool.execute).toBe('function');
      expect(tool.inputSchema?.type).toBe('object');
      expect(tool.category).toBe('media');
    }
    expect(names).toEqual(expect.arrayContaining(['wildweave_film_list', 'wildweave_film_edit', 'wildweave_film_export', 'wildweave_film_render']));

    // Without a key a remote tool refuses before any request.
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await ctx.toolMap.get('wildweave_film_list').execute({})).toMatchObject({ success: false, output: { ok: false, error: { code: 'key_missing' } } });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    expect(ctx.loadedHttpHandlers).toHaveLength(1);
    const server = startServer(ctx);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;

      const bearer = { authorization: `Bearer ${TOKEN}` };
      const init = await post(port, MCP_PATH, INITIALIZE, bearer);
      expect(init.status).toBe(200);
      const rpc = rpcOf(init);
      expect(rpc.id).toBe(1);
      expect(rpc.result.serverInfo.name).toBe('wildweave-film');
      expect(rpc.result.capabilities.tools).toBeDefined();

      // Without the token, or with another, the pack answers 401 with a Bearer challenge.
      const anonymous = await post(port, MCP_PATH, INITIALIZE);
      expect(anonymous.status).toBe(401);
      expect(anonymous.challenge).toMatch(/^Bearer/);
      expect(anonymous.text).not.toContain(TOKEN);
      expect((await post(port, MCP_PATH, INITIALIZE, { authorization: `Bearer ${'f6'.repeat(32)}` })).status).toBe(401);
      expect((await post(port, MCP_PATH, INITIALIZE, { authorization: TOKEN })).status).toBe(401);

      // Another path is not the pack's: start answers it 404.
      expect((await post(port, '/mcp/other', INITIALIZE, bearer)).status).toBe(404);
      // A browser page on another site is refused by the pack, token or not.
      expect((await post(port, MCP_PATH, INITIALIZE, { ...bearer, origin: 'https://example.com' })).status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await Promise.allSettled((ctx.activePacks ?? []).map((pack: any) => pack?.onDeactivate?.()));
    }
  }, LOAD_TIMEOUT_MS);

  it('loads its 22 tools with no endpoint token, and mounts no MCP endpoint', async () => {
    // The pack refuses to load with an endpoint and no token; start leaves the endpoint off instead.
    const ctx = await loadWildweaveFilm();
    try {
      expect([...ctx.toolMap.keys()].filter((name) => name.startsWith('wildweave_film_'))).toHaveLength(22);
      expect(ctx.loadedHttpHandlers).toHaveLength(0);

      const server = startServer(ctx);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      try {
        const { port } = server.address() as AddressInfo;
        expect((await post(port, MCP_PATH, INITIALIZE)).status).toBe(404);
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    } finally {
      await Promise.allSettled((ctx.activePacks ?? []).map((pack: any) => pack?.onDeactivate?.()));
    }
  }, LOAD_TIMEOUT_MS);

  it('mounts the endpoint with the token from WILDWEAVE_STUDIO_HTTP_TOKEN, answering 401 without it', async () => {
    process.env['WILDWEAVE_STUDIO_HTTP_TOKEN'] = TOKEN;
    const ctx = await loadWildweaveFilm();
    try {
      expect(ctx.loadedHttpHandlers).toHaveLength(1);
      const server = startServer(ctx);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      try {
        const { port } = server.address() as AddressInfo;
        expect((await post(port, MCP_PATH, INITIALIZE)).status).toBe(401);
        const init = await post(port, MCP_PATH, INITIALIZE, { authorization: `Bearer ${TOKEN}` });
        expect(init.status).toBe(200);
        expect(rpcOf(init).result.serverInfo.name).toBe('wildweave-film');
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    } finally {
      await Promise.allSettled((ctx.activePacks ?? []).map((pack: any) => pack?.onDeactivate?.()));
    }
  }, LOAD_TIMEOUT_MS);

  it('passes the key from WILDWEAVE_STUDIO_KEY to the studio when wildweave_film_list runs', async () => {
    process.env['WILDWEAVE_STUDIO_KEY'] = FAKE_KEY;
    const ctx = await loadWildweaveFilm();
    try {
      const studio = vi.fn(async () =>
        new Response(JSON.stringify({ films: [] }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req-test' } }),
      );
      vi.stubGlobal('fetch', studio);

      const result = await ctx.toolMap.get('wildweave_film_list').execute({});

      expect(result).toMatchObject({ success: true, output: { ok: true, result: { films: [] }, requestId: 'req-test' } });
      expect(studio).toHaveBeenCalledTimes(1);
      const [url, init] = studio.mock.calls[0];
      expect(String(url)).toBe('https://wilds.ai/api/v1/wildweave/studio/films');
      expect(init.method).toBe('GET');
      expect(init.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    } finally {
      await Promise.allSettled((ctx.activePacks ?? []).map((pack: any) => pack?.onDeactivate?.()));
    }
  }, LOAD_TIMEOUT_MS);

  it('passes the key from the agent config\'s secrets to the studio through getSecret, with no variable set', async () => {
    const ctx = await loadWildweaveFilm({ secrets: { 'wildweave.studio.key': FAKE_KEY } });
    try {
      const studio = vi.fn(async () =>
        new Response(JSON.stringify({ films: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      vi.stubGlobal('fetch', studio);

      const result = await ctx.toolMap.get('wildweave_film_list').execute({});

      expect(result).toMatchObject({ success: true, output: { ok: true, result: { films: [] } } });
      expect(process.env['WILDWEAVE_STUDIO_KEY']).toBeUndefined();
      const [, init] = studio.mock.calls[0];
      expect(init.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    } finally {
      await Promise.allSettled((ctx.activePacks ?? []).map((pack: any) => pack?.onDeactivate?.()));
    }
  }, LOAD_TIMEOUT_MS);

  it('mounts no MCP endpoint when tools.allow keeps fewer than all of the pack\'s tools', async () => {
    // The endpoint would serve all 22 tools to its callers, edit and render among them.
    const ctx = await loadWildweaveFilm({
      ...TOKEN_SECRETS,
      tools: { allow: { packs: ['wildweave-film'], tools: ['wildweave_film_list'] } },
    });
    try {
      expect([...ctx.toolMap.keys()].filter((name) => name.startsWith('wildweave_film_'))).toEqual(['wildweave_film_list']);
      expect(ctx.loadedHttpHandlers).toHaveLength(0);

      const server = startServer(ctx);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      try {
        const { port } = server.address() as AddressInfo;
        expect((await post(port, MCP_PATH, INITIALIZE)).status).toBe(404);
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    } finally {
      await Promise.allSettled((ctx.activePacks ?? []).map((pack: any) => pack?.onDeactivate?.()));
    }
  }, LOAD_TIMEOUT_MS);
});
