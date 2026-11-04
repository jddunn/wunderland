// @ts-nocheck
/**
 * `wunderland start` posts the coarse events of each turn to `<url>/events`
 * when WUNDERLAND_EVENTS_URL and WUNDERLAND_EVENTS_TOKEN are set: names, counts,
 * codes and times, never text. A provider's 402 with `error.code`
 * `allowance_exhausted` ends the turn with the fixed line and no other request.
 *
 * The events server and the provider are real HTTP servers on 127.0.0.1, and
 * every turn runs the real request path: a channel message through
 * `handleInboundChannelMessage`, `POST /chat` through `handleChatRoutes`, and a
 * webhook's wake through `runAgentTurn`. `hosted-events.integration.test.ts`
 * runs the same path in a spawned `wunderland start`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createEventsReporter,
  createEventsReporterFromEnv,
  EVENTS_BATCH_LIMIT,
  EVENTS_FLUSH_INTERVAL_MS,
  EVENTS_QUEUE_LIMIT,
  EVENTS_TOKEN_ENV,
  EVENTS_URL_ENV,
} from '../hosted-events.js';
import { handleInboundChannelMessage, subscribeChannelAdapters } from '../channel-handler.js';
import { handleChatRoutes } from '../routes/chat.js';
import { runAgentTurn } from '../agent-turn.js';
import { getPermissionsForSet, normalizeRuntimePolicy } from '../../../../runtime/tools/policy.js';

/** The header the turn's operation id goes in; AGENTOS_OPERATION_ID_HEADER names it. */
const OP_HEADER = 'x-test-operation-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENTS_TOKEN = 'events-token-test';
const ALLOWANCE_LINE = 'This agent has reached its monthly model allowance.';

/** Words only a person, a model or a tool wrote. None may reach the events server. */
const USER_WORDS = 'USER-WORDS-the-person-typed';
const MODEL_WORDS = 'MODEL-WORDS-the-model-wrote';
const TOOL_ARG_WORDS = 'TOOL-ARG-WORDS-the-model-sent';
const TOOL_OUTPUT_WORDS = 'TOOL-OUTPUT-WORDS-the-tool-returned';
const ERROR_WORDS = 'ERROR-WORDS-the-provider-wrote';
const ALL_WORDS = [USER_WORDS, MODEL_WORDS, TOOL_ARG_WORDS, TOOL_OUTPUT_WORDS, ERROR_WORDS];

type Seen = { method: string; url: string; headers: Record<string, any>; raw: string; body: any };
type Scripted = { status: number; json: unknown };

/** Starts a recording HTTP server on 127.0.0.1. */
async function startFake(answerFor: (seen: Seen) => Scripted): Promise<{ server: Server; origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const entry: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        raw,
        body: raw ? JSON.parse(raw) : undefined,
      };
      seen.push(entry);
      const { status, json } = answerFor(entry);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, seen };
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** Waits on real time for a condition the server's side of a request settles. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let provider: Awaited<ReturnType<typeof startFake>>;
let eventsServer: Awaited<ReturnType<typeof startFake>>;
/** What the provider answers next, in order, whatever the path. */
let providerScript: Scripted[] = [];
/** The status the events server answers next; 202 once it runs out. */
let eventsStatuses: number[] = [];
let workspaceBaseDir = '';
let eventsUrl = '';
const savedEnv: Record<string, string | undefined> = {};
const reporters: Array<{ stop: () => Promise<void> }> = [];

/** A reporter that the test's teardown stops. */
function newReporter() {
  const reporter = createEventsReporter({ url: eventsUrl, token: EVENTS_TOKEN });
  reporters.push(reporter);
  return reporter;
}

const posted = () => eventsServer.seen.flatMap((request) => request.body.events);
const postedKinds = () => posted().map((event: any) => event.kind);

function expectNoTextReachedTheEventsServer(): void {
  for (const request of eventsServer.seen) {
    for (const words of ALL_WORDS) expect(request.raw).not.toContain(words);
    for (const event of request.body.events) {
      for (const key of Object.keys(event)) {
        expect(['kind', 'code', 'count', 'at', 'promptTokens', 'completionTokens', 'toolName']).toContain(key);
      }
    }
  }
}

