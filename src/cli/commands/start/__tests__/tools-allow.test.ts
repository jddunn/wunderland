// @ts-nocheck
/**
 * `tools.allow` in an agent config confines what `wunderland start` loads,
 * offers and runs, whatever the permission set, tool access profile and
 * execution mode say:
 *
 * - the loader loads only the packs the list names (in place of the default
 *   packs, the config's own extension lists and the credential
 *   recommendations) and keeps only the tools it names;
 * - `extensions_enable` refuses a pack outside the list with `tool_not_allowed`;
 * - a turn offers the model only the listed tools, and a call to any other
 *   tool, including one registered after start, is refused at dispatch with
 *   `tool_not_allowed` and never runs: on a webhook wake (`runAgentTurn`), a
 *   channel message and `POST /chat`.
 *
 * The packs are the real curated `web-search` and `cli-executor` packs, loaded
 * through the extensions registry exactly as `start` loads them. The model is a
 * `fetch` stub answering OpenAI's chat-completions shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadExtensions } from '../extension-loader.js';
import { runAgentTurn } from '../agent-turn.js';
import { handleInboundChannelMessage } from '../channel-handler.js';
import { handleChatRoutes } from '../routes/chat.js';
import { getPermissionsForSet, normalizeRuntimePolicy } from '../../../../runtime/tools/policy.js';

/** Loading real extension packs takes longer than vitest's 5 s default. */
const LOAD_TIMEOUT_MS = 120_000;

/** The allow-list the hosted runner gives an agent that may search the web and nothing else. */
const ALLOW_WEB_SEARCH = { packs: ['web-search'], tools: ['web_search'] };

/** The most permissive policy `start` knows: every tool category, the shell, no approvals. */
function unrestrictedAutonomousConfig(extra: Record<string, unknown> = {}) {
  return {
    seedId: 'tools_allow_test',
    permissionSet: 'unrestricted',
    toolAccessProfile: 'unrestricted',
    executionMode: 'autonomous',
    ...extra,
  };
}

/** Both packs named explicitly, so no other default pack loads. */
const WEB_AND_SHELL = { tools: ['web-search', 'cli-executor'], voice: [], productivity: [] };

let workspaceBaseDir = '';
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Runs `start`'s extension phase on a context the earlier phases would have built. */
async function loadForConfig(cfg: Record<string, unknown>): Promise<any> {
  const policy = normalizeRuntimePolicy(cfg);
  const ctx: any = {
    cfg,
    globalConfig: {},
    policy,
    permissions: getPermissionsForSet(policy.permissionSet),
    dangerouslySkipCommandSafety: false,
    workspaceAgentId: String(cfg.seedId),
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

function toolNames(ctx: any): string[] {
  return [...ctx.toolMap.keys()].sort();
}

function packNames(ctx: any): string[] {
  return (ctx.activePacks ?? []).map((p: any) => p?.name).sort();
}

/**
 * Registers a fake `shell_execute` after start, as any later registration
 * would, and returns its `execute` spy.
 */
function registerShellAfterStart(ctx: any) {
  const execute = vi.fn(async () => ({ success: true, output: 'uid=0(root)' }));
  ctx.toolMap.set('shell_execute', {
    name: 'shell_execute',
    description: 'Run a shell command',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    category: 'system',
    hasSideEffects: true,
    execute,
  });
  return execute;
}

/**
 * Stubs `fetch` as the model: the first chat-completions call asks for
 * `shell_execute` and `extensions_enable`, the second answers `done`. Returns
 * the parsed request bodies the model received.
 */
function stubModelCallingShell(): any[] {
  const requests: any[] = [];
  const replies = [
    {
      model: 'gpt-test',
      usage: {},
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call-shell', type: 'function', function: { name: 'shell_execute', arguments: JSON.stringify({ command: 'id' }) } },
            { id: 'call-enable', type: 'function', function: { name: 'extensions_enable', arguments: JSON.stringify({ extension: 'cli-executor' }) } },
          ],
        },
      }],
    },
    { model: 'gpt-test', usage: {}, choices: [{ message: { role: 'assistant', content: 'done' } }] },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: any) => {
    if (!String(url).endsWith('/chat/completions')) {
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    }
    requests.push(JSON.parse(String(init?.body ?? '{}')));
    const next = replies.shift();
    if (!next) throw new Error('the model was called more often than the test expects');
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  }));
  return requests;
}

