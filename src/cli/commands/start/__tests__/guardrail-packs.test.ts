// @ts-nocheck
/**
 * Guardrail packs in `wunderland start`: a pack's `guardrail` descriptor runs on
 * every turn. The person's message is judged before any model sees it and the
 * reply before the person does, on all three of start's turn paths: a channel
 * message (`handleInboundChannelMessage`), `POST /chat` (`handleChatRoutes`) and
 * a webhook's turn (`runAgentTurn`). A block answers the person with the
 * guard's message and nothing goes to the model; a guard's `referral_sent`
 * goes out through the hosted events reporter, with none of the person's words.
 *
 * The pack is the published `@framers/agentos-ext-self-harm-referral`, loaded by
 * start's own extension phase (`loadExtensions`) from the agent config. The
 * turn's provider, the pack's model judge and the events server are separate
 * real HTTP servers on 127.0.0.1, so a judge request is told apart from a turn
 * request. `guardrail-packs.integration.test.ts` runs `POST /chat` in a spawned
 * `wunderland start`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { REFERRAL_TABLE, buildReferral } from '@framers/agentos-ext-self-harm-referral';

import { loadExtensions } from '../extension-loader.js';
import { handleInboundChannelMessage } from '../channel-handler.js';
import { handleChatRoutes } from '../routes/chat.js';
import { runAgentTurn } from '../agent-turn.js';
import { createEventsReporter } from '../hosted-events.js';
import { getPermissionsForSet, normalizeRuntimePolicy } from '../../../../runtime/tools/policy.js';

/** Loading the pack and the registry takes longer than vitest's 5 s default. */
const LOAD_TIMEOUT_MS = 120_000;

const PACK_PACKAGE = '@framers/agentos-ext-self-harm-referral';
/** The referral the pack sends when the turn names no country: the shipped table's own text. */
const REFERRAL = buildReferral(REFERRAL_TABLE, null).text;

/** A first-person self-harm expression: the pack's list matches it. */
const CRISIS = 'I want to die';
const USER_WORDS = 'USER-WORDS-what-should-i-read-tonight';
const MODEL_WORDS = 'MODEL-WORDS-the-model-wrote';
const REFUSED_WORDS = 'REFUSED-WORDS-the-person-never-sees';
/** A model reply the output guard refuses: it carries the topic on. */
const REFUSED_REPLY = `${REFUSED_WORDS} Here is how to end your life.`;

const EVENTS_TOKEN = 'events-token-guardrails';
const JUDGE_KEY = 'sk-judge-test';
const TURN_KEY = 'sk-turn-test';

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
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, raw, body };
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

/** An OpenAI chat-completions answer. */
const chatAnswer = (content: string): Scripted => ({
  status: 200,
  json: {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'gpt-test',
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  },
});

/** What the judge answers: the text calls for a referral. */
const JUDGE_VERDICT = JSON.stringify({ block: true, confidence: 0.97, reason: 'first person' });

let provider: Awaited<ReturnType<typeof startFake>>;
let judge: Awaited<ReturnType<typeof startFake>>;
let eventsServer: Awaited<ReturnType<typeof startFake>>;
/** What the turn's provider answers next, in order; then the ordinary reply. */
let providerScript: Scripted[] = [];
let workspaceBaseDir = '';
const savedEnv: Record<string, string | undefined> = {};
const reporters: Array<{ stop: () => Promise<void> }> = [];

const turnRequests = () => provider.seen.filter((r) => r.method === 'POST');
const judgeRequests = () => judge.seen.filter((r) => r.method === 'POST');
const postedEvents = () => eventsServer.seen.flatMap((r) => r.body?.events ?? []);
const postedKinds = () => postedEvents().map((event: any) => event.kind);
const referralEvents = () => postedEvents().filter((event: any) => event.kind === 'referral_sent');

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const BASE_CFG = {
  seedId: 'guardrails_test',
  permissionSet: 'unrestricted',
  toolAccessProfile: 'unrestricted',
  executionMode: 'autonomous',
};

/** No tool, voice or productivity pack, so only what a test names loads. */
const NO_TOOL_PACKS = { tools: [], voice: [], productivity: [] };