/** An OpenAI-shaped answer. */
const chatAnswer = (message: Record<string, unknown>, usage: Record<string, number> = {}): Scripted => ({
  status: 200,
  json: { model: 'gpt-test', usage, choices: [{ message: { role: 'assistant', ...message } }] },
});
const toolCallAnswer = (usage: Record<string, number>, content: string | null = null): Scripted =>
  chatAnswer(
    {
      content,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'echo_words', arguments: JSON.stringify({ text: TOOL_ARG_WORDS }) },
      }],
    },
    usage,
  );
const textAnswer = (usage: Record<string, number> = {}): Scripted => chatAnswer({ content: MODEL_WORDS }, usage);
const allowanceRefusal = (extra: Record<string, unknown> = {}): Scripted => ({
  status: 402,
  json: { error: { code: 'allowance_exhausted', ...extra } },
});

function echoTool(over: Record<string, unknown> = {}) {
  return {
    name: 'echo_words',
    description: 'Echo words',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    category: 'productivity',
    hasSideEffects: false,
    execute: vi.fn(async () => ({ success: true, output: TOOL_OUTPUT_WORDS })),
    ...over,
  };
}

const adaptiveRuntimeStub = {
  resolveTurnDecision: () => ({ toolFailureMode: 'fail_open', degraded: false, reason: '', actions: {}, kpi: null }),
  recordTurnOutcome: async () => {},
};

/** The agent config every turn runs under: nothing stops a tool from running. */
const CFG = {
  seedId: 'events_test',
  permissionSet: 'unrestricted',
  toolAccessProfile: 'unrestricted',
  executionMode: 'autonomous',
};

/** What `start`'s phases leave on the context, for one Telegram adapter. */
function channelContext(over: Record<string, unknown> = {}) {
  const adapter = {
    platform: 'telegram',
    sendTypingIndicator: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
  };
  const policy = normalizeRuntimePolicy(CFG);
  const tool = echoTool();
  const ctx: any = {
    cfg: CFG,
    policy,
    permissions: getPermissionsForSet(policy.permissionSet),
    LOCAL_ONLY_CHANNELS: new Set(['webchat']),
    CLI_REQUIRED_CHANNELS: new Set(),
    pairingEnabled: false,
    pairingGroupTrigger: '!pair',
    pairingGroupTriggerEnabled: false,
    systemPrompt: 'SYS',
    channelSessions: new Map(),
    channelQueues: new Map(),
    channelUnsubs: [],
    discoveryManager: { discoverForTurn: async () => null },
    adaptiveRuntime: adaptiveRuntimeStub,
    defaultTenantId: '',
    toolMap: new Map([['echo_words', tool]]),
    canUseLLM: true,
    seed: { seedId: 'events_test' },
    seedId: 'events_test',
    providerId: 'openai',
    model: 'gpt-test',
    llmApiKey: 'sk-test',
    llmBaseUrl: `${provider.origin}/primary`,
    autoApproveToolCalls: true,
    dangerouslySkipPermissions: false,
    strictToolNames: false,
    turnApprovalMode: 'off',
    openrouterFallback: undefined,
    oauthGetApiKey: undefined,
    hitlManager: { requestApproval: vi.fn(async () => ({ approved: true })) },
    broadcastHitlUpdate: vi.fn(),
    workspaceAgentId: 'events_test',
    workspaceBaseDir,
    activePacks: [],
    adapterByPlatform: new Map([['telegram', adapter]]),
    ...over,
  };
  return { ctx, adapter, tool };
}

const inbound = (text = USER_WORDS) => ({
  platform: 'telegram',
  conversationId: 'chat-1',
  conversationType: 'direct',
  messageId: 'msg-1',
  text,
  sender: { id: 'user-1' },
});

const repliesOf = (adapter: any) =>
  adapter.sendMessage.mock.calls.map((call: any[]) => call[1]?.blocks?.[0]?.text);

beforeAll(async () => {
  provider = await startFake(() => providerScript.shift() ?? { status: 500, json: { error: { message: 'script ran out' } } });
  eventsServer = await startFake(() => ({ status: eventsStatuses.shift() ?? 202, json: { accepted: true } }));
  eventsUrl = `${eventsServer.origin}/hosted/agent`;
});

afterAll(async () => {
  await close(provider.server);
  await close(eventsServer.server);
});

