// @ts-nocheck
/**
 * `tools.allow` holds on the routes `wunderland start` serves: an inbound
 * channel message and `POST /chat` over a real HTTP server offer the model
 * only the listed tools, and a call to any other tool, including one
 * registered after start and one capability discovery ranks first, is refused
 * at dispatch with `tool_not_allowed` and never runs.
 *
 * The packs are the real curated `web-search` pack, loaded through the
 * extensions registry exactly as `start` loads it. The model is a `fetch` stub
 * answering OpenAI's chat-completions shape. The loader, `extensions_enable`
 * and webhook-wake cases are in `tools-allow.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadExtensions } from '../extension-loader.js';
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

let workspaceBaseDir = '';

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
 * `shell_execute` and (unless `shellOnly`) `extensions_enable`, the second
 * answers `done`. Returns the parsed request bodies the model received.
 */
function stubModelCallingShell({ shellOnly = false }: { shellOnly?: boolean } = {}): any[] {
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
            ...(shellOnly ? [] : [
              { id: 'call-enable', type: 'function', function: { name: 'extensions_enable', arguments: JSON.stringify({ extension: 'cli-executor' }) } },
            ]),
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
  workspaceBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-tools-allow-int-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(workspaceBaseDir, { recursive: true, force: true });
});

describe('wunderland start: tools.allow on the channel and POST /chat routes', () => {
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

/**
 * The refusal line as a host reads it: from the standard output of a process
 * that runs the built package under plain Node, with OTEL off and no logger set.
 * CI builds before this lane runs.
 */
describe('wunderland start: the refusal line on standard output', () => {
  const dist = path.resolve(__dirname, '../../../../../dist');
  const haveDist = existsSync(path.join(dist, 'runtime/tools/tool-calling.js'));

  it.skipIf(!haveDist && !process.env['CI'])('a refused call and a refused pack each write one JSON line', async () => {
    const script = `
      const { runToolCallingTurn } = await import(${JSON.stringify(path.join(dist, 'runtime/tools/tool-calling.js'))});
      const { createSchemaOnDemandTools } = await import(${JSON.stringify(path.join(dist, 'runtime/execution/schema-on-demand.js'))});
      const replies = [
        { model: 'm', usage: {}, choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'shell_execute', arguments: JSON.stringify({ command: 'cat secret-canary' }) } },
        ] } }] },
        { model: 'm', usage: {}, choices: [{ message: { role: 'assistant', content: 'done' } }] },
      ];
      globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(replies.shift()) });
      await runToolCallingTurn({
        providerId: 'openai', apiKey: 'sk-test', model: 'm',
        messages: [{ role: 'user', content: 'run it' }],
        toolMap: new Map([['shell_execute', { name: 'shell_execute', description: 'Shell', inputSchema: { type: 'object' }, category: 'system', hasSideEffects: true, execute: async () => ({ success: true }) }]]),
        allowedToolNames: ['web_search'],
        toolContext: {}, maxRounds: 4, dangerouslySkipPermissions: true, askPermission: async () => true,
      });
      const tools = createSchemaOnDemandTools({ toolMap: new Map(), runtimeDefaults: {}, allowedPackages: ['web-search'] });
      await tools.find((tool) => tool.name === 'extensions_enable').execute({ extension: 'cli-executor', options: { token: 'secret-canary' } }, {});
    `;
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
    for (const name of ['OTEL_ENABLED', 'WUNDERLAND_OTEL_ENABLED', 'AGENTOS_LOG_LEVEL', 'AGENTOS_DEBUG']) delete env[name];

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', script], { env, maxBuffer: 16 * 1024 * 1024 }, (error, out) => {
        if (error) reject(error);
        else resolve(out);
      });
    });

    const refusals = stdout
      .split('\n')
      .filter((line) => line.includes('tool_not_allowed'))
      .map((line) => JSON.parse(line));
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toMatchObject({ msg: 'tool_not_allowed', tool: 'shell_execute', level: 40 });
    expect(refusals[1]).toMatchObject({ msg: 'tool_not_allowed', pack: 'cli-executor', level: 40 });
    expect(stdout).not.toContain('secret-canary');
  }, LOAD_TIMEOUT_MS);
});
