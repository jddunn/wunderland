// @ts-nocheck
/**
 * `hitl.mode: "remote"` in `wunderland start`: an outward tool asks a server
 * before it runs. `POST <url>/approvals` makes the request, `GET
 * <url>/approvals/:id` reads the answer; a yes runs the tool, anything else ends
 * the turn with the word and the tool never runs. With either events variable
 * missing, every outward tool is refused `approval_unavailable`.
 *
 * The approvals server and the provider are real HTTP servers on 127.0.0.1, and
 * every turn runs the real request path: a channel message through
 * `handleInboundChannelMessage`, `POST /chat` through `handleChatRoutes`, and a
 * webhook's wake through `runAgentTurn`. `remote-approvals.integration.test.ts`
 * runs the same path in a spawned `wunderland start`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  APPROVAL_UNAVAILABLE,
  REMOTE_APPROVAL_TEXT_LIMIT,
  createRemoteApprovalHandler,
  describeAction,
  isOutwardAction,
} from '../remote-approvals.js';
import { EVENTS_TOKEN_ENV, EVENTS_URL_ENV, createEventsReporter } from '../hosted-events.js';
import { setupLlmProvider } from '../llm-provider-setup.js';
import { handleInboundChannelMessage } from '../channel-handler.js';
import { handleChatRoutes } from '../routes/chat.js';
import { runAgentTurn } from '../agent-turn.js';
import { runToolCallingTurn } from '../../../../runtime/tools/tool-calling.js';
import { getPermissionsForSet, normalizeRuntimePolicy } from '../../../../runtime/tools/policy.js';

const TOKEN = 'approvals-token-test';
const OP_HEADER = 'x-test-operation-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APPROVAL_ID = 'apr-1';

/** Words only the model wrote into a tool's arguments. */
const ACTION_WORDS = 'ACTION-WORDS-what-would-be-sent';
const USER_WORDS = 'USER-WORDS-the-person-typed';
const MODEL_WORDS = 'MODEL-WORDS-the-model-wrote';

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

let provider: Awaited<ReturnType<typeof startFake>>;
let approvals: Awaited<ReturnType<typeof startFake>>;
let approvalsUrl = '';
/** What the provider answers next, in order. */
let providerScript: Scripted[] = [];
/** What `POST /approvals` answers. */
let postAnswer: Scripted = { status: 201, json: { id: APPROVAL_ID, state: 'waiting' } };
/** What `GET /approvals/:id` answers, in order; the last one repeats. */
let pollScript: Scripted[] = [];
let workspaceBaseDir = '';
const savedEnv: Record<string, string | undefined> = {};
const reporters: Array<{ stop: () => Promise<void> }> = [];

const state = (word: string): Scripted => ({ status: 200, json: { id: APPROVAL_ID, state: word } });

const requests = () => approvals.seen.filter((r) => r.method === 'POST' && r.url.endsWith('/approvals'));
const polls = () => approvals.seen.filter((r) => r.method === 'GET');

/** A handler on the fake server that does not make a test wait five seconds a poll. */
function newHandler({ waitMs = 5_000, pollMs = 5 }: { waitMs?: number; pollMs?: number } = {}) {
  return createRemoteApprovalHandler({ url: approvalsUrl, token: TOKEN, waitMs, pollMs });
}

const REQUEST = {
  toolName: 'sendMessage',
  action: { summary: 'sendMessage to chat-2', text: ACTION_WORDS },
  operationId: 'op-1',
};