beforeEach(async () => {
  provider.seen.length = 0;
  eventsServer.seen.length = 0;
  providerScript = [];
  eventsStatuses = [];
  workspaceBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-hosted-events-'));
  for (const name of ['AGENTOS_OPERATION_ID_HEADER', 'WUNDERLAND_USAGE_LEDGER_PATH', EVENTS_URL_ENV, EVENTS_TOKEN_ENV]) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.AGENTOS_OPERATION_ID_HEADER = OP_HEADER;
  // The turn's usage goes to the usage ledger too; keep it out of the home folder.
  process.env.WUNDERLAND_USAGE_LEDGER_PATH = path.join(workspaceBaseDir, 'usage.jsonl');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(reporters.splice(0).map((reporter) => reporter.stop()));
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(workspaceBaseDir, { recursive: true, force: true });
});

describe('a turn reports its events', () => {
  it('a channel turn posts turn_started, tool_called and turn_finished with its counts, and nothing with text', async () => {
    const reporter = newReporter();
    const { ctx, adapter, tool } = channelContext({ eventsReporter: reporter });
    providerScript = [
      toolCallAnswer({ prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 }),
      textAnswer({ prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 }),
    ];

    await handleInboundChannelMessage(ctx, inbound());
    await reporter.flush();

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(repliesOf(adapter)).toEqual([MODEL_WORDS]);
    expect(postedKinds()).toEqual(['turn_started', 'tool_called', 'turn_finished']);

    const [started, toolCalled, finished] = posted();
    expect(toolCalled.toolName).toBe('echo_words');
    expect(finished.promptTokens).toBe(24);
    expect(finished.completionTokens).toBe(7);
    for (const event of [started, toolCalled, finished]) {
      expect(typeof event.at).toBe('number');
      expect(Math.abs(Date.now() - event.at)).toBeLessThan(60_000);
    }
    expectNoTextReachedTheEventsServer();
  });

  it('posts to <url>/events with the bearer token and the turn\'s operation id', async () => {
    const reporter = newReporter();
    const { ctx } = channelContext({ eventsReporter: reporter });
    providerScript = [textAnswer({ prompt_tokens: 1, completion_tokens: 1 })];

    await handleInboundChannelMessage(ctx, inbound());
    await reporter.flush();

    expect(eventsServer.seen).toHaveLength(1);
    const [request] = eventsServer.seen;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/hosted/agent/events');
    expect(request.headers.authorization).toBe(`Bearer ${EVENTS_TOKEN}`);
    expect(request.headers['content-type']).toContain('application/json');
    expect(request.headers[OP_HEADER]).toMatch(UUID_RE);
  });

  it('two turns go out as two posts, each under its own operation id', async () => {
    const reporter = newReporter();
    const { ctx } = channelContext({ eventsReporter: reporter });
    providerScript = [textAnswer(), textAnswer()];

    await handleInboundChannelMessage(ctx, inbound());
    await handleInboundChannelMessage(ctx, inbound());
    await reporter.flush();

    expect(eventsServer.seen).toHaveLength(2);
    const [first, second] = eventsServer.seen;
    expect(first.headers[OP_HEADER]).not.toBe(second.headers[OP_HEADER]);
    for (const request of [first, second]) {
      expect(request.body.events.map((event: any) => event.kind)).toEqual(['turn_started', 'turn_finished']);
    }
  });

  it('an Anthropic turn reports its input and output tokens as the counts', async () => {
    const reporter = newReporter();
    const { ctx, adapter } = channelContext({
      eventsReporter: reporter,
      providerId: 'anthropic',
      model: 'claude-test',
      llmBaseUrl: `${provider.origin}/anthropic`,
    });
    providerScript = [{
      status: 200,
      json: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: MODEL_WORDS }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 21, output_tokens: 8 },
      },
    }];

    await handleInboundChannelMessage(ctx, inbound());
    await reporter.flush();

    expect(provider.seen[0].url).toBe('/anthropic/v1/messages');
    expect(repliesOf(adapter)).toEqual([MODEL_WORDS]);
    const finished = posted().find((event: any) => event.kind === 'turn_finished');
    expect(finished.promptTokens).toBe(21);
    expect(finished.completionTokens).toBe(8);
  });

  it('a tool that needs a person\'s word reports approval_requested and none of the arguments', async () => {
    const reporter = newReporter();
    const tool = echoTool({ hasSideEffects: true, category: 'communication' });
    const { ctx } = channelContext({
      eventsReporter: reporter,
      autoApproveToolCalls: false,
      toolMap: new Map([['echo_words', tool]]),
      policy: normalizeRuntimePolicy({ ...CFG, executionMode: 'human-all' }),
    });
    providerScript = [toolCallAnswer({ prompt_tokens: 1, completion_tokens: 1 }), textAnswer()];

    await handleInboundChannelMessage(ctx, inbound());
    await reporter.flush();

    expect(ctx.hitlManager.requestApproval).toHaveBeenCalled();
    expect(postedKinds()).toContain('approval_requested');
    expectNoTextReachedTheEventsServer();
  });

  it('a checkpoint that waits on a person reports approval_requested and none of the work', async () => {
    const reporter = newReporter();
    const checkpoint = vi.fn(async () => ({ decision: 'continue' }));
    const { ctx, adapter } = channelContext({
      eventsReporter: reporter,
      autoApproveToolCalls: false,
      turnApprovalMode: 'after-each-round',
      policy: normalizeRuntimePolicy({ ...CFG, executionMode: 'human-dangerous' }),
      hitlManager: { requestApproval: vi.fn(async () => ({ approved: true })), checkpoint, cancelRequest: vi.fn(async () => {}) },
    });
    providerScript = [toolCallAnswer({ prompt_tokens: 1, completion_tokens: 1 }), textAnswer()];

    await handleInboundChannelMessage(ctx, inbound());
    await reporter.flush();

    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(ctx.hitlManager.requestApproval).not.toHaveBeenCalled();
    expect(repliesOf(adapter)).toEqual([MODEL_WORDS]);
    expect(postedKinds()).toEqual(['turn_started', 'tool_called', 'approval_requested', 'turn_finished']);
    expectNoTextReachedTheEventsServer();
  });

  it('a provider failure that falls back reports provider_error with the status, and the turn goes on', async () => {
    const reporter = newReporter();
    const { ctx, adapter } = channelContext({
      eventsReporter: reporter,
      openrouterFallback: { apiKey: 'sk-fallback', model: 'fallback-model', baseUrl: `${provider.origin}/fallback` },
    });
    providerScript = [
      { status: 503, json: { error: { message: ERROR_WORDS } } },
      textAnswer({ prompt_tokens: 4, completion_tokens: 2 }),
    ];

    await handleInboundChannelMessage(ctx, inbound());
    await reporter.flush();

    expect(provider.seen.map((request) => request.url)).toEqual(['/primary/chat/completions', '/fallback/chat/completions']);
    expect(repliesOf(adapter)).toEqual([MODEL_WORDS]);
    expect(postedKinds()).toEqual(['turn_started', 'provider_error', 'turn_finished']);
    expect(posted()[1].code).toBe('503');
    expect(posted()[2].promptTokens).toBe(4);
    expectNoTextReachedTheEventsServer();
  });

  it('a failed turn still reports turn_finished, and the failure stays the caller\'s', async () => {
    const reporter = newReporter();
    const { ctx, adapter } = channelContext({ eventsReporter: reporter });
    providerScript = [{ status: 500, json: { error: { message: ERROR_WORDS } } }];

    await expect(handleInboundChannelMessage(ctx, inbound())).rejects.toThrow(/500/);
    await reporter.flush();

    expect(repliesOf(adapter)).toEqual([]);
    expect(postedKinds()).toEqual(['turn_started', 'provider_error', 'turn_finished']);
    expect(posted()[1].code).toBe('500');
    expectNoTextReachedTheEventsServer();
  });

  it('POST /chat reports the same events', async () => {
    const reporter = newReporter();
    const answer = await postChat({ eventsReporter: reporter }, [
      toolCallAnswer({ prompt_tokens: 3, completion_tokens: 1 }),
      textAnswer({ prompt_tokens: 5, completion_tokens: 2 }),
    ]);
    await reporter.flush();

    expect(answer.status).toBe(200);
    expect(answer.body.reply).toBe(MODEL_WORDS);
    expect(postedKinds()).toEqual(['turn_started', 'tool_called', 'turn_finished']);
    expect(posted()[2].promptTokens).toBe(8);
    expect(posted()[2].completionTokens).toBe(3);
    expectNoTextReachedTheEventsServer();
  });

  it('a turn a webhook wakes reports the same events', async () => {
    const reporter = newReporter();
    const { ctx } = channelContext();
    providerScript = [
      toolCallAnswer({ prompt_tokens: 2, completion_tokens: 1 }),
      textAnswer({ prompt_tokens: 3, completion_tokens: 1 }),
    ];

    const result = await runAgentTurn(
      { ...ctx, sessions: new Map(), activePersonaId: 'default', eventsReporter: reporter, autoApproveToolCalls: true },
      { sessionId: 'webhook:one', message: USER_WORDS, source: 'webhook:one' },
    );
    await reporter.flush();

    expect(result).toMatchObject({ reply: MODEL_WORDS, failed: false, toolCallCount: 1 });
    expect(postedKinds()).toEqual(['turn_started', 'tool_called', 'turn_finished']);
    expect(posted()[1].toolName).toBe('echo_words');
    expect(posted()[2].promptTokens).toBe(5);
    expectNoTextReachedTheEventsServer();
  });
});