/** The pack with its model judge on the host's OpenAI settings. */
const JUDGE_CFG = {
  ...BASE_CFG,
  extensions: { ...NO_TOOL_PACKS, guardrails: ['self-harm-referral'] },
  extensionOverrides: {
    'self-harm-referral': { options: { judgeModel: { provider: 'openai', model: 'judge-test-model' } } },
  },
};

/** The pack with no judge: a keyword match alone sends the referral. */
const KEYWORD_CFG = {
  ...BASE_CFG,
  extensions: { ...NO_TOOL_PACKS, guardrails: ['self-harm-referral'] },
};

/** Runs start's extension phase on a context the earlier phases would have built. */
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
    providerId: 'openai',
    model: 'gpt-test',
    llmApiKey: TURN_KEY,
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

const adaptiveRuntimeStub = {
  resolveTurnDecision: () => ({ toolFailureMode: 'fail_open', degraded: false, reason: '', actions: {}, kpi: null }),
  recordTurnOutcome: async () => {},
};

/** What start's phases leave on the context for one Telegram adapter, with the guards given. */
function turnContext(turnGuardrails: unknown) {
  const reporter = createEventsReporter({ url: `${eventsServer.origin}/agent`, token: EVENTS_TOKEN });
  reporters.push(reporter);
  const adapter = {
    platform: 'telegram',
    sendTypingIndicator: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => ({ messageId: 'sent-1' })),
  };
  const policy = normalizeRuntimePolicy(BASE_CFG);
  const ctx: any = {
    cfg: BASE_CFG,
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
    toolMap: new Map(),
    canUseLLM: true,
    seed: { seedId: 'guardrails_test' },
    seedId: 'guardrails_test',
    providerId: 'openai',
    model: 'gpt-test',
    llmApiKey: TURN_KEY,
    llmBaseUrl: `${provider.origin}/turn`,
    autoApproveToolCalls: true,
    dangerouslySkipPermissions: false,
    strictToolNames: false,
    turnApprovalMode: 'off',
    openrouterFallback: undefined,
    oauthGetApiKey: undefined,
    hitlManager: { requestApproval: vi.fn(async () => ({ approved: true })) },
    broadcastHitlUpdate: vi.fn(),
    workspaceAgentId: 'guardrails_test',
    workspaceBaseDir,
    activePacks: [],
    adapterByPlatform: new Map([['telegram', adapter]]),
    eventsReporter: reporter,
    turnGuardrails,
  };
  return { ctx, adapter, reporter };
}

/** One turn's outcome on a path: what reached the person, and the conversation it left. */
type TurnOutcome = { delivered: string[]; history: any[] };

/** A channel message through `handleInboundChannelMessage`. */
async function channelTurn(turnGuardrails: unknown, text: string): Promise<TurnOutcome> {
  const { ctx, adapter, reporter } = turnContext(turnGuardrails);
  await handleInboundChannelMessage(ctx, {
    platform: 'telegram',
    conversationId: 'chat-1',
    conversationType: 'direct',
    messageId: 'msg-1',
    text,
    sender: { id: 'user-1' },
  });
  await reporter.flush();
  return {
    delivered: adapter.sendMessage.mock.calls.map((call: any[]) =>
      (call[1]?.blocks ?? []).map((block: any) => block?.text ?? '').join('')),
    history: [...ctx.channelSessions.values()].flat(),
  };
}