/** An OpenAI-shaped answer. */
const chatAnswer = (message: Record<string, unknown>): Scripted => ({
  status: 200,
  json: { model: 'gpt-test', usage: {}, choices: [{ message: { role: 'assistant', ...message } }] },
});
const textAnswer = (content = MODEL_WORDS): Scripted => chatAnswer({ content });
const toolCallsAnswer = (
  calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>,
  content: string | null = null,
): Scripted =>
  chatAnswer({
    content,
    tool_calls: calls.map((call, index) => ({
      id: call.id ?? `call-${index + 1}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
  });

/** The model asks to send to a chat this conversation did not come from. */
const sendToAnotherChat = (content: string | null = null): Scripted =>
  toolCallsAnswer([{ name: 'sendMessage', args: { chatId: 'chat-2', text: ACTION_WORDS } }], content);

function outwardTool(over: Record<string, unknown> = {}) {
  return {
    name: 'sendMessage',
    description: 'Send a message to a chat',
    inputSchema: { type: 'object', properties: { chatId: { type: 'string' }, text: { type: 'string' } } },
    category: 'communication',
    hasSideEffects: true,
    execute: vi.fn(async () => ({ success: true, output: { sent: true } })),
    ...over,
  };
}

function readTool(over: Record<string, unknown> = {}) {
  return {
    name: 'read_history',
    description: 'Read a chat',
    inputSchema: { type: 'object', properties: { chatId: { type: 'string' } } },
    category: 'communication',
    hasSideEffects: false,
    execute: vi.fn(async () => ({ success: true, output: { messages: [] } })),
    ...over,
  };
}

const adaptiveRuntimeStub = {
  resolveTurnDecision: () => ({ toolFailureMode: 'fail_open', degraded: false, reason: '', actions: {}, kpi: null }),
  recordTurnOutcome: async () => {},
};

const CFG = {
  seedId: 'approvals_test',
  permissionSet: 'unrestricted',
  toolAccessProfile: 'unrestricted',
  executionMode: 'autonomous',
};

/** What `start`'s phases leave on the context, for one Telegram adapter and the tools given. */
function channelContext(tools: any[], over: Record<string, unknown> = {}) {
  const adapter = {
    platform: 'telegram',
    sendTypingIndicator: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
  };
  const policy = normalizeRuntimePolicy(CFG);
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
    toolMap: new Map(tools.map((tool) => [tool.name, tool])),
    canUseLLM: true,
    seed: { seedId: 'approvals_test' },
    seedId: 'approvals_test',
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
    workspaceAgentId: 'approvals_test',
    workspaceBaseDir,
    activePacks: [],
    adapterByPlatform: new Map([['telegram', adapter]]),
    ...over,
  };
  return { ctx, adapter };
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

/** Runs one `POST /chat` through the route over a real server. */
async function postChat(tools: any[], over: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const { ctx } = channelContext(tools);
  const deps: any = {
    ...ctx,
    displayName: 'Approvals Test',
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

/** Runs `start`'s provider phase on the given agent config and the current environment. */
async function startPhase(cfg: Record<string, unknown>): Promise<any> {
  const ctx: any = {
    flags: { provider: 'openai' },
    globals: { autoApproveTools: false },
    cfg,
    policy: { executionMode: 'autonomous' },
    seedId: 'approvals_test',
    globalConfig: {},
  };
  expect(await setupLlmProvider(ctx)).toBe(true);
  return ctx;
}

beforeAll(async () => {
  provider = await startFake(() => providerScript.shift() ?? { status: 500, json: { error: { message: 'script ran out' } } });
  approvals = await startFake((seen) => {
    if (seen.method === 'POST' && seen.url.endsWith('/approvals')) return postAnswer;
    if (seen.method === 'POST') return { status: 202, json: { accepted: true } };
    const next = pollScript.length > 1 ? pollScript.shift()! : pollScript[0];
    return next ?? state('waiting');
  });
  approvalsUrl = `${approvals.origin}/hosted/agent`;
});

afterAll(async () => {
  await close(provider.server);
  await close(approvals.server);
});

beforeEach(async () => {
  provider.seen.length = 0;
  approvals.seen.length = 0;
  providerScript = [];
  pollScript = [];
  postAnswer = { status: 201, json: { id: APPROVAL_ID, state: 'waiting' } };
  workspaceBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-remote-approvals-'));
  for (const name of [
    'AGENTOS_OPERATION_ID_HEADER',
    'WUNDERLAND_USAGE_LEDGER_PATH',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENROUTER_API_KEY',
    'WUNDERLAND_WORKSPACE_DIR',
    EVENTS_URL_ENV,
    EVENTS_TOKEN_ENV,
  ]) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.AGENTOS_OPERATION_ID_HEADER = OP_HEADER;
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.WUNDERLAND_USAGE_LEDGER_PATH = path.join(workspaceBaseDir, 'usage.jsonl');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(reporters.splice(0).map((reporter) => reporter.stop()));
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(workspaceBaseDir, { recursive: true, force: true });
});

describe('createRemoteApprovalHandler', () => {
  it('posts the tool name, the action and the operation id with the token, then polls the id it got', async () => {
    pollScript = [state('approved')];

    await newHandler()(REQUEST);

    expect(requests()).toHaveLength(1);
    const [post] = requests();
    expect(post.url).toBe('/hosted/agent/approvals');
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post.headers[OP_HEADER]).toBe('op-1');
    expect(post.body).toEqual(REQUEST);
    expect(polls()[0].url).toBe(`/hosted/agent/approvals/${APPROVAL_ID}`);
    expect(polls()[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('answers approve once the server says approved, and says when the request is in', async () => {
    pollScript = [state('waiting'), state('waiting'), state('approved')];
    const onWaiting = vi.fn();

    const decision = await newHandler()(REQUEST, { onWaiting });

    expect(decision).toEqual({ decision: 'approve', approved: true });
    expect(polls()).toHaveLength(3);
    expect(onWaiting).toHaveBeenCalledOnce();
  });

  it.each(['declined', 'expired', 'withdrawn'])('answers abort with the word when the server says %s', async (word) => {
    pollScript = [state('waiting'), state(word)];

    await expect(newHandler()(REQUEST)).resolves.toEqual({ decision: 'abort', approved: false, reason: word });
  });

  it('no answer in waitMs answers abort with expired', async () => {
    pollScript = [state('waiting')];
    const started = Date.now();

    const decision = await newHandler({ waitMs: 60, pollMs: 10 })(REQUEST);

    expect(decision).toEqual({ decision: 'abort', approved: false, reason: 'expired' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(polls().length).toBeGreaterThan(1);
  });

  it('reads the answer one last time at the deadline, so a late yes still counts', async () => {
    pollScript = [state('waiting'), state('approved')];

    const decision = await newHandler({ waitMs: 30, pollMs: 60_000 })(REQUEST);

    expect(decision).toEqual({ decision: 'approve', approved: true });
    expect(polls()).toHaveLength(2);
  });

  it.each([
    ['a state it does not know', { status: 200, json: { state: 'APPROVED' } }],
    ['no state', { status: 200, json: {} }],
    ['a true flag instead of a state', { status: 200, json: { approved: true } }],
    ['a body that is not JSON text it can read', { status: 200, json: 'approved' }],
  ])('%s never counts as a yes', async (_what, answer) => {
    pollScript = [answer];

    const decision = await newHandler({ waitMs: 30, pollMs: 5 })(REQUEST);

    expect(decision).toEqual({ decision: 'abort', approved: false, reason: 'expired' });
  });

  it.each([401, 403, 404, 422, 429, 500, 503])('a %i on the request answers approval_unavailable and polls nothing', async (status) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    postAnswer = { status, json: { error: { code: 'refused' } } };

    await expect(newHandler()(REQUEST)).resolves.toEqual({
      decision: 'abort',
      approved: false,
      reason: APPROVAL_UNAVAILABLE,
    });
    expect(polls()).toEqual([]);
  });

  it.each([
    ['no id', { status: 201, json: { state: 'waiting' } }],
    ['an id that is not a string', { status: 201, json: { id: 7 } }],
    ['an empty id', { status: 201, json: { id: '' } }],
  ])('a request answered with %s answers approval_unavailable', async (_what, answer) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    postAnswer = answer;
    const onWaiting = vi.fn();

    await expect(newHandler()(REQUEST, { onWaiting })).resolves.toMatchObject({ reason: APPROVAL_UNAVAILABLE });
    expect(polls()).toEqual([]);
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('a server that is not there answers approval_unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gone = createServer();
    await new Promise<void>((resolve) => gone.listen(0, '127.0.0.1', () => resolve()));
    const { port } = gone.address() as AddressInfo;
    await close(gone);

    const handler = createRemoteApprovalHandler({ url: `http://127.0.0.1:${port}`, token: TOKEN, waitMs: 1_000 });

    await expect(handler(REQUEST)).resolves.toMatchObject({ reason: APPROVAL_UNAVAILABLE });
  });

  it.each([401, 403, 404, 410])('a %i on a poll answers approval_unavailable at once: the token or the row is gone', async (status) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    pollScript = [state('waiting'), { status, json: { error: { code: 'gone' } } }, state('approved')];

    await expect(newHandler()(REQUEST)).resolves.toMatchObject({ reason: APPROVAL_UNAVAILABLE });
    expect(polls()).toHaveLength(2);
  });

  it.each([429, 500, 502, 503])('a %i on a poll keeps waiting, and a later yes counts', async (status) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    pollScript = [{ status, json: {} }, state('waiting'), state('approved')];

    await expect(newHandler()(REQUEST)).resolves.toEqual({ decision: 'approve', approved: true });
  });

  it('does not cut short a poll the server holds open past the poll interval', async () => {
    const held = createServer((req, res) => {
      req.resume();
      if (req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: APPROVAL_ID }));
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ state: 'approved' }));
      }, 200);
    });
    await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', () => resolve()));
    const { port } = held.address() as AddressInfo;

    const handler = createRemoteApprovalHandler({ url: `http://127.0.0.1:${port}`, token: TOKEN, waitMs: 5_000, pollMs: 5 });

    await expect(handler(REQUEST)).resolves.toEqual({ decision: 'approve', approved: true });
    await close(held);
  });

  it('writes neither the token nor the action to the log, whatever goes wrong', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    postAnswer = { status: 500, json: { echoed: ACTION_WORDS } };
    await newHandler()(REQUEST);
    postAnswer = { status: 201, json: { id: APPROVAL_ID } };
    pollScript = [{ status: 503, json: { echoed: ACTION_WORDS } }, { status: 401, json: { echoed: TOKEN } }];
    await newHandler()(REQUEST);

    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(ACTION_WORDS);
  });
});