describe('without both variables nothing is posted', () => {
  it('no reporter exists when either variable is unset or blank', () => {
    expect(createEventsReporterFromEnv({})).toBeUndefined();
    expect(createEventsReporterFromEnv({ [EVENTS_URL_ENV]: eventsUrl })).toBeUndefined();
    expect(createEventsReporterFromEnv({ [EVENTS_TOKEN_ENV]: EVENTS_TOKEN })).toBeUndefined();
    expect(createEventsReporterFromEnv({ [EVENTS_URL_ENV]: '  ', [EVENTS_TOKEN_ENV]: EVENTS_TOKEN })).toBeUndefined();
    expect(createEventsReporterFromEnv({ [EVENTS_URL_ENV]: eventsUrl, [EVENTS_TOKEN_ENV]: '  ' })).toBeUndefined();
  });

  it('a value that is no URL makes no reporter and says so, without the token', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createEventsReporterFromEnv({ [EVENTS_URL_ENV]: 'not a url', [EVENTS_TOKEN_ENV]: EVENTS_TOKEN })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(EVENTS_URL_ENV);
    expect(String(warn.mock.calls[0][0])).not.toContain(EVENTS_TOKEN);
  });

  it('with both set, the reporter posts to the URL with the token', async () => {
    const reporter = createEventsReporterFromEnv({ [EVENTS_URL_ENV]: `${eventsUrl}/`, [EVENTS_TOKEN_ENV]: ` ${EVENTS_TOKEN} ` });
    reporters.push(reporter);

    reporter.report('referral_sent');
    await reporter.flush();

    expect(eventsServer.seen[0].url).toBe('/hosted/agent/events');
    expect(eventsServer.seen[0].headers.authorization).toBe(`Bearer ${EVENTS_TOKEN}`);
    expect(postedKinds()).toEqual(['referral_sent']);
  });

  it('a turn with no reporter runs as before and posts nothing', async () => {
    const { ctx, adapter } = channelContext();
    providerScript = [textAnswer({ prompt_tokens: 1, completion_tokens: 1 })];

    await handleInboundChannelMessage(ctx, inbound());

    expect(repliesOf(adapter)).toEqual([MODEL_WORDS]);
    expect(eventsServer.seen).toHaveLength(0);
  });
});

