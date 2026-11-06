// @ts-nocheck
/**
 * The turn's place reaches the guard. `wunderland start` puts the locale a
 * channel reports for its user, and the `country` and `locale` a host names on
 * `POST /chat`, in the guard context's metadata, on the person's message and
 * on the reply. The published `@framers/agentos-ext-self-harm-referral` then
 * leads its referral with the crisis lines of that country and closes with its
 * emergency number; a turn that names no place gets the referral with no
 * country, as before.
 *
 * The pack loads through start's own extension phase (`loadExtensions`) from
 * the agent config, with no judge, so a keyword match refers. A channel
 * message goes through `handleInboundChannelMessage` with the raw event the
 * published channel packs pass: `@framers/agentos-ext-channel-telegram` 0.1.10
 * hands over grammY's context (`from.language_code`), or `{ ctx,
 * explicitInvocation }` for a command; `@framers/agentos-ext-channel-discord`
 * 0.1.6 hands over the discord.js message, or `{ interaction,
 * explicitInvocation }` for a slash command (`interaction.locale`). `POST
 * /chat` goes through `handleChatRoutes` on a real server. The turn's provider
 * is a real HTTP server on 127.0.0.1.
 *
 * Every expected referral is the pack's own text for that country, built from
 * the table it ships.
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
import { getPermissionsForSet, normalizeRuntimePolicy } from '../../../../runtime/tools/policy.js';

/** Loading the pack and the registry takes longer than vitest's 5 s default. */
const LOAD_TIMEOUT_MS = 120_000;

/** A first-person self-harm expression: the pack's list matches it. */
const CRISIS = 'I want to die';
const USER_WORDS = 'USER-WORDS-what-should-i-read-tonight';
const MODEL_WORDS = 'MODEL-WORDS-the-model-wrote';
const REFUSED_WORDS = 'REFUSED-WORDS-the-person-never-sees';
/** A model reply the output guard refuses: it carries the topic on. */
const REFUSED_REPLY = `${REFUSED_WORDS} Here is how to end your life.`;
const TURN_KEY = 'sk-turn-test';

/** The referral the pack sends for a country it holds, or for no country. */
const referralFor = (country: string | null): string => buildReferral(REFERRAL_TABLE, country).text;

/**
 * The referral leads with the country's own line and closes with its emergency
 * number: read from the table, so a new table changes the expectation with it.
 */
function expectLedBy(text: string, country: string): void {
  const own = REFERRAL_TABLE.countries[country];
  const listed = text.split('\n').filter((line) => line.startsWith('- '));
  expect(listed[0]).toBe(`- ${own.lines[0].label}: ${own.lines[0].text}`);
  expect(text.split('\n').at(-1)).toBe(REFERRAL_TABLE.emergency.known.replace('{number}', own.emergency.number));
}

type Seen = { method: string; url: string; raw: string; body: any };
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
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', raw, body };
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

let provider: Awaited<ReturnType<typeof startFake>>;
/** What the turn's provider answers next, in order; then the ordinary reply. */
let providerScript: Scripted[] = [];
let workspaceBaseDir = '';
const savedEnv: Record<string, string | undefined> = {};
/** The guards the agent config leaves on the context, loaded once. */
let guards: any;

const turnRequests = () => provider.seen.filter((r) => r.method === 'POST');

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const BASE_CFG = {
  seedId: 'guard_place_test',
  permissionSet: 'unrestricted',
  toolAccessProfile: 'unrestricted',
  executionMode: 'autonomous',
};

/** The pack with no judge and no country of its own; no tool, voice or productivity pack. */
const GUARD_CFG = {
  ...BASE_CFG,
  extensions: { tools: [], voice: [], productivity: [], guardrails: ['self-harm-referral'] },
};