describe('which tool calls ask', () => {
  const own = { platform: 'telegram', conversationId: 'chat-1' };
  const sender = { name: 'forwardMessage', category: 'productivity', hasSideEffects: true };

  it.each([
    ['a channel send to another chat', { name: 'telegramChannelSendMessage', category: 'communication', hasSideEffects: true }, { chatId: 'chat-2' }, own],
    ['a channel send to the conversation\'s own chat: the category and the verb still ask', { name: 'telegramChannelSendMessage', category: 'communication', hasSideEffects: true }, { chatId: 'chat-1' }, own],
    ['the category channel with a post verb', { name: 'post_update', category: 'channel' }, {}, own],
    ['the category tools with a publish verb', { name: 'publish_page', category: 'tools', hasSideEffects: true }, {}, own],
    ['the category tools with a purchase verb', { name: 'purchaseDomain', category: 'tools', hasSideEffects: true }, {}, own],
    ['a write verb in an outward category that declares no side effects', { name: 'sendNote', category: 'communication', hasSideEffects: false }, {}, own],
    ['a category in another case', { name: 'sendNote', category: ' Communication ', hasSideEffects: false }, {}, own],
    ['a mail send filed under productivity', { name: 'gmailSendMessage', category: 'productivity', hasSideEffects: true }, { to: 'a@example.com' }, own],
    ['the plural category', { name: 'notifySend', category: 'communications', hasSideEffects: true }, {}, own],
    ['a social post', { name: 'blueskyPost', category: 'social', hasSideEffects: true }, {}, own],
    ['a post whose verb is in the middle', { name: 'gbpCreatePost', category: 'social', hasSideEffects: true }, {}, own],
    ['a publish filed under content', { name: 'blogPublishArticle', category: 'content', hasSideEffects: true }, {}, own],
    ['a bulk send', { name: 'bulkSchedule', category: 'social', hasSideEffects: true }, {}, own],
    ['a broadcast', { name: 'notifyBroadcast', category: 'communications', hasSideEffects: true }, {}, own],
    ['a webhook', { name: 'call_webhook', category: 'integrations', hasSideEffects: true }, { url: 'https://example.com' }, own],
    ['a purchase with no category', { name: 'pay_with_card', hasSideEffects: true }, {}, own],
    ['a write verb that says nothing about side effects', { name: 'sendNote', category: 'productivity' }, {}, own],
    ['no verb, side effects, another channel', sender, { channelId: 'chat-2' }, own],
    ['no verb, side effects, the same id on another platform', sender, { platform: 'discord', channelId: 'chat-1' }, own],
    ['no verb, side effects, a list with another chat in it', sender, { to: ['chat-1', 'chat-2'] }, own],
    ['no verb, side effects, a target and no conversation', sender, { channelId: 'chat-2' }, undefined],
  ])('%s asks', (_what, tool, args, conversation) => {
    expect(isOutwardAction(tool, args, conversation)).toBe(true);
  });

  it.each([
    ['no verb, side effects, the conversation\'s own channel', sender, { channelId: 'chat-1' }, own],
    ['no verb, side effects, the conversation\'s own channel as a number', sender, { chatId: 42 }, { platform: 'telegram', conversationId: '42' }],
    ['no verb, side effects, no target', { name: 'file_write', category: 'filesystem', hasSideEffects: true }, { path: 'a.txt' }, own],
    ['a read tool aimed at another channel', { name: 'read_history', category: 'communication', hasSideEffects: false }, { chatId: 'chat-2' }, own],
    ['a tool that declares nothing, aimed at another channel', { name: 'translate', category: 'productivity' }, { target: 'fr' }, own],
    ['a read verb before the noun', { name: 'getPost', category: 'social', hasSideEffects: false }, {}, own],
    ['a read verb before a write verb', { name: 'getSendStatus', category: 'communication', hasSideEffects: false }, {}, own],
    ['a name that only contains a verb', { name: 'postgres_query', category: 'tools', hasSideEffects: true }, {}, own],
    ['a past tense of a verb', { name: 'list_sent', category: 'communication', hasSideEffects: false }, {}, own],
    ['a search', { name: 'web_search', category: 'research', hasSideEffects: false }, { q: 'x' }, own],
    ['a write verb in another category that declares no side effects', { name: 'post_search', category: 'research', hasSideEffects: false }, {}, own],
  ])('%s asks nothing', (_what, tool, args, conversation) => {
    expect(isOutwardAction(tool, args, conversation)).toBe(false);
  });
});