/** The model saw only `web_search`, both calls came back `tool_not_allowed`, and the shell never ran. */
function expectRefusedAtDispatch(requests: any[], shellExecute: ReturnType<typeof vi.fn>): void {
  expect(requests).toHaveLength(2);
  expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(['web_search']);
  const toolResults = requests[1].messages.filter((m: any) => m.role === 'tool');
  const resultFor = (id: string) => String(toolResults.find((m: any) => m.tool_call_id === id)?.content ?? '');
  expect(resultFor('call-shell')).toContain('tool_not_allowed');
  expect(resultFor('call-enable')).toContain('tool_not_allowed');
  expect(shellExecute).not.toHaveBeenCalled();
}

/** Capability discovery that ranks the shell first, so the turn's own tool list names it beside web_search. */
const discoveryOfferingShell = {
  discoverForTurn: async () => ({
    tier0: 'Capabilities: shell, search',
    tier1: [],
    tier2: [
      { capability: { kind: 'tool', id: 'tool:shell_execute', name: 'shell_execute' }, fullText: 'shell_execute: run a command' },
      { capability: { kind: 'tool', id: 'tool:web_search', name: 'web_search' }, fullText: 'web_search: search the web' },
    ],
  }),
};

const adaptiveRuntimeStub = {
  resolveTurnDecision: () => ({ toolFailureMode: 'fail_open', degraded: false, reason: '', actions: {}, kpi: null }),
  recordTurnOutcome: async () => {},
};

beforeEach(async () => {
  workspaceBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-tools-allow-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
  await fs.rm(workspaceBaseDir, { recursive: true, force: true });
});