/** Runs start's extension phase on a context the earlier phases would have built. */
async function loadGuards(): Promise<any> {
  const policy = normalizeRuntimePolicy(GUARD_CFG);
  const ctx: any = {
    cfg: GUARD_CFG,
    globalConfig: {},
    policy,
    permissions: getPermissionsForSet(policy.permissionSet),
    dangerouslySkipCommandSafety: false,
    workspaceAgentId: GUARD_CFG.seedId,
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
  return ctx.turnGuardrails;
}

/** What start's phases leave on the context for one Telegram and one Discord adapter. */
function turnContext() {
  const adapterFor = (platform: string) => ({
    platform,
    sendTypingIndicator: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => ({ messageId: 'sent-1' })),
  });
  const adapters = new Map([
    ['telegram', adapterFor('telegram')],
    ['discord', adapterFor('discord')],
  ]);
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
    adaptiveRuntime: {
      resolveTurnDecision: () => ({ toolFailureMode: 'fail_open', degraded: false, reason: '', actions: {}, kpi: null }),
      recordTurnOutcome: async () => {},
    },
    defaultTenantId: '',
    toolMap: new Map(),
    canUseLLM: true,
    seed: { seedId: BASE_CFG.seedId },
    seedId: BASE_CFG.seedId,
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
    workspaceAgentId: BASE_CFG.seedId,
    workspaceBaseDir,
    activePacks: [],
    adapterByPlatform: adapters,
    turnGuardrails: guards,
  };
  return { ctx, adapters };
}

/** One channel message through `handleInboundChannelMessage`; answers what reached the person. */
async function channelTurn(message: {
  platform: 'telegram' | 'discord';
  conversationType?: string;
  rawEvent?: unknown;
  text: string;
}): Promise<string[]> {
  const { ctx, adapters } = turnContext();
  await handleInboundChannelMessage(ctx, {
    conversationId: 'chat-1',
    conversationType: 'direct',
    messageId: 'msg-1',
    sender: { id: 'user-1' },
    ...message,
  });
  return adapters.get(message.platform).sendMessage.mock.calls.map((call: any[]) =>
    (call[1]?.blocks ?? []).map((block: any) => block?.text ?? '').join(''));
}

/** One `POST /chat` through `handleChatRoutes` over a real server; answers the reply. */
async function chatTurn(body: Record<string, unknown>): Promise<string> {
  const { ctx } = turnContext();
  const deps: any = {
    ...ctx,
    displayName: 'Guard Place Test',
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
      body: JSON.stringify({ autoClassify: false, ...body }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).reply;
  } finally {
    await close(server);
  }
}

/** grammY's context for a private chat: `from` is the sender, with the language the client reports. */
const telegramContext = (languageCode?: string) => ({
  update: { update_id: 1 },
  message: { message_id: 1, chat: { id: 1, type: 'private' }, text: CRISIS },
  from: { id: 7, is_bot: false, first_name: 'Sam', ...(languageCode ? { language_code: languageCode } : {}) },
});

beforeAll(async () => {
  provider = await startFake(() => providerScript.shift() ?? chatAnswer(MODEL_WORDS));
});

afterAll(async () => {
  await close(provider.server);
});

beforeEach(async () => {
  provider.seen.length = 0;
  providerScript = [];
  workspaceBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-guard-place-'));
  for (const name of [
    'AGENTOS_OPERATION_ID_HEADER',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'WUNDERLAND_EVENTS_URL',
    'WUNDERLAND_EVENTS_TOKEN',
  ]) {
    setEnv(name, undefined);
  }
  setEnv('WUNDERLAND_USAGE_LEDGER_PATH', path.join(workspaceBaseDir, 'usage.jsonl'));
  setEnv('WUNDERLAND_WORKSPACE_DIR', workspaceBaseDir);
  if (!guards) guards = await loadGuards();
}, LOAD_TIMEOUT_MS);

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
  await fs.rm(workspaceBaseDir, { recursive: true, force: true });
});