/** One `POST /chat` through `handleChatRoutes` over a real server. */
async function chatTurn(turnGuardrails: unknown, text: string): Promise<TurnOutcome> {
  const { ctx, reporter } = turnContext(turnGuardrails);
  const deps: any = {
    ...ctx,
    displayName: 'Guardrails Test',
    activePersonaId: 'default',
    availablePersonas: [],
    rawAgentConfig: BASE_CFG,
    globalConfig: {},
    configDir: workspaceBaseDir,
    sessions: new Map(),
    lazyTools: false,
    skillsPrompt: '',
    chatSecret: '',
    defaultTenantId: undefined,
    sessionTextLogger: { logTurn: async () => {} },
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
      body: JSON.stringify({ message: text, autoClassify: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    await reporter.flush();
    return { delivered: [body.reply], history: [...deps.sessions.values()].flat() };
  } finally {
    await close(server);
  }
}

/** A webhook's turn through `runAgentTurn`. */
async function webhookTurn(turnGuardrails: unknown, text: string): Promise<TurnOutcome> {
  const { ctx, reporter } = turnContext(turnGuardrails);
  const deps: any = { ...ctx, sessions: new Map(), broadcastAgentEvent: vi.fn() };
  const result = await runAgentTurn(deps, { sessionId: 'webhook:test', message: text, source: 'webhook:test' });
  expect(result.failed).toBe(false);
  await reporter.flush();
  return { delivered: [result.reply], history: [...deps.sessions.values()].flat() };
}

const PATHS: Array<[string, (guards: unknown, text: string) => Promise<TurnOutcome>]> = [
  ['a channel message', channelTurn],
  ['POST /chat', chatTurn],
  ["a webhook's turn", webhookTurn],
];

/** The guards each config leaves on the context, loaded once. */
let judgeGuards: any;
let keywordGuards: any;

beforeAll(async () => {
  provider = await startFake(() => providerScript.shift() ?? chatAnswer(MODEL_WORDS));
  judge = await startFake((seen) => {
    if (seen.method !== 'POST') return { status: 200, json: { object: 'list', data: [] } };
    if (seen.url.endsWith('/responses')) {
      return {
        status: 200,
        json: {
          id: 'resp-judge',
          object: 'response',
          status: 'completed',
          model: 'judge-test-model',
          output: [{
            type: 'message',
            id: 'msg-judge',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: JUDGE_VERDICT, annotations: [] }],
          }],
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      };
    }
    return chatAnswer(JUDGE_VERDICT);
  });
  eventsServer = await startFake(() => ({ status: 202, json: { accepted: true } }));
});

afterAll(async () => {
  await close(provider.server);
  await close(judge.server);
  await close(eventsServer.server);
});

beforeEach(async () => {
  provider.seen.length = 0;
  judge.seen.length = 0;
  eventsServer.seen.length = 0;
  providerScript = [];
  workspaceBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-guardrail-packs-'));
  for (const name of [
    'AGENTOS_OPERATION_ID_HEADER',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'WUNDERLAND_EVENTS_URL',
    'WUNDERLAND_EVENTS_TOKEN',
  ]) {
    setEnv(name, undefined);
  }
  // The judge reaches its own server through the host's OpenAI settings; each
  // turn names its provider's URL itself, so no turn goes there.
  setEnv('OPENAI_API_KEY', JUDGE_KEY);
  setEnv('OPENAI_BASE_URL', `${judge.origin}/v1`);
  setEnv('WUNDERLAND_USAGE_LEDGER_PATH', path.join(workspaceBaseDir, 'usage.jsonl'));
  setEnv('WUNDERLAND_WORKSPACE_DIR', workspaceBaseDir);
  if (!judgeGuards) judgeGuards = (await loadForConfig(JUDGE_CFG)).turnGuardrails;
  if (!keywordGuards) keywordGuards = (await loadForConfig(KEYWORD_CFG)).turnGuardrails;
  judge.seen.length = 0;
}, LOAD_TIMEOUT_MS);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(reporters.splice(0).map((reporter) => reporter.stop()));
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
  await fs.rm(workspaceBaseDir, { recursive: true, force: true });
});

describe('start loads guardrail packs from the agent config', () => {
  it('extensions.guardrails loads the pack, keeps its guardrail on the context and adds no tool', async () => {
    const withGuard = await loadForConfig(KEYWORD_CFG);
    const without = await loadForConfig({ ...BASE_CFG, extensions: NO_TOOL_PACKS });

    expect(withGuard.guardrailPackNames).toEqual(['self-harm-referral']);
    expect(withGuard.turnGuardrails).toBeDefined();
    expect(withGuard.activePacks.map((pack: any) => pack?.name)).toContain(PACK_PACKAGE);
    expect([...withGuard.toolMap.keys()].sort()).toEqual([...without.toolMap.keys()].sort());
    expect(without.turnGuardrails).toBeUndefined();
    expect(without.guardrailPackNames).toEqual([]);
  }, LOAD_TIMEOUT_MS);

  it('tools.allow.packs may name the pack: it loads as a guard and adds no tool', async () => {
    const ctx = await loadForConfig({ ...BASE_CFG, tools: { allow: { packs: ['self-harm-referral'], tools: [] } } });

    expect(ctx.guardrailPackNames).toEqual(['self-harm-referral']);
    expect(ctx.turnGuardrails).toBeDefined();
    expect([...ctx.toolMap.keys()]).toEqual([]);
  }, LOAD_TIMEOUT_MS);

  it('a name extensions.guardrails lists that start cannot load stops startup', async () => {
    await expect(
      loadForConfig({ ...BASE_CFG, extensions: { ...NO_TOOL_PACKS, guardrails: ['no-such-guard'] } }),
    ).rejects.toThrow(/no-such-guard/);
  }, LOAD_TIMEOUT_MS);
});