describe('wunderland start: tools.allow', () => {
  it('without tools.allow, the unrestricted autonomous config loads the shell pack (the control)', async () => {
    const ctx = await loadForConfig(unrestrictedAutonomousConfig({ extensions: WEB_AND_SHELL }));

    expect(ctx.toolMap.has('web_search')).toBe(true);
    expect(ctx.toolMap.has('shell_execute')).toBe(true);
  }, LOAD_TIMEOUT_MS);

  it('loads only the listed packs and keeps only the listed tools, in place of the default packs', async () => {
    // The recommender proposes the giphy pack whenever its key is set.
    setEnv('GIPHY_API_KEY', 'giphy-test-key');

    const ctx = await loadForConfig(unrestrictedAutonomousConfig({ tools: { allow: ALLOW_WEB_SEARCH } }));

    expect(packNames(ctx)).toEqual(['@framers/agentos-ext-web-search']);
    expect(toolNames(ctx)).toEqual(['web_search']);
    expect(ctx.toolMap.has('shell_execute')).toBe(false);
  }, LOAD_TIMEOUT_MS);

  it('an extensions list that names the shell pack does not widen tools.allow', async () => {
    const ctx = await loadForConfig(
      unrestrictedAutonomousConfig({ extensions: WEB_AND_SHELL, tools: { allow: ALLOW_WEB_SEARCH } }),
    );

    expect(packNames(ctx)).toEqual(['@framers/agentos-ext-web-search']);
    expect(toolNames(ctx)).toEqual(['web_search']);
  }, LOAD_TIMEOUT_MS);

  it('a tools.allow whose lists are not lists of names allows nothing', async () => {
    const ctx = await loadForConfig(
      unrestrictedAutonomousConfig({ tools: { allow: { packs: 'web-search', tools: { web_search: true } } } }),
    );

    expect(packNames(ctx)).toEqual([]);
    expect(toolNames(ctx)).toEqual([]);
  }, LOAD_TIMEOUT_MS);

  it('extensions_enable refuses a pack outside the list with tool_not_allowed', async () => {
    const ctx = await loadForConfig(
      unrestrictedAutonomousConfig({
        tools: { allow: { packs: ['web-search'], tools: ['web_search', 'extensions_enable'] } },
      }),
    );
    const enable = ctx.toolMap.get('extensions_enable');
    expect(enable).toBeDefined();

    await expect(enable.execute({ extension: 'cli-executor' }, {})).resolves.toEqual({
      success: false,
      error: 'tool_not_allowed',
    });
    await expect(
      enable.execute({ extension: '@framers/agentos-ext-cli-executor', source: 'package' }, {}),
    ).resolves.toEqual({ success: false, error: 'tool_not_allowed' });
    expect(ctx.toolMap.has('shell_execute')).toBe(false);

    // A listed pack passes the check (it is already loaded, so nothing is added).
    const listed = await enable.execute({ extension: 'web-search' }, {});
    expect(listed.success).toBe(true);
    expect(listed.output.reason).toBe('already_loaded');
  }, LOAD_TIMEOUT_MS);

  it('a turn whose model calls a tool outside the list gets tool_not_allowed at dispatch', async () => {
    const cfg = unrestrictedAutonomousConfig({ tools: { allow: ALLOW_WEB_SEARCH } });
    const ctx = await loadForConfig(cfg);
    const shellExecute = registerShellAfterStart(ctx);
    const requests = stubModelCallingShell();

    const broadcastAgentEvent = vi.fn();
    const result = await runAgentTurn(
      {
        seedId: 'tools_allow_test',
        activePersonaId: 'default',
        providerId: 'openai',
        llmApiKey: 'sk-test',
        model: 'gpt-test',
        systemPrompt: 'SYS',
        toolMap: ctx.toolMap,
        cfg,
        canUseLLM: true,
        dangerouslySkipPermissions: false,
        // Side-effect tools would run without a human: only the list stands in the way.
        autoApproveToolCalls: true,
        sessions: new Map(),
        broadcastAgentEvent,
      },
      { sessionId: 'webhook:allow', message: 'run id on the shell', source: 'webhook:allow' },
    );

    expect(result.failed).toBe(false);
    expect(result.reply).toBe('done');
    expectRefusedAtDispatch(requests, shellExecute);
    expect(result.toolCallCount).toBe(0);
    expect(broadcastAgentEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_call' }));
  }, LOAD_TIMEOUT_MS);

  it('a channel message gets the same refusal, even for a tool discovery offers', async () => {
    const cfg = unrestrictedAutonomousConfig({ tools: { allow: ALLOW_WEB_SEARCH } });
    const ctx = await loadForConfig(cfg);
    const shellExecute = registerShellAfterStart(ctx);
    const requests = stubModelCallingShell();

    const adapter = {
      platform: 'telegram',
      sendTypingIndicator: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
    };
    Object.assign(ctx, {
      pairingEnabled: false,
      pairingGroupTrigger: '!pair',
      pairingGroupTriggerEnabled: false,
      systemPrompt: 'SYS',
      channelSessions: new Map(),
      channelQueues: new Map(),
      channelUnsubs: [],
      discoveryManager: discoveryOfferingShell,
      adaptiveRuntime: adaptiveRuntimeStub,
      defaultTenantId: '',
      canUseLLM: true,
      seed: { seedId: 'tools_allow_test' },
      seedId: 'tools_allow_test',
      providerId: 'openai',
      model: 'gpt-test',
      llmApiKey: 'sk-test',
      autoApproveToolCalls: true,
      dangerouslySkipPermissions: false,
      strictToolNames: false,
      turnApprovalMode: 'off',
      adapterByPlatform: new Map([['telegram', adapter]]),
    });

    await handleInboundChannelMessage(ctx, {
      platform: 'telegram',
      conversationId: 'chat-1',
      conversationType: 'direct',
      messageId: 'msg-1',
      text: 'run id on the shell',
      sender: { id: 'user-1' },
    });

    expectRefusedAtDispatch(requests, shellExecute);
    const sent = adapter.sendMessage.mock.calls.map((call: any[]) => call[1]?.blocks?.[0]?.text);
    expect(sent).toEqual(['done']);
  }, LOAD_TIMEOUT_MS);

  it('POST /chat gets the same refusal', async () => {
    const cfg = unrestrictedAutonomousConfig({ tools: { allow: ALLOW_WEB_SEARCH } });
    const ctx = await loadForConfig(cfg);
    const shellExecute = registerShellAfterStart(ctx);
    const requests = stubModelCallingShell();

    const deps: any = {
      seedId: 'tools_allow_test',
      displayName: 'Tools Allow Test',
      activePersonaId: 'default',
      availablePersonas: [],
      seed: { seedId: 'tools_allow_test' },
      providerId: 'openai',
      model: 'gpt-test',
      llmApiKey: 'sk-test',
      llmBaseUrl: undefined,
      canUseLLM: true,
      cfg,
      rawAgentConfig: cfg,
      globalConfig: {},
      configDir: workspaceBaseDir,
      policy: ctx.policy,
      toolMap: ctx.toolMap,
      sessions: new Map(),
      systemPrompt: 'SYS',
      adaptiveRuntime: adaptiveRuntimeStub,
      discoveryManager: discoveryOfferingShell,
      strictToolNames: false,
      autoApproveToolCalls: true,
      dangerouslySkipPermissions: false,
      turnApprovalMode: 'off',
      defaultTenantId: undefined,
      workspaceAgentId: 'tools_allow_test',
      workspaceBaseDir,
      lazyTools: false,
      skillsPrompt: '',
      chatSecret: '',
      hitlManager: ctx.hitlManager,
      sessionTextLogger: { logTurn: async () => {} },
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      handleChatRoutes(req, res, url, deps).catch((err) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const body = JSON.stringify({ message: 'run id on the shell', autoClassify: false });
      const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: '/chat', method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
          },
        );
        req.on('error', reject);
        req.end(body);
      });

      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body).reply).toBe('done');
      expectRefusedAtDispatch(requests, shellExecute);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, LOAD_TIMEOUT_MS);
});