describe('what the request says', () => {
  it('names the tool and its target, and carries the arguments', () => {
    const action = describeAction({ name: 'sendMessage' }, { chatId: 'chat-2', text: ACTION_WORDS });

    expect(action.summary).toBe('sendMessage to chat-2');
    expect(action.text).toContain(ACTION_WORDS);
    expect(action.text).toContain('chat-2');
  });

  it('a tool with no target is named alone', () => {
    expect(describeAction({ name: 'publish_page' }, { title: 'x' }).summary).toBe('publish_page');
  });

  it('masks an argument named like a secret, at any depth', () => {
    const { text } = describeAction(
      { name: 'call_webhook' },
      { apiKey: 'sk-one', headers: { Authorization: 'Bearer two', 'x-trace': 'kept' }, list: [{ password: 'three' }] },
    );

    expect(text).not.toContain('sk-one');
    expect(text).not.toContain('Bearer two');
    expect(text).not.toContain('three');
    expect(text).toContain('kept');
  });

  it('stops at the limit', () => {
    const { text } = describeAction({ name: 'sendMessage' }, { text: 'x'.repeat(REMOTE_APPROVAL_TEXT_LIMIT * 3) });

    expect(text.length).toBeLessThan(REMOTE_APPROVAL_TEXT_LIMIT + 64);
  });
});