describe('a Telegram message: the sender\'s language_code', () => {
  it('en-AU gets the Australian lines first and closes with the Australian emergency number', async () => {
    const delivered = await channelTurn({ platform: 'telegram', text: CRISIS, rawEvent: telegramContext('en-AU') });

    expect(delivered).toEqual([referralFor('AU')]);
    expectLedBy(delivered[0], 'AU');
    expect(turnRequests()).toEqual([]);
  }, LOAD_TIMEOUT_MS);

  it('a command (the context wrapped for an explicit invocation) gets the same', async () => {
    const delivered = await channelTurn({
      platform: 'telegram',
      text: CRISIS,
      rawEvent: { ctx: telegramContext('en-AU'), explicitInvocation: true, explain: false },
    });

    expect(delivered).toEqual([referralFor('AU')]);
    expect(turnRequests()).toEqual([]);
  }, LOAD_TIMEOUT_MS);

  it('a language with no region (en) names no country: the referral with no country', async () => {
    const delivered = await channelTurn({ platform: 'telegram', text: CRISIS, rawEvent: telegramContext('en') });

    expect(delivered).toEqual([referralFor(null)]);
    expect(delivered[0].split('\n').at(-1)).toBe(REFERRAL_TABLE.emergency.unknown);
  }, LOAD_TIMEOUT_MS);

  it('a reply the output guard refuses is replaced by the referral of the same place', async () => {
    providerScript = [chatAnswer(REFUSED_REPLY)];

    const delivered = await channelTurn({ platform: 'telegram', text: USER_WORDS, rawEvent: telegramContext('en-AU') });

    expect(turnRequests()).toHaveLength(1);
    expect(delivered).toEqual([referralFor('AU')]);
    expect(delivered.join('\n')).not.toContain(REFUSED_WORDS);
  }, LOAD_TIMEOUT_MS);

  it('an ordinary message reaches the model and its reply is delivered', async () => {
    const delivered = await channelTurn({ platform: 'telegram', text: USER_WORDS, rawEvent: telegramContext('en-AU') });

    expect(turnRequests()).toHaveLength(1);
    expect(delivered).toEqual([MODEL_WORDS]);
  }, LOAD_TIMEOUT_MS);
});

describe('a Discord message: a slash command\'s locale', () => {
  it('an interaction with locale en-CA gets the Canadian lines, whatever the server\'s locale', async () => {
    const delivered = await channelTurn({
      platform: 'discord',
      conversationType: 'group',
      text: CRISIS,
      rawEvent: { interaction: { id: 'i1', locale: 'en-CA', guildLocale: 'en-AU' }, explicitInvocation: true, explain: false },
    });

    expect(delivered).toEqual([referralFor('CA')]);
    expectLedBy(delivered[0], 'CA');
  }, LOAD_TIMEOUT_MS);

  it("a plain message carries no locale of the sender's: the referral with no country", async () => {
    const delivered = await channelTurn({
      platform: 'discord',
      conversationType: 'group',
      text: CRISIS,
      // The discord.js message: the server's preferred locale is not the person's.
      rawEvent: { id: 'm1', content: CRISIS, interaction: null, guild: { id: 'g1', preferredLocale: 'en-AU' } },
    });

    expect(delivered).toEqual([referralFor(null)]);
  }, LOAD_TIMEOUT_MS);
});

describe('POST /chat: the country and locale the host names', () => {
  it('country NZ gets the New Zealand lines and the New Zealand emergency number', async () => {
    const reply = await chatTurn({ message: CRISIS, country: 'NZ' });

    expect(reply).toBe(referralFor('NZ'));
    expectLedBy(reply, 'NZ');
    expect(turnRequests()).toEqual([]);
  }, LOAD_TIMEOUT_MS);

  it('a locale alone places the person by its region', async () => {
    expect(await chatTurn({ message: CRISIS, locale: 'en-GB' })).toBe(referralFor('GB'));
  }, LOAD_TIMEOUT_MS);

  it("country 'Germany' is not a code: it is dropped and the referral names no country", async () => {
    expect(await chatTurn({ message: CRISIS, country: 'Germany' })).toBe(referralFor(null));
  }, LOAD_TIMEOUT_MS);

  it('a reply the output guard refuses is replaced by the referral of the same place', async () => {
    providerScript = [chatAnswer(REFUSED_REPLY)];

    const reply = await chatTurn({ message: USER_WORDS, country: 'NZ' });

    expect(turnRequests()).toHaveLength(1);
    expect(reply).toBe(referralFor('NZ'));
    expect(reply).not.toContain(REFUSED_WORDS);
  }, LOAD_TIMEOUT_MS);
});

describe('a turn that names no place', () => {
  it('a Telegram message with no language gets the referral with no country, as before', async () => {
    const delivered = await channelTurn({ platform: 'telegram', text: CRISIS, rawEvent: telegramContext() });

    expect(delivered).toEqual([referralFor(null)]);
  }, LOAD_TIMEOUT_MS);

  it('a channel message with no raw event gets the referral with no country, as before', async () => {
    expect(await channelTurn({ platform: 'telegram', text: CRISIS })).toEqual([referralFor(null)]);
  }, LOAD_TIMEOUT_MS);

  it('POST /chat with neither field gets the referral with no country, as before', async () => {
    expect(await chatTurn({ message: CRISIS })).toBe(referralFor(null));
  }, LOAD_TIMEOUT_MS);
});