describe.each(PATHS)('a guardrail pack on %s', (_path, runTurn) => {
  it('answers a self-harm expression with the referral; the turn\'s model is never called', async () => {
    const outcome = await runTurn(judgeGuards, CRISIS);

    expect(outcome.delivered).toEqual([REFERRAL]);
    expect(turnRequests()).toEqual([]);
    // The judge was asked, on its own server and the host's key.
    expect(judgeRequests()).toHaveLength(1);
    expect(judgeRequests()[0].headers.authorization).toBe(`Bearer ${JUDGE_KEY}`);
    expect(referralEvents()).toEqual([expect.objectContaining({ kind: 'referral_sent', code: 'input' })]);
    expect(postedKinds()).toEqual(['turn_started', 'referral_sent', 'turn_finished']);
    for (const request of eventsServer.seen) {
      expect(request.raw).not.toContain(CRISIS);
      expect(request.headers.authorization).toBe(`Bearer ${EVENTS_TOKEN}`);
    }
    // The message never enters the conversation a later turn sends the model.
    expect(JSON.stringify(outcome.history)).not.toContain(CRISIS);
  }, LOAD_TIMEOUT_MS);

  it('with no judge the keyword match sends the referral, and no model is called at all', async () => {
    const outcome = await runTurn(keywordGuards, CRISIS);

    expect(outcome.delivered).toEqual([REFERRAL]);
    expect(turnRequests()).toEqual([]);
    expect(judgeRequests()).toEqual([]);
    expect(referralEvents()).toHaveLength(1);
  }, LOAD_TIMEOUT_MS);

  it('replaces a reply the guard refuses with the referral; none of its words reach the person', async () => {
    providerScript = [chatAnswer(REFUSED_REPLY)];

    const outcome = await runTurn(judgeGuards, USER_WORDS);

    expect(turnRequests()).toHaveLength(1);
    expect(outcome.delivered).toEqual([REFERRAL]);
    expect(outcome.delivered.join('\n')).not.toContain(REFUSED_WORDS);
    expect(referralEvents()).toEqual([expect.objectContaining({ kind: 'referral_sent', code: 'output' })]);
    for (const request of eventsServer.seen) expect(request.raw).not.toContain(REFUSED_WORDS);
    // The conversation keeps the referral, not the refused reply.
    const assistant = outcome.history.filter((m: any) => m?.role === 'assistant');
    expect(assistant.at(-1)?.content).toBe(REFERRAL);
    expect(JSON.stringify(outcome.history)).not.toContain(REFUSED_WORDS);
  }, LOAD_TIMEOUT_MS);

  it('passes an ordinary message to the model and delivers its reply', async () => {
    const outcome = await runTurn(judgeGuards, USER_WORDS);

    expect(turnRequests()).toHaveLength(1);
    expect(JSON.stringify(turnRequests()[0].body.messages)).toContain(USER_WORDS);
    expect(outcome.delivered).toEqual([MODEL_WORDS]);
    expect(judgeRequests()).toEqual([]);
    expect(referralEvents()).toEqual([]);
    expect(postedKinds()).toEqual(['turn_started', 'turn_finished']);
  }, LOAD_TIMEOUT_MS);

  it('with no guard configured the message reaches the model as before', async () => {
    const outcome = await runTurn(undefined, CRISIS);

    expect(turnRequests()).toHaveLength(1);
    expect(JSON.stringify(turnRequests()[0].body.messages)).toContain(CRISIS);
    expect(outcome.delivered).toEqual([MODEL_WORDS]);
    expect(referralEvents()).toEqual([]);
  }, LOAD_TIMEOUT_MS);
});