describe('a channel turn with the remote handler', () => {
  it('a sendMessage to another channel posts a request and waits; the server\'s approved runs the tool', async () => {
    const tool = outwardTool();
    let pollsWhenItRan = -1;
    tool.execute.mockImplementation(async () => {
      pollsWhenItRan = polls().length;
      return { success: true, output: { sent: true } };
    });
    const { ctx, adapter } = channelContext([tool], { remoteApprovalHandler: newHandler() });
    providerScript = [sendToAnotherChat(), textAnswer()];
    pollScript = [state('waiting'), state('waiting'), state('approved')];

    await handleInboundChannelMessage(ctx, inbound());

    expect(requests()).toHaveLength(1);
    expect(requests()[0].body).toMatchObject({
      toolName: 'sendMessage',
      action: { summary: 'sendMessage to chat-2' },
    });
    expect(requests()[0].body.action.text).toContain(ACTION_WORDS);
    expect(pollsWhenItRan).toBe(3);
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(repliesOf(adapter)).toEqual([MODEL_WORDS]);
  });

  it('declined aborts with the word: the tool never runs, the model is not asked again, the channel is told', async () => {
    const tool = outwardTool();
    const { ctx, adapter } = channelContext([tool], { remoteApprovalHandler: newHandler() });
    providerScript = [sendToAnotherChat()];
    pollScript = [state('declined')];

    await handleInboundChannelMessage(ctx, inbound());

    expect(tool.execute).not.toHaveBeenCalled();
    expect(provider.seen).toHaveLength(1);
    const replies = repliesOf(adapter);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('declined');
    expect(replies[0]).toContain('sendMessage');

    const history = ctx.channelSessions.get('telegram:chat-1');
    const toolMessage = history.find((message: any) => message.role === 'tool');
    expect(JSON.parse(toolMessage.content)).toEqual({ error: 'declined', tool: 'sendMessage' });
  });

  it('no answer in waitMs aborts with expired', async () => {
    const tool = outwardTool();
    const { ctx, adapter } = channelContext([tool], { remoteApprovalHandler: newHandler({ waitMs: 40, pollMs: 5 }) });
    providerScript = [sendToAnotherChat()];
    pollScript = [state('waiting')];

    await handleInboundChannelMessage(ctx, inbound());

    expect(tool.execute).not.toHaveBeenCalled();
    expect(provider.seen).toHaveLength(1);
    expect(repliesOf(adapter)[0]).toContain('expired');
  });

  it('a read tool asks nothing', async () => {
    const tool = readTool();
    const { ctx, adapter } = channelContext([tool], { remoteApprovalHandler: newHandler() });
    providerScript = [toolCallsAnswer([{ name: 'read_history', args: { chatId: 'chat-2' } }]), textAnswer()];

    await handleInboundChannelMessage(ctx, inbound());

    expect(approvals.seen).toEqual([]);
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(repliesOf(adapter)).toEqual([MODEL_WORDS]);
  });

  it.each([
    ['the execution mode\'s auto-approve', { autoApproveToolCalls: true }],
    ['--dangerously-skip-permissions', { dangerouslySkipPermissions: true }],
    ['both', { autoApproveToolCalls: true, dangerouslySkipPermissions: true }],
  ])('an outward tool asks under %s', async (_what, flags) => {
    const tool = outwardTool();
    const { ctx, adapter } = channelContext([tool], { remoteApprovalHandler: newHandler(), ...flags });
    providerScript = [sendToAnotherChat()];
    pollScript = [state('declined')];

    await handleInboundChannelMessage(ctx, inbound());

    expect(requests()).toHaveLength(1);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(repliesOf(adapter)[0]).toContain('declined');
  });

  it('asks once for a tool the tiers stop too, and never the local queue', async () => {
    // No category and side effects: the default tier needs a person as well.
    const tool = outwardTool({ category: undefined });
    const { ctx } = channelContext([tool], { remoteApprovalHandler: newHandler(), autoApproveToolCalls: false });
    providerScript = [sendToAnotherChat(), textAnswer()];
    pollScript = [state('approved')];

    await handleInboundChannelMessage(ctx, inbound());

    expect(requests()).toHaveLength(1);
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(ctx.hitlManager.requestApproval).not.toHaveBeenCalled();
  });

  it('a side-effect tool the tiers stop asks the handler, not the local queue', async () => {
    const tool = outwardTool({ name: 'rotate_keys', category: undefined });
    const { ctx, adapter } = channelContext([tool], { remoteApprovalHandler: newHandler(), autoApproveToolCalls: false });
    providerScript = [toolCallsAnswer([{ name: 'rotate_keys', args: { force: true } }]), textAnswer()];
    pollScript = [state('approved')];

    await handleInboundChannelMessage(ctx, inbound());

    expect(requests()).toHaveLength(1);
    expect(requests()[0].body.toolName).toBe('rotate_keys');
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(ctx.hitlManager.requestApproval).not.toHaveBeenCalled();
    expect(repliesOf(adapter)).toEqual([MODEL_WORDS]);
  });

  it('a side-effect tool the handler refuses is denied and the turn goes on', async () => {
    const tool = outwardTool({ name: 'rotate_keys', category: undefined });
    const { ctx, adapter } = channelContext([tool], { remoteApprovalHandler: newHandler(), autoApproveToolCalls: false });
    providerScript = [toolCallsAnswer([{ name: 'rotate_keys', args: { force: true } }]), textAnswer()];
    pollScript = [state('declined')];

    await handleInboundChannelMessage(ctx, inbound());

    expect(tool.execute).not.toHaveBeenCalled();
    expect(ctx.hitlManager.requestApproval).not.toHaveBeenCalled();
    expect(provider.seen).toHaveLength(2);
    expect(repliesOf(adapter)).toEqual([MODEL_WORDS]);
  });

  it('the other calls of an aborted round do not run, and the next turn\'s history is valid', async () => {
    const first = outwardTool();
    const second = outwardTool({ name: 'publish_page' });
    const third = readTool();
    const { ctx, adapter } = channelContext([first, second, third], { remoteApprovalHandler: newHandler() });
    providerScript = [
      toolCallsAnswer([
        { id: 'call-a', name: 'sendMessage', args: { chatId: 'chat-2', text: ACTION_WORDS } },
        { id: 'call-b', name: 'publish_page', args: { title: 'x' } },
        { id: 'call-c', name: 'read_history', args: { chatId: 'chat-1' } },
      ]),
      textAnswer(),
    ];
    pollScript = [state('declined')];

    await handleInboundChannelMessage(ctx, inbound('first'));

    expect(requests()).toHaveLength(1);
    expect(first.execute).not.toHaveBeenCalled();
    expect(second.execute).not.toHaveBeenCalled();
    expect(third.execute).not.toHaveBeenCalled();
    expect(repliesOf(adapter)[0]).toContain('declined');

    await handleInboundChannelMessage(ctx, inbound('second'));

    const sent = provider.seen.at(-1).body.messages;
    const asked = sent.findIndex((message: any) => Array.isArray(message.tool_calls));
    expect(sent.slice(asked + 1, asked + 5).map((message: any) => [message.role, message.tool_call_id])).toEqual([
      ['tool', 'call-a'],
      ['tool', 'call-b'],
      ['tool', 'call-c'],
      ['assistant', undefined],
    ]);
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'second' });
  });

  it('what the model said before asking comes before the line', async () => {
    const tool = outwardTool();
    const { ctx, adapter } = channelContext([tool], { remoteApprovalHandler: newHandler() });
    providerScript = [sendToAnotherChat(MODEL_WORDS)];
    pollScript = [state('declined')];

    await handleInboundChannelMessage(ctx, inbound());

    const [reply] = repliesOf(adapter);
    expect(reply.startsWith(MODEL_WORDS)).toBe(true);
    expect(reply).toContain('declined');
  });

  it('a tool outside tools.allow is refused before anyone is asked', async () => {
    const tool = outwardTool();
    const cfg = { ...CFG, tools: { allow: { packs: [], tools: ['read_history'] } } };
    const { ctx } = channelContext([tool, readTool()], { cfg, remoteApprovalHandler: newHandler() });
    providerScript = [sendToAnotherChat(), textAnswer()];

    await handleInboundChannelMessage(ctx, inbound());

    expect(approvals.seen).toEqual([]);
    expect(tool.execute).not.toHaveBeenCalled();
    const history = ctx.channelSessions.get('telegram:chat-1');
    expect(history.find((message: any) => message.role === 'tool').content).toContain('tool_not_allowed');
  });

  it('reports approval_requested with the turn\'s operation id, and the action stays out of the events', async () => {
    const reporter = createEventsReporter({ url: approvalsUrl, token: TOKEN });
    reporters.push(reporter);
    const tool = outwardTool();
    const { ctx } = channelContext([tool], { remoteApprovalHandler: newHandler(), eventsReporter: reporter });
    providerScript = [sendToAnotherChat(), textAnswer()];
    pollScript = [state('approved')];

    await handleInboundChannelMessage(ctx, inbound());
    await reporter.flush();

    const eventPosts = approvals.seen.filter((r) => r.url.endsWith('/events'));
    const kinds = eventPosts.flatMap((r) => r.body.events).map((event: any) => event.kind);
    expect(kinds).toEqual(['turn_started', 'tool_called', 'approval_requested', 'turn_finished']);
    expect(requests()[0].body.operationId).toMatch(UUID_RE);
    expect(requests()[0].headers[OP_HEADER]).toBe(requests()[0].body.operationId);
    expect(eventPosts[0].headers[OP_HEADER]).toBe(requests()[0].body.operationId);
    for (const post of eventPosts) expect(post.raw).not.toContain(ACTION_WORDS);
  });

  it('a request that never got in reports no approval_requested', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reporter = createEventsReporter({ url: approvalsUrl, token: TOKEN });
    reporters.push(reporter);
    const { ctx } = channelContext([outwardTool()], { remoteApprovalHandler: newHandler(), eventsReporter: reporter });
    providerScript = [sendToAnotherChat()];
    postAnswer = { status: 503, json: {} };

    await handleInboundChannelMessage(ctx, inbound());
    await reporter.flush();

    const kinds = approvals.seen
      .filter((r) => r.url.endsWith('/events'))
      .flatMap((r) => r.body.events)
      .map((event: any) => event.kind);
    expect(kinds).not.toContain('approval_requested');
  });
});