describe('a 402 allowance_exhausted ends the turn', () => {
  it('the channel gets the fixed line, the provider sees one request and no fallback runs', async () => {
    const reporter = newReporter();
    const { ctx, adapter } = channelContext({
      eventsReporter: reporter,
      openrouterFallback: { apiKey: 'sk-fallback', model: 'fallback-model', baseUrl: `${provider.origin}/fallback` },
    });
    providerScript = [allowanceRefusal(), textAnswer()];

    await handleInboundChannelMessage(ctx, inbound());
    await reporter.flush();

    expect(provider.seen.map((request) => request.url)).toEqual(['/primary/chat/completions']);
    expect(repliesOf(adapter)).toEqual([ALLOWANCE_LINE]);
    expect(postedKinds()).toEqual(['turn_started', 'provider_error', 'turn_finished']);
    expect(posted()[1].code).toBe('402');
    expectNoTextReachedTheEventsServer();
  });

  it('a number in the refusal\'s body that a fallback would read as a retryable status changes nothing', async () => {
    const { ctx, adapter } = channelContext({
      openrouterFallback: { apiKey: 'sk-fallback', model: 'fallback-model', baseUrl: `${provider.origin}/fallback` },
    });
    providerScript = [allowanceRefusal({ message: 'resets on day 503' }), textAnswer()];

    await handleInboundChannelMessage(ctx, inbound());

    expect(provider.seen).toHaveLength(1);
    expect(repliesOf(adapter)).toEqual([ALLOWANCE_LINE]);
  });

  it('the same on an Anthropic turn, in Anthropic\'s error shape', async () => {
    const { ctx, adapter } = channelContext({
      providerId: 'anthropic',
      model: 'claude-test',
      llmBaseUrl: `${provider.origin}/anthropic`,
    });
    providerScript = [{ status: 402, json: { type: 'error', error: { code: 'allowance_exhausted', type: 'billing_error' } } }];

    await handleInboundChannelMessage(ctx, inbound());

    expect(provider.seen).toHaveLength(1);
    expect(repliesOf(adapter)).toEqual([ALLOWANCE_LINE]);
  });

  it('mid-turn, the reply keeps what the model gave so far, then the line', async () => {
    const reporter = newReporter();
    const { ctx, adapter, tool } = channelContext({ eventsReporter: reporter });
    providerScript = [
      toolCallAnswer({ prompt_tokens: 9, completion_tokens: 4 }, MODEL_WORDS),
      allowanceRefusal(),
      textAnswer(),
    ];

    await handleInboundChannelMessage(ctx, inbound());
    await reporter.flush();

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(provider.seen).toHaveLength(2);
    expect(repliesOf(adapter)).toEqual([`${MODEL_WORDS}\n\n${ALLOWANCE_LINE}`]);
    expect(postedKinds()).toEqual(['turn_started', 'tool_called', 'provider_error', 'turn_finished']);
    expect(posted()[3].promptTokens).toBe(9);
    expect(posted()[3].completionTokens).toBe(4);
  });

  it('the session keeps a well-formed history that ends with the line', async () => {
    const { ctx } = channelContext();
    providerScript = [allowanceRefusal()];

    await handleInboundChannelMessage(ctx, inbound());

    const history = ctx.channelSessions.get('telegram:chat-1');
    expect(history.at(-1)).toEqual({ role: 'assistant', content: ALLOWANCE_LINE });
  });

  it('POST /chat answers 200 with the line', async () => {
    const answer = await postChat({}, [allowanceRefusal(), textAnswer()]);

    expect(answer.status).toBe(200);
    expect(answer.body.reply).toBe(ALLOWANCE_LINE);
    expect(provider.seen).toHaveLength(1);
  });

  it('a turn a webhook wakes ends with the line and is not a failure', async () => {
    const { ctx } = channelContext();
    providerScript = [allowanceRefusal(), textAnswer()];

    const result = await runAgentTurn(
      { ...ctx, sessions: new Map(), activePersonaId: 'default' },
      { sessionId: 'webhook:one', message: USER_WORDS, source: 'webhook:one' },
    );

    expect(result).toMatchObject({ reply: ALLOWANCE_LINE, failed: false });
    expect(provider.seen).toHaveLength(1);
  });

  it('a 402 with any other code stays an ordinary provider error', async () => {
    const reporter = newReporter();
    const { ctx, adapter } = channelContext({ eventsReporter: reporter });
    providerScript = [{ status: 402, json: { error: { code: 'insufficient_quota', message: ERROR_WORDS } } }];

    await expect(handleInboundChannelMessage(ctx, inbound())).rejects.toThrow(/402/);
    await reporter.flush();

    expect(repliesOf(adapter)).toEqual([]);
    expect(posted().find((event: any) => event.kind === 'provider_error').code).toBe('402');
  });

  it('another status carrying the code stays an ordinary provider error', async () => {
    const { ctx, adapter } = channelContext();
    providerScript = [{ status: 500, json: { error: { code: 'allowance_exhausted' } } }];

    await expect(handleInboundChannelMessage(ctx, inbound())).rejects.toThrow(/500/);

    expect(repliesOf(adapter)).toEqual([]);
  });
});

