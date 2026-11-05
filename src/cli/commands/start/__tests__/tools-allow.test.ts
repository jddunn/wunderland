// @ts-nocheck
/**
 * `tools.allow` in an agent config confines what `wunderland start` loads,
 * offers and runs, whatever the permission set, tool access profile and
 * execution mode say:
 *
 * - the loader loads only the packs the list names (in place of the default
 *   packs, the config's own extension lists and the credential
 *   recommendations) and keeps only the tools it names;
 * - a list that is not a list of names, or holds any entry that is not a
 *   name, allows nothing;
 * - `extensions_enable` refuses a pack outside the list with `tool_not_allowed`;
 * - each refusal writes one line through the logger, OTEL on or off, naming the
 *   tool or pack and `tool_not_allowed` and never the call's arguments, with
 *   bursts bounded (the line on real stdout is in
 *   `tools-allow.integration.test.ts`);
 * - a turn offers the model only the listed tools, and a call to any other
 *   tool, including one registered after start, is refused at dispatch with
 *   `tool_not_allowed` and never runs (a webhook wake, `runAgentTurn`; the
 *   channel and `POST /chat` paths are in `tools-allow.integration.test.ts`).
 *
 * The packs are the real curated `web-search` and `cli-executor` packs, loaded
 * through the extensions registry exactly as `start` loads them. The model is a
 * `fetch` stub answering OpenAI's chat-completions shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadExtensions } from '../extension-loader.js';
import { runAgentTurn } from '../agent-turn.js';
import { getPermissionsForSet, normalizeRuntimePolicy } from '../../../../runtime/tools/policy.js';
import { runToolCallingTurn } from '../../../../runtime/tools/tool-calling.js';
import { createSchemaOnDemandTools } from '../../../../runtime/execution/schema-on-demand.js';
import { logToolRefusal, resetToolRefusalLog } from '../../../../runtime/tools/tool-refusal-log.js';
import { resetLoggerFactory, setLoggerFactory } from '@framers/agentos';


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

  it('a tools.allow list with any entry that is not a name allows nothing of its kind', async () => {
    const ctx = await loadForConfig(
      unrestrictedAutonomousConfig({
        tools: { allow: { packs: ['web-search', 7], tools: ['web_search', ''] } },
      }),
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

  it('with toolFailureMode fail_closed, a refused call ends the turn without running', async () => {
    const shellExecute = vi.fn(async () => ({ success: true, output: 'uid=0(root)' }));
    const toolMap = new Map([
      ['web_search', { name: 'web_search', description: 'Search', inputSchema: { type: 'object' }, category: 'search', execute: vi.fn() }],
      ['shell_execute', { name: 'shell_execute', description: 'Shell', inputSchema: { type: 'object' }, category: 'system', hasSideEffects: true, execute: shellExecute }],
    ]);
    const requests = stubModelCallingShell({ shellOnly: true });

    const reply = await runToolCallingTurn({
      providerId: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-test',
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'run id' }],
      toolMap,
      allowedToolNames: ['web_search'],
      toolContext: {},
      maxRounds: 4,
      dangerouslySkipPermissions: true,
      askPermission: async () => true,
      toolFailureMode: 'fail_closed',
    });

    expect(reply).toBe('[tool_failure_mode=fail_closed] Tool not allowed: shell_execute.');
    expect(requests).toHaveLength(1);
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(['web_search']);
    expect(shellExecute).not.toHaveBeenCalled();
  });

  it('tool definitions the caller supplies (as discovery does) keep only the listed tools', async () => {
    const shellExecute = vi.fn(async () => ({ success: true, output: 'uid=0(root)' }));
    const toolMap = new Map([
      ['web_search', { name: 'web_search', description: 'Search', inputSchema: { type: 'object' }, category: 'search', execute: vi.fn() }],
      ['shell_execute', { name: 'shell_execute', description: 'Shell', inputSchema: { type: 'object' }, category: 'system', hasSideEffects: true, execute: shellExecute }],
    ]);
    const definition = (name: string) => ({
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    });
    const requests = stubModelCallingShell({ shellOnly: true });

    const reply = await runToolCallingTurn({
      providerId: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-test',
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'run id' }],
      toolMap,
      allowedToolNames: ['web_search'],
      // The shell first, as a discovery ranking would put it; a definition with no name is dropped too.
      getToolDefs: () => [definition('shell_execute'), definition('web_search'), { type: 'function', function: {} }],
      toolContext: {},
      maxRounds: 4,
      dangerouslySkipPermissions: true,
      askPermission: async () => true,
    });

    expect(reply).toBe('done');
    expect(requests).toHaveLength(2);
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(['web_search']);
    const refusal = requests[1].messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call-shell');
    expect(JSON.parse(refusal.content)).toEqual({ error: 'tool_not_allowed', tool: 'shell_execute' });
    expect(shellExecute).not.toHaveBeenCalled();
  });
});

describe('wunderland start: channel packs under tools.allow', () => {
  beforeEach(() => {
    // Activation asks Telegram about this token and fails, which `start` reports and
    // survives; the adapter is what is read here.
    setEnv('TELEGRAM_BOT_TOKEN', '12345:test-token');
  });

  it.each([
    ['an empty list', { allow: { packs: [], tools: [] } }, {}],
    ['a list that is not a list', { allow: { packs: 'web-search', tools: [] } }, {}],
    [
      'an extensions list the allow-list empties',
      { allow: { packs: ['web-search'], tools: [] } },
      { extensions: { tools: ['cli-executor'], voice: [], productivity: [] } },
    ],
  ])('with %s, the configured channel still loads and no tool is added', async (_label, tools, extra) => {
    const ctx = await loadForConfig(unrestrictedAutonomousConfig({
      channels: ['telegram'],
      tools,
      // Send-only: no polling loop to outlive the test.
      extensionOverrides: { 'channel-telegram': { options: { sendOnly: true } } },
      ...extra,
    }));
    try {
      expect(ctx.loadedChannelAdapters.map((adapter: any) => adapter.platform)).toEqual(['telegram']);
      expect(packNames(ctx)).toEqual(['@framers/agentos-ext-channel-telegram']);
      // The pack registers send tools; the list does not name them, so they stay out.
      expect(toolNames(ctx)).toEqual([]);
    } finally {
      await Promise.allSettled((ctx.activePacks ?? []).map((pack: any) => pack?.onDeactivate?.({ logger: console })));
    }
  }, LOAD_TIMEOUT_MS);

  it('with no channels configured, no channel pack loads', async () => {
    const ctx = await loadForConfig(unrestrictedAutonomousConfig({ tools: { allow: { packs: [], tools: [] } } }));

    expect(ctx.loadedChannelAdapters).toEqual([]);
    expect(packNames(ctx)).toEqual([]);
    expect(toolNames(ctx)).toEqual([]);
  }, LOAD_TIMEOUT_MS);
});

describe('wunderland start: the refusal log line', () => {
  /** Every call the logger received, as [level, message, fields]. */
  let lines: Array<[string, unknown, Record<string, unknown> | undefined]> = [];
  const canary = 'cat /etc/secret-canary --token=hunter2';
  const savedOtel: Record<string, string | undefined> = {};

  beforeEach(() => {
    lines = [];
    resetToolRefusalLog();
    for (const name of ['OTEL_ENABLED', 'WUNDERLAND_OTEL_ENABLED']) {
      savedOtel[name] = process.env[name];
      delete process.env[name];
    }
    const write = (level: string) => (message: unknown, fields?: Record<string, unknown>) => {
      lines.push([level, message, fields]);
    };
    setLoggerFactory(() => ({
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      fatal: write('fatal'),
      child() {
        return this;
      },
    }) as any);
  });

  afterEach(() => {
    resetLoggerFactory();
    resetToolRefusalLog();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries(savedOtel)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const refusalLines = () => lines.filter(([, message]) => message === 'tool_not_allowed');

  it('a call refused at dispatch with OTEL off writes one line naming the tool, never the arguments', async () => {
    const shellExecute = vi.fn(async () => ({ success: true, output: 'uid=0(root)' }));
    const replies = [
      {
        model: 'gpt-test',
        usage: {},
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call-shell', type: 'function', function: { name: 'shell_execute', arguments: JSON.stringify({ command: canary }) } }],
          },
        }],
      },
      { model: 'gpt-test', usage: {}, choices: [{ message: { role: 'assistant', content: 'done' } }] },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(replies.shift()) })));

    const reply = await runToolCallingTurn({
      providerId: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'run it' }],
      toolMap: new Map([
        ['shell_execute', { name: 'shell_execute', description: 'Shell', inputSchema: { type: 'object' }, category: 'system', hasSideEffects: true, execute: shellExecute }],
      ]),
      allowedToolNames: ['web_search'],
      toolContext: {},
      maxRounds: 4,
      dangerouslySkipPermissions: true,
      askPermission: async () => true,
    });

    expect(reply).toBe('done');
    expect(refusalLines()).toEqual([['warn', 'tool_not_allowed', { tool: 'shell_execute' }]]);
    expect(JSON.stringify(lines)).not.toContain('secret-canary');
    expect(JSON.stringify(lines)).not.toContain('hunter2');
    expect(shellExecute).not.toHaveBeenCalled();
  });

  it('a refused extensions_enable writes one line naming the pack, and nothing to the console', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tools = createSchemaOnDemandTools({
      toolMap: new Map(),
      runtimeDefaults: {} as any,
      allowedPackages: ['web-search'],
      logger: console,
    });
    const enable = tools.find((tool) => tool.name === 'extensions_enable');

    const result = await enable!.execute({ extension: 'cli-executor', options: { token: canary } }, {} as any);

    expect(result).toEqual({ success: false, error: 'tool_not_allowed' });
    expect(refusalLines()).toEqual([['warn', 'tool_not_allowed', { pack: 'cli-executor' }]]);
    expect(JSON.stringify(lines)).not.toContain('hunter2');
    expect(consoleWarn).not.toHaveBeenCalled();
  }, LOAD_TIMEOUT_MS);

  it('a name that is not a name is written as invalid, so a model cannot write into the log', () => {
    logToolRefusal({ kind: 'tool', name: `shell\n{"level":30,"msg":"forged"} ${canary}` });
    logToolRefusal({ kind: 'pack', name: 'x'.repeat(500) });

    expect(refusalLines()).toEqual([
      ['warn', 'tool_not_allowed', { tool: 'invalid' }],
      ['warn', 'tool_not_allowed', { pack: 'invalid' }],
    ]);
    expect(JSON.stringify(lines)).not.toContain('forged');
  });

  it('a burst for one name is bounded, and the next window says how many were left out', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    for (let i = 0; i < 100; i += 1) logToolRefusal({ kind: 'tool', name: 'shell_execute' });
    expect(refusalLines()).toHaveLength(5);
    expect(refusalLines().every(([, , fields]) => fields?.suppressed === undefined)).toBe(true);

    now += 60_001;
    logToolRefusal({ kind: 'tool', name: 'shell_execute' });

    expect(refusalLines()).toHaveLength(6);
    expect(refusalLines()[5]).toEqual(['warn', 'tool_not_allowed', { tool: 'shell_execute', suppressed: 95 }]);
  });

  it('a burst of new names is bounded too', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000);

    for (let i = 0; i < 500; i += 1) logToolRefusal({ kind: 'tool', name: `tool_${i}` });

    expect(refusalLines()).toHaveLength(50);
  });
});