describe('the other turn paths ask too', () => {
  it('POST /chat asks, runs the tool on a yes and answers the model\'s reply', async () => {
    const tool = outwardTool();
    providerScript = [sendToAnotherChat(), textAnswer()];
    pollScript = [state('approved')];

    const { status, body } = await postChat([tool], { remoteApprovalHandler: newHandler() });

    expect(status).toBe(200);
    expect(requests()).toHaveLength(1);
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(body.reply).toBe(MODEL_WORDS);
  });

  it('POST /chat answers the word on a no, and the tool never runs', async () => {
    const tool = outwardTool();
    providerScript = [sendToAnotherChat()];
    pollScript = [state('declined')];

    const { status, body } = await postChat([tool], { remoteApprovalHandler: newHandler() });

    expect(status).toBe(200);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(body.reply).toContain('declined');
    expect(provider.seen).toHaveLength(1);
  });

  it('a side-effect tool the tiers stop on POST /chat asks the handler, not the local queue', async () => {
    const tool = outwardTool({ name: 'rotate_keys', category: undefined });
    const hitlManager = { requestApproval: vi.fn(async () => ({ approved: true })) };
    providerScript = [toolCallsAnswer([{ name: 'rotate_keys', args: {} }]), textAnswer()];
    pollScript = [state('approved')];

    await postChat([tool], { remoteApprovalHandler: newHandler(), autoApproveToolCalls: false, hitlManager });

    expect(requests()).toHaveLength(1);
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(hitlManager.requestApproval).not.toHaveBeenCalled();
  });

  it('a webhook\'s turn asks, and a no ends it with the word', async () => {
    const tool = outwardTool();
    const { ctx } = channelContext([tool]);
    providerScript = [sendToAnotherChat()];
    pollScript = [state('declined')];

    const result = await runAgentTurn(
      { ...ctx, sessions: new Map(), activePersonaId: 'default', remoteApprovalHandler: newHandler() },
      { sessionId: 'webhook:one', message: USER_WORDS, source: 'webhook:one' },
    );

    expect(requests()).toHaveLength(1);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.failed).toBe(false);
    expect(result.reply).toContain('declined');
  });

  it('a webhook\'s turn runs the tool on a yes', async () => {
    const tool = outwardTool();
    const { ctx } = channelContext([tool]);
    providerScript = [sendToAnotherChat(), textAnswer()];
    pollScript = [state('approved')];

    const result = await runAgentTurn(
      { ...ctx, sessions: new Map(), activePersonaId: 'default', remoteApprovalHandler: newHandler() },
      { sessionId: 'webhook:one', message: USER_WORDS, source: 'webhook:one' },
    );

    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ reply: MODEL_WORDS, failed: false });
  });

  it('a side-effect tool on a webhook\'s turn asks the handler instead of being refused outright', async () => {
    const tool = outwardTool({ name: 'rotate_keys', category: undefined });
    const { ctx } = channelContext([tool]);
    providerScript = [toolCallsAnswer([{ name: 'rotate_keys', args: {} }]), textAnswer()];
    pollScript = [state('approved')];

    await runAgentTurn(
      {
        ...ctx,
        sessions: new Map(),
        activePersonaId: 'default',
        autoApproveToolCalls: false,
        remoteApprovalHandler: newHandler(),
      },
      { sessionId: 'webhook:one', message: USER_WORDS, source: 'webhook:one' },
    );

    expect(requests()).toHaveLength(1);
    expect(tool.execute).toHaveBeenCalledOnce();
  });
});