describe('a channel reports a rejected token', () => {
  /** An adapter whose handlers the test calls with channel events. */
  function emittingAdapter() {
    const handlers = new Map();
    return {
      platform: 'telegram',
      on: (handler: any, types: string[]) => {
        handlers.set(handler, types);
        return () => handlers.delete(handler);
      },
      emit: async (event: any) => {
        for (const [handler, types] of handlers) {
          if (!types || types.includes(event.type)) await handler(event);
        }
      },
      subscribedTypes: () => [...handlers.values()].flat(),
    };
  }

  it('a channel error event with code auth_failed posts channel_auth_failed naming the platform', async () => {
    const reporter = newReporter();
    const adapter = emittingAdapter();
    const { ctx } = channelContext({ eventsReporter: reporter, adapterByPlatform: new Map([['telegram', adapter]]) });

    subscribeChannelAdapters(ctx);
    await adapter.emit({ type: 'error', platform: 'telegram', conversationId: '', timestamp: '', data: { code: 'auth_failed' } });
    await adapter.emit({ type: 'error', platform: 'telegram', conversationId: '', timestamp: '', data: { code: 'rate_limited', detail: ERROR_WORDS } });
    await reporter.flush();

    expect(postedKinds()).toEqual(['channel_auth_failed']);
    expect(posted()[0].code).toBe('telegram');
    expectNoTextReachedTheEventsServer();
  });

  it('without a reporter the adapter gets its message subscription alone', () => {
    const adapter = emittingAdapter();
    const { ctx } = channelContext({ adapterByPlatform: new Map([['telegram', adapter]]) });

    subscribeChannelAdapters(ctx);

    expect(adapter.subscribedTypes()).toEqual(['message']);
  });
});

describe('the reporter', () => {
  it('holds events until the flush interval, then posts them in one batch', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const reporter = newReporter();

    reporter.report('turn_started');
    reporter.report('turn_finished', { promptTokens: 1, completionTokens: 1 });
    vi.advanceTimersByTime(EVENTS_FLUSH_INTERVAL_MS - 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(eventsServer.seen).toHaveLength(0);

    vi.advanceTimersByTime(1);
    await until(() => eventsServer.seen.length === 1, 'the batch');
    expect(postedKinds()).toEqual(['turn_started', 'turn_finished']);
  });

  it('posts nothing when no event waits', async () => {
    const reporter = newReporter();
    await reporter.flush();
    expect(eventsServer.seen).toHaveLength(0);
  });

  it('past the queue limit it drops the oldest events and posts at most the batch limit each time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reporter = newReporter();
    const extra = 5;

    for (let i = 0; i < EVENTS_QUEUE_LIMIT + extra; i += 1) {
      reporter.report('tool_called', { count: i });
    }
    await reporter.flush();

    const counts = posted().map((event: any) => event.count);
    expect(counts).toHaveLength(EVENTS_QUEUE_LIMIT);
    expect(counts[0]).toBe(extra);
    expect(counts.at(-1)).toBe(EVENTS_QUEUE_LIMIT + extra - 1);
    for (const request of eventsServer.seen) {
      expect(request.body.events.length).toBeLessThanOrEqual(EVENTS_BATCH_LIMIT);
    }
    expect(eventsServer.seen.length).toBe(Math.ceil(EVENTS_QUEUE_LIMIT / EVENTS_BATCH_LIMIT));
    expect(warn.mock.calls.some((call) => String(call[0]).includes(String(extra)))).toBe(true);
  });

  it('keeps a batch the server could not take and sends it on the next flush', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reporter = newReporter();
    eventsStatuses = [503, 429];

    reporter.report('turn_started');
    await reporter.flush();
    await reporter.flush();
    await reporter.flush();

    expect(eventsServer.seen).toHaveLength(3);
    expect(eventsServer.seen[2].raw).toBe(eventsServer.seen[0].raw);
    await reporter.flush();
    expect(eventsServer.seen).toHaveLength(3);
    expect(warn).toHaveBeenCalled();
  });

  it('keeps a batch when the server is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = await startFake(() => ({ status: 202, json: {} }));
    const { origin } = down;
    await close(down.server);
    const reporter = createEventsReporter({ url: origin, token: EVENTS_TOKEN });
    reporters.push(reporter);

    reporter.report('turn_started');
    await reporter.flush();

    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(EVENTS_TOKEN);
  });

  it('drops a batch the server refuses and says so, without the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reporter = newReporter();
    eventsStatuses = [401];

    reporter.report('turn_started');
    await reporter.flush();
    await reporter.flush();

    expect(eventsServer.seen).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('401');
    expect(String(warn.mock.calls[0][0])).not.toContain(EVENTS_TOKEN);
  });

  it('writes one warning line a minute at most, however many posts fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reporter = newReporter();
    eventsStatuses = [401, 401, 401];

    for (let i = 0; i < 3; i += 1) {
      reporter.report('turn_started');
      await reporter.flush();
    }

    expect(eventsServer.seen).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sends no operation id header when AGENTOS_OPERATION_ID_HEADER is unset, and no id of its own for an event outside a turn', async () => {
    delete process.env.AGENTOS_OPERATION_ID_HEADER;
    const withoutName = newReporter();
    withoutName.report('turn_started', undefined, 'op-1');
    await withoutName.flush();
    expect(eventsServer.seen[0].headers[OP_HEADER]).toBeUndefined();

    process.env.AGENTOS_OPERATION_ID_HEADER = OP_HEADER;
    const named = newReporter();
    named.report('channel_auth_failed', { code: 'telegram' });
    named.report('turn_started', undefined, 'op-2');
    await named.flush();
    expect(eventsServer.seen[1].headers[OP_HEADER]).toBeUndefined();
    expect(eventsServer.seen[2].headers[OP_HEADER]).toBe('op-2');
  });

  it('a header name that is no HTTP field name costs the header, not the events', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AGENTOS_OPERATION_ID_HEADER = 'not a header';
    const reporter = newReporter();

    reporter.report('turn_started', undefined, 'op-1');
    await reporter.flush();

    expect(postedKinds()).toEqual(['turn_started']);
    expect(warn).toHaveBeenCalled();
  });

  it('passes only known kinds and the known fields, and a field that could hold text only as a single word', async () => {
    const reporter = newReporter();

    reporter.report('free_text', { code: 'x' });
    reporter.report('tool_called', { toolName: `${ALL_WORDS[0]} and more words`, text: ALL_WORDS[1] });
    reporter.report('provider_error', { code: ALL_WORDS[4].replace(/-/g, ' ') });
    reporter.report('provider_error', { code: 503 });
    reporter.report('turn_finished', { promptTokens: -1, completionTokens: 2.5, count: 'many' });
    reporter.report('tool_called', { toolName: 'web_search' });
    await reporter.flush();

    expect(posted().map(({ at: _at, ...event }: any) => event)).toEqual([
      { kind: 'tool_called' },
      { kind: 'provider_error' },
      { kind: 'provider_error', code: '503' },
      { kind: 'turn_finished' },
      { kind: 'tool_called', toolName: 'web_search' },
    ]);
    expectNoTextReachedTheEventsServer();
  });

  it('stop sends what waits, ends the interval and takes no more events', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const reporter = newReporter();

    reporter.report('turn_finished', { promptTokens: 2, completionTokens: 1 });
    await reporter.stop();
    expect(postedKinds()).toEqual(['turn_finished']);

    reporter.report('turn_started');
    vi.advanceTimersByTime(EVENTS_FLUSH_INTERVAL_MS * 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(eventsServer.seen).toHaveLength(1);
  });

  it('stop does not wait on an events server that never answers', async () => {
    const hanging = createServer(() => { /* never answers */ });
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', () => resolve()));
    const { port } = hanging.address() as AddressInfo;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reporter = createEventsReporter({ url: `http://127.0.0.1:${port}`, token: EVENTS_TOKEN });

    reporter.report('turn_started');
    const stopped = Date.now();
    await reporter.stop();

    expect(Date.now() - stopped).toBeLessThan(EVENTS_FLUSH_INTERVAL_MS);
    hanging.closeAllConnections?.();
    await close(hanging);
  });
});

/** Runs one `POST /chat` through the route over a real server, on the scripted provider. */
async function postChat(
  over: Record<string, unknown>,
  script: Scripted[],
): Promise<{ status: number; body: any }> {
  providerScript = script;
  const { ctx } = channelContext();
  const deps: any = {
    ...ctx,
    displayName: 'Events Test',
    activePersonaId: 'default',
    availablePersonas: [],
    rawAgentConfig: CFG,
    globalConfig: {},
    configDir: workspaceBaseDir,
    sessions: new Map(),
    lazyTools: false,
    skillsPrompt: '',
    chatSecret: '',
    defaultTenantId: undefined,
    sessionTextLogger: { logTurn: async () => {} },
    ...over,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    handleChatRoutes(req, res, url, deps).catch((err) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: USER_WORDS, autoClassify: false }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await close(server);
  }
}