describe('hitl.mode: "remote" from the agent config', () => {
  it('with both variables set, start\'s handler asks <url>/approvals with the token', async () => {
    process.env[EVENTS_URL_ENV] = `${approvalsUrl}/`;
    process.env[EVENTS_TOKEN_ENV] = ` ${TOKEN} `;
    pollScript = [state('approved')];

    const started = await startPhase({ hitl: { mode: 'remote' } });
    const tool = outwardTool();
    const { ctx } = channelContext([tool], { remoteApprovalHandler: started.remoteApprovalHandler });
    providerScript = [sendToAnotherChat(), textAnswer()];

    await handleInboundChannelMessage(ctx, inbound());

    expect(requests()).toHaveLength(1);
    expect(requests()[0].url).toBe('/hosted/agent/approvals');
    expect(requests()[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it('the mode is read as the other modes are: trimmed and in any case', async () => {
    process.env[EVENTS_URL_ENV] = approvalsUrl;
    process.env[EVENTS_TOKEN_ENV] = TOKEN;

    const started = await startPhase({ hitl: { mode: ' Remote ' } });

    expect(typeof started.remoteApprovalHandler).toBe('function');
  });

  describe.each([
    ['WUNDERLAND_EVENTS_URL unset', () => { process.env[EVENTS_TOKEN_ENV] = TOKEN; }],
    ['WUNDERLAND_EVENTS_TOKEN unset', () => { process.env[EVENTS_URL_ENV] = approvalsUrl; }],
    ['both unset', () => {}],
    ['WUNDERLAND_EVENTS_URL blank', () => { process.env[EVENTS_URL_ENV] = '  '; process.env[EVENTS_TOKEN_ENV] = TOKEN; }],
    ['WUNDERLAND_EVENTS_TOKEN blank', () => { process.env[EVENTS_URL_ENV] = approvalsUrl; process.env[EVENTS_TOKEN_ENV] = '  '; }],
    ['WUNDERLAND_EVENTS_URL not a URL', () => { process.env[EVENTS_URL_ENV] = 'not a url'; process.env[EVENTS_TOKEN_ENV] = TOKEN; }],
  ])('with %s', (_what, setEnv) => {
    it('a channel\'s outward tool is refused approval_unavailable and none runs', async () => {
      setEnv();
      const started = await startPhase({ hitl: { mode: 'remote' } });
      const tool = outwardTool();
      const { ctx, adapter } = channelContext([tool], { remoteApprovalHandler: started.remoteApprovalHandler });
      providerScript = [sendToAnotherChat()];

      await handleInboundChannelMessage(ctx, inbound());

      expect(tool.execute).not.toHaveBeenCalled();
      expect(approvals.seen).toEqual([]);
      expect(provider.seen).toHaveLength(1);
      expect(repliesOf(adapter)[0]).toContain(APPROVAL_UNAVAILABLE);
    });

    it('POST /chat\'s outward tool is refused approval_unavailable and none runs', async () => {
      setEnv();
      const started = await startPhase({ hitl: { mode: 'remote' } });
      const tool = outwardTool();
      providerScript = [sendToAnotherChat()];

      const { body } = await postChat([tool], { remoteApprovalHandler: started.remoteApprovalHandler });

      expect(tool.execute).not.toHaveBeenCalled();
      expect(approvals.seen).toEqual([]);
      expect(body.reply).toContain(APPROVAL_UNAVAILABLE);
    });

    it('a webhook\'s outward tool is refused approval_unavailable and none runs', async () => {
      setEnv();
      const started = await startPhase({ hitl: { mode: 'remote' } });
      const tool = outwardTool();
      const { ctx } = channelContext([tool]);
      providerScript = [sendToAnotherChat()];

      const result = await runAgentTurn(
        { ...ctx, sessions: new Map(), activePersonaId: 'default', remoteApprovalHandler: started.remoteApprovalHandler },
        { sessionId: 'webhook:one', message: USER_WORDS, source: 'webhook:one' },
      );

      expect(tool.execute).not.toHaveBeenCalled();
      expect(approvals.seen).toEqual([]);
      expect(result.reply).toContain(APPROVAL_UNAVAILABLE);
    });

    it('a read tool still runs', async () => {
      setEnv();
      const started = await startPhase({ hitl: { mode: 'remote' } });
      const tool = readTool();
      const { ctx, adapter } = channelContext([tool], { remoteApprovalHandler: started.remoteApprovalHandler });
      providerScript = [toolCallsAnswer([{ name: 'read_history', args: { chatId: 'chat-1' } }]), textAnswer()];

      await handleInboundChannelMessage(ctx, inbound());

      expect(tool.execute).toHaveBeenCalledOnce();
      expect(repliesOf(adapter)).toEqual([MODEL_WORDS]);
    });
  });

  it.each([
    ['no hitl block', {}],
    ['another mode', { hitl: { mode: 'human' } }],
    ['a mode that is not a string', { hitl: { mode: 7 } }],
  ])('with %s nothing is asked, whether the variables are set or not', async (_what, cfg) => {
    process.env[EVENTS_URL_ENV] = approvalsUrl;
    process.env[EVENTS_TOKEN_ENV] = TOKEN;
    const started = await startPhase(cfg);
    expect(started.remoteApprovalHandler).toBeUndefined();

    const tool = outwardTool();
    const { ctx, adapter } = channelContext([tool], { remoteApprovalHandler: started.remoteApprovalHandler });
    providerScript = [sendToAnotherChat(), textAnswer()];

    await handleInboundChannelMessage(ctx, inbound());

    expect(approvals.seen).toEqual([]);
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(repliesOf(adapter)).toEqual([MODEL_WORDS]);
  });
});

describe('runToolCallingTurn', () => {
  it('a hook that throws refuses the tool: an approval that cannot be read is no yes', async () => {
    const tool = outwardTool();
    providerScript = [sendToAnotherChat()];
    const messages: any[] = [{ role: 'user', content: USER_WORDS }];

    const reply = await runToolCallingTurn({
      providerId: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-test',
      baseUrl: `${provider.origin}/primary`,
      messages,
      toolMap: new Map([[tool.name, tool]]),
      toolContext: { wrapToolOutputs: false },
      maxRounds: 3,
      dangerouslySkipPermissions: true,
      askPermission: async () => true,
      outwardApproval: async () => {
        throw new Error('the handler broke');
      },
    });

    expect(tool.execute).not.toHaveBeenCalled();
    expect(reply).toContain(APPROVAL_UNAVAILABLE);
    expect(provider.seen).toHaveLength(1);
  });

  it('under fail_closed, a call after the failed one in the same round does not run', async () => {
    const failing = readTool({
      name: 'read_history',
      execute: vi.fn(async () => ({ success: false, error: 'upstream unavailable' })),
    });
    const later = outwardTool({ name: 'publish_page' });
    providerScript = [
      toolCallsAnswer([
        { id: 'call-a', name: 'read_history', args: {} },
        { id: 'call-b', name: 'publish_page', args: {} },
      ]),
    ];

    const reply = await runToolCallingTurn({
      providerId: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-test',
      baseUrl: `${provider.origin}/primary`,
      messages: [{ role: 'user', content: USER_WORDS }],
      toolMap: new Map([[failing.name, failing], [later.name, later]]),
      toolContext: { wrapToolOutputs: false },
      maxRounds: 3,
      dangerouslySkipPermissions: true,
      askPermission: async () => true,
      toolFailureMode: 'fail_closed',
    });

    expect(reply).toContain('[tool_failure_mode=fail_closed]');
    expect(failing.execute).toHaveBeenCalledOnce();
    expect(later.execute).not.toHaveBeenCalled();
  });
});
