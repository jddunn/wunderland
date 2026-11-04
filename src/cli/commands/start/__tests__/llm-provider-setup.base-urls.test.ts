// @ts-nocheck
/**
 * `wunderland start` sends each provider's calls to that provider's base-URL
 * variable (OPENAI_BASE_URL, ANTHROPIC_BASE_URL, OPENROUTER_BASE_URL): the
 * primary provider's turns, the fallback chain, the LLM judge, the local
 * memory tool's embeddings and HyDE call, the RAG bootstrap's embeddings and
 * the discovery index's embeddings. With the variables unset, every call goes
 * to the provider's own endpoint.
 *
 * The same holds for the turn a webhook wakes, the Discord welcome and curated
 * picks posts, and the mission planner's Anthropic requests. With
 * AGENTOS_OPERATION_ID_HEADER naming a header, every one of wunderland's own
 * requests carries an operation id in it: one id across a call's attempts (the
 * primary and its fallback), a new id for the next call.
 *
 * Each variable points at one fake provider server on 127.0.0.1, under its own
 * path prefix. `fetch` is wrapped so a request for any other origin is answered
 * in process and recorded instead of leaving the machine; every case but the
 * unset one asserts that none did.
 *
 * `wunderland chat`'s query router and its LLM caller, the job executor's own
 * LLM call and the other commands' provider calls read the same variables
 * through the same helpers. A channel message falls back like the `/chat` route
 * and the webhook turn, for every primary provider.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { setupLlmProvider } from '../llm-provider-setup.js';
import { createLocalMemoryReadTool } from '../local-memory-tool.js';
import { bootstrapRagKnowledge } from '../rag-bootstrap.js';
import { handleInboundChannelMessage, wireDiscordExtensions } from '../channel-handler.js';
import { dispatchRoute, resetWebhookRateLimiter } from '../routes/index.js';
import { runToolCallingTurn, openaiChatWithTools } from '../../../../runtime/tools/tool-calling.js';
import { chatCompletionsRequest, anthropicMessagesRequest } from '../../../../runtime/tools/tool-helpers.js';
import { resolveEmbeddingConfig, WunderlandDiscoveryManager } from '../../../../platform/discovery/WunderlandDiscoveryManager.js';
import { createResearchClassifierLlmCall } from '../../../../runtime/agentos-bridge/research-classifier.js';
import { createCuratedPicksHandler } from '../../../../channels/discord/curatedPicksHandler.js';
import { anthropicApiUrl, primaryBaseUrlFor } from '../../../../platform/config/provider-base-urls.js';
import {
  createChatLlmCaller,
  initCliQueryRouter,
  resetCliQueryRouterForTests,
} from '../../../../runtime/agentos-bridge/query-router-init.js';
import { JobExecutor } from '../../../../autonomy/jobs/JobExecutor.js';
import { resolveWunderlandRuntimeConfigFromEnv } from '../../../../platform/config/provider-defaults.js';
import { resolveMissionModel, resolveMissionProviderBaseUrl } from '../../mission-model-flags.js';

const KEYS = {
  OPENAI_API_KEY: 'sk-openai-test',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  OPENROUTER_API_KEY: 'sk-or-test',
} as const;

const ENV_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'OPENROUTER_BASE_URL',
  'OLLAMA_BASE_URL',
  'WUNDERLAND_WORKSPACE_DIR',
  'AGENTOS_OPERATION_ID_HEADER',
  'JOB_EXECUTOR_MODEL',
];

/** The header the operation-id cases name in AGENTOS_OPERATION_ID_HEADER. */
const OP_HEADER = 'x-rh-operation-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The curated picks judge's and copywriter's answers (told apart by max_tokens). */
const PICKS_JUDGE_TEXT = JSON.stringify({ index: 0 });
const PICKS_COPY_TEXT = JSON.stringify({ hook: 'A hook', commentary: 'Some commentary' });

/** The judge's answer, valid JSON for AgentOS's llmJudge parser. */
const JUDGE_TEXT = JSON.stringify({ approved: true, confidence: 0.95, reasoning: 'fine' });

/** The length of text-embedding-3-small's vectors, which AgentOS's vector store checks. */
const EMBEDDING_DIMENSION = 1536;

/** The events of one Anthropic streaming answer, as AgentOS's provider reads them. */
function anthropicSse(text: string, model: string): string {
  const events = [
    {
      type: 'message_start',
      message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

type Seen = { method: string; url: string; headers: Record<string, unknown>; body: any };

/** Requests the fake provider server received (path only). */
const seen: Seen[] = [];
/** Requests for any origin other than the fake server (full URL). */
const escaped: Seen[] = [];

let server: Server;
let origin = '';
let realFetch: typeof fetch;

/** The fake's answer for a request path, in each provider's own wire shape. */
function answer(method: string, url: string, body: any): { status: number; json: unknown; sse?: string } {
  const pathname = url.split('?')[0] ?? '';
  if (pathname.includes('/down/')) {
    return { status: 503, json: { error: { message: 'unavailable' } } };
  }
  if (method === 'GET' && pathname.endsWith('/headlines')) {
    // The curated picks scraper: one headline per category, unique per request.
    // The title is one random word, so no two titles read as similar.
    const category = pathname.split('/').at(-2) ?? 'tech';
    const word = Math.random().toString(36).slice(2);
    return {
      status: 200,
      json: { headlines: [{ title: word, url: `https://news.example.com/${category}/${word}`, date: '' }] },
    };
  }
  if (pathname.endsWith('/embeddings')) {
    const inputs = Array.isArray(body?.input) ? body.input : [body?.input];
    return {
      status: 200,
      json: {
        object: 'list',
        model: body?.model ?? 'text-embedding-3-small',
        data: inputs.map((_: unknown, index: number) => ({ object: 'embedding', index, embedding: new Array(EMBEDDING_DIMENSION).fill(0.1) })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
    };
  }
  if (pathname.endsWith('/v1/messages')) {
    // AgentOS's Anthropic provider streams; wunderland's own request does not.
    if (body?.stream === true) {
      return { status: 200, json: null, sse: anthropicSse(JUDGE_TEXT, body?.model ?? 'claude-test') };
    }
    return {
      status: 200,
      json: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: body?.model ?? 'claude-test',
        content: [{ type: 'text', text: JUDGE_TEXT }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
  }
  if (method === 'GET' && /\/models(\/.*)?$/.test(pathname)) {
    return {
      status: 200,
      json: {
        object: 'list',
        // OpenRouter's provider reads name, pricing and context_length from each row.
        data: ['gpt-4o-mini', 'openai/gpt-4o-mini', 'text-embedding-3-small', 'openai/text-embedding-3-small'].map((id) => ({
          id,
          object: 'model',
          created: 0,
          owned_by: 'test',
          name: id,
          description: id,
          pricing: { prompt: '0', completion: '0' },
          context_length: 128000,
        })),
      },
    };
  }
  if (pathname.endsWith('/responses')) {
    return {
      status: 200,
      json: {
        id: 'resp_test',
        object: 'response',
        status: 'completed',
        model: body?.model ?? 'gpt-test',
        output: [{
          type: 'message',
          id: 'msg_test',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: JUDGE_TEXT, annotations: [] }],
        }],
        output_text: JUDGE_TEXT,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    };
  }
  if (method === 'POST') {
    const system = String(body?.messages?.[0]?.content ?? '');
    const content = system.includes('selection judge for Wunderland News') ? PICKS_JUDGE_TEXT
      : system.includes('editorial voice of Wunderland News') ? PICKS_COPY_TEXT
      : JUDGE_TEXT;
    return {
      status: 200,
      json: {
        id: 'chatcmpl_test',
        object: 'chat.completion',
        created: 0,
        model: body?.model ?? 'gpt-test',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    };
  }
  return { status: 200, json: {} };
}

function parseBody(raw: unknown): any {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function headersOf(init: RequestInit | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  new Headers(init?.headers as HeadersInit | undefined).forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

/** Answers a request for any origin but the fake server in process, and records it. */
const guardedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(origin)) return realFetch(input as any, init);
  const method = String(init?.method ?? 'GET').toUpperCase();
  const body = parseBody(init?.body);
  escaped.push({ method, url, headers: headersOf(init), body });
  const { status, json, sse } = answer(method, new URL(url).pathname, body);
  return new Response(sse ?? JSON.stringify(json), {
    status,
    headers: { 'content-type': sse ? 'text/event-stream' : 'application/json' },
  });
};

beforeAll(async () => {
  realFetch = globalThis.fetch;
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const method = String(req.method ?? 'GET').toUpperCase();
      const url = req.url ?? '/';
      const body = parseBody(raw);
      seen.push({ method, url, headers: req.headers as Record<string, unknown>, body });
      const { status, json, sse } = answer(method, url, body);
      res.writeHead(status, { 'content-type': sse ? 'text/event-stream' : 'application/json' });
      res.end(sse ?? JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of ENV_VARS) delete process.env[name];
  seen.length = 0;
  escaped.length = 0;
  vi.stubGlobal('fetch', guardedFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ENV_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

/**
 * Points the three variables at the fake, with the spacing and trailing
 * slashes a person might type unless `plain` is set.
 */
function pointVariablesAtFake(opts: { anthropicSuffix?: string; plain?: boolean } = {}): void {
  process.env['OPENAI_BASE_URL'] = opts.plain ? `${origin}/openai/v1` : `  ${origin}/openai/v1/  `;
  process.env['ANTHROPIC_BASE_URL'] = `${origin}/anthropic${opts.anthropicSuffix ?? ''}`;
  process.env['OPENROUTER_BASE_URL'] = opts.plain ? `${origin}/openrouter/api/v1` : `${origin}/openrouter/api/v1/`;
}

function setKeys(...names: Array<keyof typeof KEYS>): void {
  for (const name of names) process.env[name] = KEYS[name];
}

async function startCtx(provider: string, cfg: Record<string, unknown> = {}): Promise<any> {
  const ctx: any = {
    flags: { provider },
    globals: { autoApproveTools: false },
    cfg,
    policy: { executionMode: 'human-all' },
    seedId: 'seed-base-urls',
    globalConfig: {},
  };
  expect(await setupLlmProvider(ctx)).toBe(true);
  return ctx;
}

async function runPrimaryTurn(ctx: any): Promise<unknown> {
  return runToolCallingTurn({
    providerId: ctx.providerId,
    apiKey: ctx.llmApiKey,
    model: ctx.model,
    messages: [{ role: 'user', content: 'hello' }],
    toolMap: new Map(),
    toolContext: {},
    maxRounds: 1,
    dangerouslySkipPermissions: true,
    askPermission: async () => true,
    baseUrl: ctx.llmBaseUrl,
    fallback: ctx.openrouterFallback,
  });
}

function posts(prefix: string): Seen[] {
  return seen.filter((r) => r.method === 'POST' && r.url.startsWith(prefix));
}

const fakeVectorStore = {
  query: async () => ({ documents: [] }),
  hybridSearch: async () => ({ documents: [] }),
};

describe('start: the primary provider', () => {
  it.each([
    ['openai', '/openai/v1', '/openai/v1/chat/completions', 'authorization', `Bearer ${KEYS.OPENAI_API_KEY}`],
    ['anthropic', '/anthropic/v1', '/anthropic/v1/messages', 'x-api-key', KEYS.ANTHROPIC_API_KEY],
    ['openrouter', '/openrouter/api/v1', '/openrouter/api/v1/chat/completions', 'authorization', `Bearer ${KEYS.OPENROUTER_API_KEY}`],
  ])('the %s primary sends its turn to its base-URL variable', async (provider, base, expectedPath, header, headerValue) => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY');
    const ctx = await startCtx(provider);

    expect(ctx.llmBaseUrl).toBe(`${origin}${base}`);
    await runPrimaryTurn(ctx);

    const hits = posts(expectedPath);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe(expectedPath);
    expect(hits[0].headers[header]).toBe(headerValue);
    expect(escaped).toEqual([]);
  });

  it('an ANTHROPIC_BASE_URL that already ends in /v1 sends to /v1/messages once', async () => {
    pointVariablesAtFake({ anthropicSuffix: '/v1/' });
    setKeys('ANTHROPIC_API_KEY');
    const ctx = await startCtx('anthropic');

    await runPrimaryTurn(ctx);

    expect(posts('/anthropic/').map((r) => r.url)).toEqual(['/anthropic/v1/messages']);
    expect(escaped).toEqual([]);
  });
});

describe('start: the fallback chain', () => {
  it.each([
    ['openai', ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'], '/anthropic/v1/chat/completions', `Bearer ${KEYS.ANTHROPIC_API_KEY}`],
    ['anthropic', ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], '/openai/v1/chat/completions', `Bearer ${KEYS.OPENAI_API_KEY}`],
    ['openai', ['OPENAI_API_KEY', 'OPENROUTER_API_KEY'], '/openrouter/api/v1/chat/completions', `Bearer ${KEYS.OPENROUTER_API_KEY}`],
  ])('with a %s primary and %j set, the fallback goes to %s', async (provider, keys, expectedPath, authorization) => {
    pointVariablesAtFake();
    setKeys(...(keys as Array<keyof typeof KEYS>));
    const ctx = await startCtx(provider);
    expect(ctx.openrouterFallback).toBeDefined();

    // A primary that answers 503 hands the call to the first fallback candidate.
    await openaiChatWithTools({
      apiKey: 'sk-down',
      model: 'model-down',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      temperature: 0,
      maxTokens: 8,
      baseUrl: `${origin}/down/v1`,
      fallback: ctx.openrouterFallback,
    });

    const hits = posts(expectedPath);
    expect(hits).toHaveLength(1);
    expect(hits[0].headers['authorization']).toBe(authorization);
    expect(escaped).toEqual([]);
  });
});

describe('start: the Gemini fallback candidate', () => {
  it("goes to Gemini's OpenAI-compatible endpoint with the Gemini key, never to OpenAI", async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY');
    process.env['GEMINI_API_KEY'] = 'gemini-test-key';
    const ctx = await startCtx('openai');
    expect(ctx.openrouterFallback.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai');

    await openaiChatWithTools({
      apiKey: 'sk-down',
      model: 'model-down',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      temperature: 0,
      maxTokens: 8,
      baseUrl: `${origin}/down/v1`,
      fallback: ctx.openrouterFallback,
    });

    // Gemini has no base-URL variable, so its request is the one that leaves
    // for the provider's own endpoint (answered in process by the guard).
    expect(escaped.map((r) => r.url)).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?key=gemini-test-key',
    ]);
  });
});

describe('start: the LLM judge', () => {
  it.each([
    ['openai', 'gpt-4o-mini', '/openai/v1/'],
    ['openrouter', 'openai/gpt-4o-mini', '/openrouter/api/v1/'],
    ['anthropic', 'claude-haiku-4-5-20251001', '/anthropic/v1/messages'],
  ])('a %s judge sends its request to the base-URL variable', async (judgeProvider, judgeModel, prefix) => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY');
    const ctx = await startCtx('openai', { hitl: { mode: 'llm-judge', judgeProvider, judgeModel } });
    expect(typeof ctx.llmJudgeHandler).toBe('function');

    const approved = await ctx.llmJudgeHandler({ name: 'send_message', hasSideEffects: true }, { text: 'hello' });

    expect(approved).toBe(true);
    expect(posts(prefix).length).toBeGreaterThanOrEqual(1);
    expect(escaped).toEqual([]);
  }, 30_000);

  it('an anthropic judge with only ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL set reaches the fake', async () => {
    process.env['ANTHROPIC_BASE_URL'] = `${origin}/anthropic`;
    setKeys('ANTHROPIC_API_KEY');
    const ctx = await startCtx('anthropic', {
      hitl: { mode: 'llm-judge', judgeProvider: 'anthropic', judgeModel: 'claude-haiku-4-5-20251001' },
    });

    await ctx.llmJudgeHandler({ name: 'send_message', hasSideEffects: true }, {});

    expect(posts('/anthropic/v1/messages').length).toBeGreaterThanOrEqual(1);
    expect(posts('/anthropic/v1/messages')[0].headers['x-api-key']).toBe(KEYS.ANTHROPIC_API_KEY);
    expect(escaped).toEqual([]);
  }, 30_000);

  it('an ANTHROPIC_BASE_URL that already ends in /v1/ sends the judge to /v1/messages once', async () => {
    pointVariablesAtFake({ anthropicSuffix: '/v1/' });
    setKeys('ANTHROPIC_API_KEY');
    const ctx = await startCtx('anthropic', {
      hitl: { mode: 'llm-judge', judgeProvider: 'anthropic', judgeModel: 'claude-haiku-4-5-20251001' },
    });

    await ctx.llmJudgeHandler({ name: 'send_message', hasSideEffects: true }, {});

    const urls = new Set(posts('/anthropic/').map((r) => r.url));
    expect([...urls]).toEqual(['/anthropic/v1/messages']);
    expect(escaped).toEqual([]);
  }, 30_000);

  it("with the variables unset, the judge goes to the judge provider's own endpoint", async () => {
    setKeys('ANTHROPIC_API_KEY');
    const ctx = await startCtx('anthropic', {
      hitl: { mode: 'llm-judge', judgeProvider: 'anthropic', judgeModel: 'claude-haiku-4-5-20251001' },
    });

    await ctx.llmJudgeHandler({ name: 'send_message', hasSideEffects: true }, {});

    expect(escaped.filter((r) => r.method === 'POST').map((r) => r.url)).toContain('https://api.anthropic.com/v1/messages');
    expect(seen).toEqual([]);
  }, 30_000);
});

describe('start: the local memory tool', () => {
  it('embeds the query at OPENAI_BASE_URL with the OpenAI key', async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY');
    const tool = createLocalMemoryReadTool({
      vectorStore: fakeVectorStore,
      openaiApiKey: KEYS.OPENAI_API_KEY,
      embeddingModel: 'text-embedding-3-small',
    });

    await tool.execute({ query: 'what did I say yesterday' }, {});

    const hits = posts('/openai/v1/embeddings');
    expect(hits).toHaveLength(1);
    expect(hits[0].headers['authorization']).toBe(`Bearer ${KEYS.OPENAI_API_KEY}`);
    expect(escaped).toEqual([]);
  });

  it("sends HyDE's hypothesis call for an Anthropic primary to ANTHROPIC_BASE_URL", async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY');
    const ctx = await startCtx('anthropic');
    const tool = createLocalMemoryReadTool({
      vectorStore: fakeVectorStore,
      openaiApiKey: KEYS.OPENAI_API_KEY,
      embeddingModel: 'text-embedding-3-small',
      // The same llm block extension-loader.ts builds from ctx.
      hyde: { enabled: true, llm: { apiKey: ctx.llmApiKey, model: ctx.model, baseUrl: ctx.llmBaseUrl } },
    });

    await tool.execute({ query: 'what did I say yesterday' }, {});

    expect(posts('/anthropic/v1/chat/completions')).toHaveLength(1);
    expect(posts('/openai/v1/embeddings').length).toBeGreaterThanOrEqual(1);
    expect(escaped).toEqual([]);
  });
});

describe("start: the chat route's research classifier", () => {
  // routes/chat.ts builds the classifier's call from the primary provider's id,
  // key and base URL.
  it.each([
    ['openai', '/openai/v1/chat/completions', `Bearer ${KEYS.OPENAI_API_KEY}`, /^gpt-/],
    ['anthropic', '/anthropic/v1/chat/completions', `Bearer ${KEYS.ANTHROPIC_API_KEY}`, /^claude-/],
  ])('a %s primary classifies at its base-URL variable with a model that provider serves', async (provider, expectedPath, authorization, model) => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY');
    const ctx = await startCtx(provider);
    const llmCall = createResearchClassifierLlmCall({
      providerId: ctx.providerId,
      apiKey: ctx.llmApiKey,
      baseUrl: ctx.llmBaseUrl,
    });

    await llmCall('classify', 'what is the weather today');

    const hits = posts(expectedPath);
    expect(hits).toHaveLength(1);
    expect(hits[0].headers['authorization']).toBe(authorization);
    expect(hits[0].body.model).toMatch(model);
    expect(escaped).toEqual([]);
  });
});

describe('start: the RAG bootstrap', () => {
  it('embeds knowledge files at OPENAI_BASE_URL with the OpenAI key, not the primary provider key', async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY');
    const workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-base-urls-'));
    try {
      await fs.mkdir(path.join(workingDirectory, 'knowledge'));
      await fs.writeFile(path.join(workingDirectory, 'knowledge', 'notes.md'), '# Notes\n\nThe agent keeps its notes here.\n');
      const upserts: unknown[] = [];
      const ctx = {
        providerId: 'anthropic',
        llmApiKey: KEYS.ANTHROPIC_API_KEY,
        workingDirectory,
        agentStorageManager: {
          getStateStore: () => ({ get: async () => null, set: async () => {} }),
          getVectorStore: () => ({ upsert: async (_collection: string, docs: unknown[]) => { upserts.push(...docs); } }),
        },
      };

      await bootstrapRagKnowledge(ctx);

      const hits = posts('/openai/v1/embeddings');
      expect(hits).toHaveLength(1);
      expect(hits[0].headers['authorization']).toBe(`Bearer ${KEYS.OPENAI_API_KEY}`);
      expect(upserts.length).toBeGreaterThan(0);
      expect(escaped).toEqual([]);
    } finally {
      await fs.rm(workingDirectory, { recursive: true, force: true });
    }
  });
});

describe('start: the discovery index', () => {
  it.each([
    ['openai', 'OPENAI_API_KEY', '/openai/v1'],
    ['anthropic', 'OPENAI_API_KEY', '/openai/v1'],
    ['openrouter', 'OPENROUTER_API_KEY', '/openrouter/api/v1'],
  ])('a %s primary embeds capabilities at the base-URL variable', async (provider, keyName, base) => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY');
    const ctx = await startCtx(provider);

    const embedding = resolveEmbeddingConfig({
      llmProviderId: ctx.providerId,
      llmApiKey: ctx.llmApiKey,
      llmBaseUrl: ctx.llmBaseUrl,
    });

    expect(embedding?.baseUrl).toBe(`${origin}${base}`);
    expect(embedding?.apiKey).toBe(KEYS[keyName]);
  });

  // `discovery.embeddingProvider` in agent.config.json names an embedding
  // provider other than the LLM's: the index embeds with that provider's own
  // key at its own base-URL variable, never with the LLM provider's key or URL.
  it.each([
    ['anthropic', 'openai', 'OPENAI_API_KEY', '/openai/v1'],
    ['openrouter', 'openai', 'OPENAI_API_KEY', '/openai/v1'],
    ['openai', 'openrouter', 'OPENROUTER_API_KEY', '/openrouter/api/v1'],
    ['anthropic', 'openrouter', 'OPENROUTER_API_KEY', '/openrouter/api/v1'],
  ])('a %s primary with discovery.embeddingProvider %s embeds with %s at its base-URL variable', async (provider, embeddingProvider, keyName, base) => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY');
    const ctx = await startCtx(provider);

    const embedding = resolveEmbeddingConfig({
      embeddingProvider,
      llmProviderId: ctx.providerId,
      llmApiKey: ctx.llmApiKey,
      llmBaseUrl: ctx.llmBaseUrl,
    });

    expect(embedding?.providerId).toBe(embeddingProvider);
    expect(embedding?.baseUrl).toBe(`${origin}${base}`);
    expect(embedding?.apiKey).toBe(KEYS[keyName]);
  });

  it("an embedding provider whose key is unset gets no index, never the LLM provider's key", async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY');
    const ctx = await startCtx('openai');

    const embedding = resolveEmbeddingConfig({
      embeddingProvider: 'openrouter',
      llmProviderId: ctx.providerId,
      llmApiKey: ctx.llmApiKey,
      llmBaseUrl: ctx.llmBaseUrl,
    });

    expect(embedding).toBeNull();
  });
});

describe('start: with the variables unset', () => {
  it.each([
    ['openai', 'https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
    ['anthropic', 'https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/messages'],
    ['openrouter', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
  ])("the %s primary goes to the provider's own endpoint", async (provider, base, expectedUrl) => {
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY');
    const ctx = await startCtx(provider);

    expect(ctx.llmBaseUrl).toBe(base);
    await runPrimaryTurn(ctx);

    expect(escaped.filter((r) => r.method === 'POST').map((r) => r.url)).toEqual([expectedUrl]);
    expect(seen).toEqual([]);
  });

  it("the fallback candidates and the memory tool use the providers' own endpoints", async () => {
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY');
    const openaiPrimary = await startCtx('openai');
    expect(openaiPrimary.openrouterFallback.baseUrl).toBe('https://api.anthropic.com/v1');
    const anthropicPrimary = await startCtx('anthropic');
    expect(anthropicPrimary.openrouterFallback.baseUrl).toBe('https://api.openai.com/v1');

    const tool = createLocalMemoryReadTool({ vectorStore: fakeVectorStore, openaiApiKey: KEYS.OPENAI_API_KEY });
    await tool.execute({ query: 'what did I say yesterday' }, {});

    expect(escaped.map((r) => r.url)).toEqual(['https://api.openai.com/v1/embeddings']);
    expect(seen).toEqual([]);
  });
});

// ── The turn a webhook wakes ────────────────────────────────────────────────

const WEBHOOK = { id: 'gh', secret: 's', mode: 'turn' };

/** The route deps `wunderland start` builds from the provider setup's ctx. */
function startDeps(ctx: any): any {
  return {
    ...ctx,
    seed: { seedId: ctx.seedId },
    activePersonaId: 'default',
    systemPrompt: 'You are a test agent.',
    toolMap: new Map(),
    sessions: new Map(),
    broadcastAgentEvent: () => {},
  };
}

/** Serves start's routes (dispatchRoute) for `deps` on 127.0.0.1. */
async function serveStartRoutes(deps: any): Promise<{ url: string; close: () => Promise<void> }> {
  const routes = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (!(await dispatchRoute(req, res, url, deps))) {
        res.writeHead(404);
        res.end();
      }
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  await new Promise<void>((resolve) => routes.listen(0, '127.0.0.1', () => resolve()));
  const address = routes.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      routes.closeAllConnections?.();
      routes.close(() => resolve());
    }),
  };
}

/** POST /webhooks/gh with the hook's bearer secret, past the fetch guard. */
function postWebhook(routesUrl: string): Promise<Response> {
  return realFetch(`${routesUrl}/webhooks/gh`, {
    method: 'POST',
    headers: { Authorization: 'Bearer s', 'Content-Type': 'text/plain' },
    body: 'a push landed on master',
  });
}

describe('start: the turn a webhook wakes', () => {
  beforeEach(() => resetWebhookRateLimiter());

  it.each([
    ['openai', '/openai/v1/chat/completions', 'authorization', `Bearer ${KEYS.OPENAI_API_KEY}`],
    ['anthropic', '/anthropic/v1/messages', 'x-api-key', KEYS.ANTHROPIC_API_KEY],
    ['openrouter', '/openrouter/api/v1/chat/completions', 'authorization', `Bearer ${KEYS.OPENROUTER_API_KEY}`],
  ])('a %s primary sends the webhook turn to its base-URL variable', async (provider, expectedPath, header, headerValue) => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY');
    const ctx = await startCtx(provider, { webhooks: [WEBHOOK] });
    const routes = await serveStartRoutes(startDeps(ctx));
    try {
      const res = await postWebhook(routes.url);
      expect(res.status).toBe(202);

      // The turn runs after the 202, so wait for it to reach the fake.
      await vi.waitFor(() => expect(posts(expectedPath)).toHaveLength(1), { timeout: 10_000, interval: 50 });
      expect(posts(expectedPath)[0].headers[header]).toBe(headerValue);
      expect(escaped).toEqual([]);
    } finally {
      await routes.close();
    }
  });

  it('a webhook turn whose primary fails goes to the fallback candidate at its base-URL variable', async () => {
    pointVariablesAtFake();
    // The fake answers 503 under /down/, so the primary fails and the turn
    // falls back to the Anthropic candidate.
    process.env['OPENAI_BASE_URL'] = `${origin}/down/v1`;
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY');
    const ctx = await startCtx('openai', { webhooks: [WEBHOOK] });
    const routes = await serveStartRoutes(startDeps(ctx));
    try {
      expect((await postWebhook(routes.url)).status).toBe(202);

      await vi.waitFor(() => expect(posts('/anthropic/v1/chat/completions')).toHaveLength(1), { timeout: 10_000, interval: 50 });
      expect(posts('/down/v1/chat/completions')).toHaveLength(1);
      expect(posts('/anthropic/v1/chat/completions')[0].headers['authorization']).toBe(`Bearer ${KEYS.ANTHROPIC_API_KEY}`);
      expect(escaped).toEqual([]);
    } finally {
      await routes.close();
    }
  });
});

// ── The Discord welcome and curated picks posts ─────────────────────────────
// A live Discord gateway is not available in CI, so these drive the real
// handlers through a fake Discord service: the welcome handler as start wires
// it (wireDiscordExtensions), the curated picks handler's curation cycle
// directly (start schedules its first cycle 30 minutes after boot).

function fakeDiscordService() {
  const joins: Array<(member: any) => Promise<void>> = [];
  const sent: Array<{ channelId: string; text: string; opts: any }> = [];
  return {
    joins,
    sent,
    onMemberJoin: (cb: (member: any) => Promise<void>) => {
      joins.push(cb);
    },
    sendMessage: async (channelId: string, text: string, opts: any) => {
      sent.push({ channelId, text, opts });
    },
    getClient: () => undefined,
  };
}

function newMember(): any {
  const member: any = {
    id: 'user-1',
    displayName: 'Newcomer',
    user: { id: 'user-1', username: 'newcomer', bot: false, createdAt: new Date() },
    roles: { cache: [{ name: 'onboard:ai' }] },
  };
  member.guild = { members: { fetch: async () => member } };
  return member;
}

describe('start: the Discord welcome and curated picks posts', () => {
  it('a guildMemberAdd sends the welcome request to OPENAI_BASE_URL with an operation id', async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY');
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;
    const service = fakeDiscordService();

    await wireDiscordExtensions({
      activePacks: [],
      adapterByPlatform: new Map([['discord', { service }]]),
      cfg: { feeds: { channels: { welcome: 'welcome-channel' } } },
    });
    expect(service.joins).toHaveLength(1);

    // The handler waits for the onboarding roles (3 s) and the join message (5 s).
    await service.joins[0](newMember());

    const hits = posts('/openai/v1/chat/completions');
    expect(hits).toHaveLength(1);
    expect(hits[0].headers['authorization']).toBe(`Bearer ${KEYS.OPENAI_API_KEY}`);
    expect(hits[0].headers[OP_HEADER]).toMatch(UUID_RE);
    expect(service.sent.map((s) => s.channelId)).toEqual(['welcome-channel']);
    expect(escaped).toEqual([]);
  }, 30_000);

  it('a curation cycle sends the judge and copy requests to OPENAI_BASE_URL, each with its own operation id', async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY');
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-picks-'));
    try {
      const service = fakeDiscordService();
      const picks = createCuratedPicksHandler({
        channelId: 'picks-channel',
        openaiApiKey: KEYS.OPENAI_API_KEY,
        systemPrompt: '',
        scraperApiUrl: `${origin}/scraper`,
        cacheFile: path.join(dir, 'curated-picks-cache.json'),
      });

      await picks.runCurationCycle(service);

      const hits = posts('/openai/v1/chat/completions');
      expect(hits).toHaveLength(2);
      for (const hit of hits) {
        expect(hit.headers['authorization']).toBe(`Bearer ${KEYS.OPENAI_API_KEY}`);
        expect(hit.headers[OP_HEADER]).toMatch(UUID_RE);
      }
      expect(hits[0].headers[OP_HEADER]).not.toBe(hits[1].headers[OP_HEADER]);
      expect(service.sent.map((s) => s.channelId)).toEqual(['picks-channel']);
      expect(escaped).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('cycles started together run one at a time, so they post no more than the daily limit of 2', async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-picks-'));
    try {
      const service = fakeDiscordService();
      const picks = createCuratedPicksHandler({
        channelId: 'picks-channel',
        openaiApiKey: KEYS.OPENAI_API_KEY,
        systemPrompt: '',
        scraperApiUrl: `${origin}/scraper`,
        cacheFile: path.join(dir, 'curated-picks-cache.json'),
      });

      await Promise.all([
        picks.runCurationCycle(service),
        picks.runCurationCycle(service),
        picks.runCurationCycle(service),
      ]);

      expect(service.sent).toHaveLength(2);
      const cache = JSON.parse(await fs.readFile(path.join(dir, 'curated-picks-cache.json'), 'utf8'));
      expect(cache).toHaveLength(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── The operation id header ─────────────────────────────────────────────────

function opIds(requests: Seen[]): unknown[] {
  return requests.map((r) => r.headers[OP_HEADER]);
}

describe('start: the operation id header (AGENTOS_OPERATION_ID_HEADER)', () => {
  it.each([
    ['openai', '/openai/v1/chat/completions'],
    ['anthropic', '/anthropic/v1/messages'],
    ['openrouter', '/openrouter/api/v1/chat/completions'],
  ])('each %s primary turn carries one, and the next call a new one', async (provider, expectedPath) => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY');
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;
    const ctx = await startCtx(provider);

    await runPrimaryTurn(ctx);
    await runPrimaryTurn(ctx);

    const ids = opIds(posts(expectedPath));
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(UUID_RE);
    expect(ids[1]).toMatch(UUID_RE);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("a call's fallback attempt carries the same id as its failed primary attempt", async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY');
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;
    const ctx = await startCtx('openai');

    await openaiChatWithTools({
      apiKey: 'sk-down',
      model: 'model-down',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      temperature: 0,
      maxTokens: 8,
      baseUrl: `${origin}/down/v1`,
      fallback: ctx.openrouterFallback,
    });

    const failed = posts('/down/v1/chat/completions');
    const fallback = posts('/anthropic/v1/chat/completions');
    expect(failed).toHaveLength(1);
    expect(fallback).toHaveLength(1);
    expect(failed[0].headers[OP_HEADER]).toMatch(UUID_RE);
    expect(fallback[0].headers[OP_HEADER]).toBe(failed[0].headers[OP_HEADER]);
  });

  it("the memory tool's embedding and its HyDE call each carry one", async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY');
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;
    const ctx = await startCtx('anthropic');
    const tool = createLocalMemoryReadTool({
      vectorStore: fakeVectorStore,
      openaiApiKey: KEYS.OPENAI_API_KEY,
      embeddingModel: 'text-embedding-3-small',
      hyde: { enabled: true, llm: { apiKey: ctx.llmApiKey, model: ctx.model, baseUrl: ctx.llmBaseUrl } },
    });

    await tool.execute({ query: 'what did I say yesterday' }, {});

    const hyde = opIds(posts('/anthropic/v1/chat/completions'));
    const embeddings = opIds(posts('/openai/v1/embeddings'));
    expect(hyde).toHaveLength(1);
    expect(embeddings.length).toBeGreaterThanOrEqual(1);
    for (const id of [...hyde, ...embeddings]) expect(id).toMatch(UUID_RE);
    expect(embeddings).not.toContain(hyde[0]);
  });

  it('the RAG bootstrap embeddings carry one', async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY');
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;
    const workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-op-id-'));
    try {
      await fs.mkdir(path.join(workingDirectory, 'knowledge'));
      await fs.writeFile(path.join(workingDirectory, 'knowledge', 'notes.md'), '# Notes\n\nThe agent keeps its notes here.\n');
      await bootstrapRagKnowledge({
        providerId: 'openai',
        llmApiKey: KEYS.OPENAI_API_KEY,
        workingDirectory,
        agentStorageManager: {
          getStateStore: () => ({ get: async () => null, set: async () => {} }),
          getVectorStore: () => ({ upsert: async () => {} }),
        },
      });

      const ids = opIds(posts('/openai/v1/embeddings'));
      expect(ids).toHaveLength(1);
      expect(ids[0]).toMatch(UUID_RE);
    } finally {
      await fs.rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('the research classifier carries one', async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY');
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;
    const ctx = await startCtx('openai');
    const llmCall = createResearchClassifierLlmCall({ providerId: ctx.providerId, apiKey: ctx.llmApiKey, baseUrl: ctx.llmBaseUrl });

    await llmCall('classify', 'what is the weather today');
    await llmCall('classify', 'and tomorrow');

    const ids = opIds(posts('/openai/v1/chat/completions'));
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(UUID_RE);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it.each([
    ['openai', 'gpt-4o-mini', '/openai/v1/'],
    ['openrouter', 'openai/gpt-4o-mini', '/openrouter/api/v1/'],
    ['anthropic', 'claude-haiku-4-5-20251001', '/anthropic/v1/messages'],
  ])('a %s LLM judge request carries one', async (judgeProvider, judgeModel, prefix) => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY');
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;
    const ctx = await startCtx('openai', { hitl: { mode: 'llm-judge', judgeProvider, judgeModel } });

    await ctx.llmJudgeHandler({ name: 'send_message', hasSideEffects: true }, {});

    const ids = opIds(posts(prefix));
    expect(ids.length).toBeGreaterThanOrEqual(1);
    for (const id of ids) expect(id).toMatch(UUID_RE);
    expect(escaped).toEqual([]);
  }, 30_000);

  it.each([
    ['openai', '/openai/v1/embeddings', 'OPENAI_API_KEY'],
    ['openrouter', '/openrouter/api/v1/embeddings', 'OPENROUTER_API_KEY'],
  ])('a %s primary: the discovery index embeddings carry one', async (provider, expectedPath, keyName) => {
    pointVariablesAtFake();
    setKeys(keyName as keyof typeof KEYS);
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;
    const ctx = await startCtx(provider);
    const manager = new WunderlandDiscoveryManager({ scanManifestDirs: false, registerMetaTool: false });

    try {
      await manager.initialize({
        toolMap: new Map([
          ['web_search', { name: 'web_search', description: 'Search the web', category: 'research', inputSchema: { type: 'object' }, hasSideEffects: false }],
        ]),
        llmConfig: { providerId: ctx.providerId, apiKey: ctx.llmApiKey, baseUrl: ctx.llmBaseUrl },
      });
    } finally {
      await manager.close();
    }

    const ids = opIds(posts(expectedPath));
    expect(ids.length).toBeGreaterThanOrEqual(1);
    for (const id of ids) expect(id).toMatch(UUID_RE);
    expect(escaped).toEqual([]);
  }, 60_000);

  it('with the variable unset, no request carries the header', async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY', 'ANTHROPIC_API_KEY');
    const ctx = await startCtx('openai');

    await runPrimaryTurn(ctx);
    await createResearchClassifierLlmCall({ providerId: ctx.providerId, apiKey: ctx.llmApiKey, baseUrl: ctx.llmBaseUrl })('classify', 'hello');
    await createLocalMemoryReadTool({ vectorStore: fakeVectorStore, openaiApiKey: KEYS.OPENAI_API_KEY }).execute({ query: 'hello' }, {});

    expect(seen.filter((r) => r.method === 'POST').length).toBeGreaterThanOrEqual(3);
    expect(seen.filter((r) => OP_HEADER in r.headers)).toEqual([]);
    expect(escaped).toEqual([]);
  });

  it('a variable naming a header the provider sets itself stops start before any request', async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY');
    process.env['AGENTOS_OPERATION_ID_HEADER'] = 'Authorization';
    const previousExitCode = process.exitCode;
    try {
      const ctx: any = {
        flags: { provider: 'openai' },
        globals: { autoApproveTools: false },
        cfg: {},
        policy: { executionMode: 'human-all' },
        seedId: 'seed-base-urls',
        globalConfig: {},
      };
      expect(await setupLlmProvider(ctx)).toBe(false);
    } finally {
      process.exitCode = previousExitCode;
    }
    expect(seen).toEqual([]);
    expect(escaped).toEqual([]);
  });
});

// ── ANTHROPIC_BASE_URL with and without /v1 ─────────────────────────────────

const ANTHROPIC_FORMS = [
  ['without /v1', ''],
  ['with /v1', '/v1'],
  ['with a trailing slash', '/'],
  ['with /v1 and a trailing slash', '/v1/'],
];

describe('ANTHROPIC_BASE_URL: every Anthropic caller joins the root and the path the same way', () => {
  it.each(ANTHROPIC_FORMS)("the mission planner's --planner-model anthropic/... request goes to <root>/v1/chat/completions (%s)", async (_form, suffix) => {
    pointVariablesAtFake({ anthropicSuffix: suffix });
    setKeys('ANTHROPIC_API_KEY');
    const runtime = { providerId: 'openai', model: 'gpt-4o', apiKey: 'rt', baseUrl: 'https://api.openai.com/v1' };

    const planner = resolveMissionModel('anthropic/claude-test', runtime, process.env);
    expect(planner.baseUrl).toBe(`${origin}/anthropic/v1`);
    await chatCompletionsRequest(
      { apiKey: planner.apiKey, model: planner.model, baseUrl: planner.baseUrl },
      [{ role: 'user', content: 'plan this' }],
      [],
      0.2,
      16,
    );

    expect(posts('/anthropic/').map((r) => r.url)).toEqual(['/anthropic/v1/chat/completions']);
    expect(posts('/anthropic/')[0].headers['authorization']).toBe(`Bearer ${KEYS.ANTHROPIC_API_KEY}`);
    expect(escaped).toEqual([]);
  });

  it.each(ANTHROPIC_FORMS)("the mission planner's runtime default for an Anthropic key goes to <root>/v1/chat/completions (%s)", async (_form, suffix) => {
    pointVariablesAtFake({ anthropicSuffix: suffix });
    setKeys('ANTHROPIC_API_KEY');

    const runtime = resolveWunderlandRuntimeConfigFromEnv();
    expect(runtime.providerId).toBe('anthropic');
    expect(runtime.baseUrl).toBe(`${origin}/anthropic/v1`);
    expect(resolveMissionProviderBaseUrl('anthropic', process.env)).toBe(`${origin}/anthropic/v1`);
    await chatCompletionsRequest(
      { apiKey: runtime.apiKey, model: runtime.model, baseUrl: runtime.baseUrl },
      [{ role: 'user', content: 'plan this' }],
      [],
      0.2,
      16,
    );

    expect(posts('/anthropic/').map((r) => r.url)).toEqual(['/anthropic/v1/chat/completions']);
    expect(escaped).toEqual([]);
  });

  it.each(ANTHROPIC_FORMS)('the Messages API request goes to <root>/v1/messages (%s)', async (_form, suffix) => {
    pointVariablesAtFake({ anthropicSuffix: suffix });
    setKeys('ANTHROPIC_API_KEY');
    const request = {
      apiKey: KEYS.ANTHROPIC_API_KEY,
      model: 'claude-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
      temperature: 0,
      maxTokens: 8,
    };

    // With no base URL the request reads ANTHROPIC_BASE_URL; given the raw
    // variable it joins the same way.
    await anthropicMessagesRequest(request);
    await anthropicMessagesRequest({ ...request, baseUrl: process.env['ANTHROPIC_BASE_URL'] });

    expect(anthropicApiUrl('messages')).toBe(`${origin}/anthropic/v1/messages`);
    expect(posts('/anthropic/').map((r) => r.url)).toEqual(['/anthropic/v1/messages', '/anthropic/v1/messages']);
    expect(escaped).toEqual([]);
  });
});

// ── wunderland chat ─────────────────────────────────────────────────────────
// `chat` is a terminal session, so these drive what it builds: the primary base
// URL it shares with `start`, its query router and its LLM caller.

describe('chat: the primary provider, the query router and the LLM caller', () => {
  let workDir = '';

  beforeEach(async () => {
    resetCliQueryRouterForTests();
    // The router adds <cwd>/docs to its corpus; an empty folder keeps to the bundled knowledge.
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-chat-base-urls-'));
    vi.spyOn(process, 'cwd').mockReturnValue(workDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetCliQueryRouterForTests();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  const silent = { log() {}, warn() {}, error() {}, debug() {} };

  it.each([
    ['openai', 'OPENAI_API_KEY', '/openai/v1/chat/completions'],
    ['anthropic', 'ANTHROPIC_API_KEY', '/anthropic/v1/messages'],
    ['openrouter', 'OPENROUTER_API_KEY', '/openrouter/api/v1/chat/completions'],
  ])('a %s primary turn goes to its base-URL variable with an operation id', async (provider, keyName, expectedPath) => {
    pointVariablesAtFake();
    setKeys(keyName as keyof typeof KEYS);
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;

    await runToolCallingTurn({
      providerId: provider,
      apiKey: KEYS[keyName as keyof typeof KEYS],
      model: 'model-test',
      messages: [{ role: 'user', content: 'hello' }],
      toolMap: new Map(),
      toolContext: {},
      maxRounds: 1,
      dangerouslySkipPermissions: true,
      askPermission: async () => true,
      baseUrl: primaryBaseUrlFor(provider, { ollamaBaseUrl: 'http://localhost:11434/v1' }),
    });

    expect(posts(expectedPath)).toHaveLength(1);
    expect(opIds(posts(expectedPath))[0]).toMatch(UUID_RE);
    expect(escaped).toEqual([]);
  });

  it("primaryBaseUrlFor keeps Ollama's and Gemini's own roots", () => {
    expect(primaryBaseUrlFor('ollama', { ollamaBaseUrl: 'http://box:11434/v1' })).toBe('http://box:11434/v1');
    expect(primaryBaseUrlFor('gemini', { ollamaBaseUrl: '' })).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
  });

  it.each([
    ['an OpenAI key', 'OPENAI_API_KEY', '/openai/v1/'],
    ['an OpenRouter key', 'OPENROUTER_API_KEY', '/openrouter/api/v1/'],
  ])('with %s, the classifier and the corpus embeddings reach the base-URL variable with an operation id', async (_label, keyName, prefix) => {
    pointVariablesAtFake();
    setKeys(keyName as keyof typeof KEYS);
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;

    const router = await initCliQueryRouter({ apiKey: KEYS[keyName as keyof typeof KEYS], logger: silent });
    expect(router).not.toBeNull();
    try {
      await router!.classify('How do I configure a provider?');
    } finally {
      await router!.close();
    }

    const embeddings = posts(`${prefix}embeddings`);
    expect(embeddings.length).toBeGreaterThanOrEqual(1);
    const classifier = posts(prefix).filter((r) => !r.url.endsWith('/embeddings'));
    expect(classifier.length).toBeGreaterThanOrEqual(1);
    for (const id of opIds([...embeddings, ...classifier])) expect(id).toMatch(UUID_RE);
    expect(escaped).toEqual([]);
  }, 120_000);

  it.each([
    ['openai', 'OPENAI_API_KEY', '/openai/v1/chat/completions'],
    ['openrouter', 'OPENROUTER_API_KEY', '/openrouter/api/v1/chat/completions'],
    ['anthropic', 'ANTHROPIC_API_KEY', '/anthropic/v1/chat/completions'],
  ])("the %s LLM caller goes to its base-URL variable, each call with its own operation id", async (provider, keyName, expectedPath) => {
    pointVariablesAtFake();
    setKeys(keyName as keyof typeof KEYS);
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;
    const call = createChatLlmCaller({
      apiKey: KEYS[keyName as keyof typeof KEYS],
      model: 'model-test',
      baseUrl: primaryBaseUrlFor(provider, { ollamaBaseUrl: '' }),
    });

    await call('first');
    await call('second');

    const ids = opIds(posts(expectedPath));
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(UUID_RE);
    expect(ids[1]).toMatch(UUID_RE);
    expect(ids[0]).not.toBe(ids[1]);
    expect(escaped).toEqual([]);
  });
});

// ── The job executor ────────────────────────────────────────────────────────

describe('the job executor', () => {
  const job = {
    id: 'job-base-urls',
    title: 'Write a report',
    description: 'Write a short report',
    category: 'research',
    budgetLamports: 1,
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };

  it.each([
    ['OPENAI_API_KEY', '/openai/v1/chat/completions', `Bearer ${KEYS.OPENAI_API_KEY}`],
    ['OPENROUTER_API_KEY', '/openrouter/api/v1/chat/completions', `Bearer ${KEYS.OPENROUTER_API_KEY}`],
  ])('with %s, its LLM call goes to the base-URL variable with an operation id', async (keyName, expectedPath, authorization) => {
    pointVariablesAtFake();
    setKeys(keyName as keyof typeof KEYS);
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;
    const executor = new JobExecutor({
      fetchAssignedJobs: async () => [],
      maxRetries: 1,
      baseRetryDelayMs: 1,
    });

    await executor.executeJob('agent-1', job);

    expect(posts(expectedPath).length).toBeGreaterThanOrEqual(1);
    expect(posts(expectedPath)[0].headers['authorization']).toBe(authorization);
    expect(opIds(posts(expectedPath))[0]).toMatch(UUID_RE);
    expect(escaped).toEqual([]);
  });

  it('with the variables unset, its LLM call goes to OpenAI', async () => {
    setKeys('OPENAI_API_KEY');
    const executor = new JobExecutor({ fetchAssignedJobs: async () => [], maxRetries: 1, baseRetryDelayMs: 1 });

    await executor.executeJob('agent-1', job);

    expect(escaped[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(escaped[0]?.headers[OP_HEADER]).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

// ── Callers that name no base URL ───────────────────────────────────────────

describe('a provider call that names no base URL', () => {
  it('an OpenAI-compatible request reads OPENAI_BASE_URL', async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY');

    await openaiChatWithTools({
      apiKey: KEYS.OPENAI_API_KEY,
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      temperature: 0,
      maxTokens: 8,
    });

    expect(posts('/openai/v1/chat/completions')).toHaveLength(1);
    expect(escaped).toEqual([]);
  });

  it('the research classifier reads OPENAI_BASE_URL', async () => {
    pointVariablesAtFake();
    setKeys('OPENAI_API_KEY');

    await createResearchClassifierLlmCall({ apiKey: KEYS.OPENAI_API_KEY })('classify', 'hello');

    expect(posts('/openai/v1/chat/completions')).toHaveLength(1);
    expect(escaped).toEqual([]);
  });
});

/**
 * Provider roots written in source. Every other file gets its URL from
 * `provider-base-urls.ts`, so a gateway named by a base-URL variable sees it.
 * `constants.ts` holds the provider catalogue the wizards show; the key check
 * that used to read its URLs asks `provider-base-urls.ts` instead.
 */
const ROOT_LITERAL = /['"`]https:\/\/(?:api\.openai\.com|openrouter\.ai\/api|api\.anthropic\.com)/;
const FILES_THAT_MAY_NAME_A_ROOT = new Set([
  path.join('platform', 'config', 'provider-base-urls.ts'),
  path.join('cli', 'constants.ts'),
]);

describe('provider roots in source', () => {
  it('no file sends to a provider root the variables cannot move', async () => {
    const srcDir = path.resolve(__dirname, '../../../..');
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') await walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        const relative = path.relative(srcDir, full);
        if (FILES_THAT_MAY_NAME_A_ROOT.has(relative)) continue;
        const lines = (await fs.readFile(full, 'utf8')).split('\n');
        lines.forEach((line, index) => {
          const trimmed = line.trimStart();
          const isComment = trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
          if (!isComment && ROOT_LITERAL.test(line)) offenders.push(`${relative}:${index + 1}`);
        });
      }
    };

    await walk(srcDir);

    expect(offenders).toEqual([]);
  });
});

// ── A channel message's fallback ────────────────────────────────────────────

describe('start: a channel message falls back like the /chat route and the webhook turn', () => {
  /** Sends one channel message through the real handler; returns what the adapter sent. */
  async function sendChannelMessage(ctx: any): Promise<unknown[]> {
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
      discoveryManager: { discoverForTurn: async () => null },
      adaptiveRuntime: {
        resolveTurnDecision: () => ({ toolFailureMode: 'fail_open', degraded: false, reason: '', actions: {}, kpi: null }),
        recordTurnOutcome: async () => {},
      },
      defaultTenantId: '',
      toolMap: new Map(),
      seed: { seedId: ctx.seedId },
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
      text: 'hello',
      sender: { id: 'user-1' },
    });
    return adapter.sendMessage.mock.calls.map((call: any[]) => call[1]?.blocks?.[0]?.text);
  }

  it.each([
    ['openai', 'OPENAI_BASE_URL', `/down/v1`, ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'], '/down/v1/chat/completions', '/anthropic/v1/chat/completions'],
    ['openrouter', 'OPENROUTER_BASE_URL', `/down/api/v1`, ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'], '/down/api/v1/chat/completions', '/anthropic/v1/chat/completions'],
    ['anthropic', 'ANTHROPIC_BASE_URL', `/down`, ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], '/down/v1/messages', '/openai/v1/chat/completions'],
  ])('a %s primary that fails goes to the fallback candidate, with one operation id', async (provider, variable, downPath, keys, primaryPath, fallbackPath) => {
    pointVariablesAtFake();
    process.env[variable] = `${origin}${downPath}`;
    setKeys(...(keys as Array<keyof typeof KEYS>));
    process.env['AGENTOS_OPERATION_ID_HEADER'] = OP_HEADER;
    const ctx = await startCtx(provider);

    const sent = await sendChannelMessage(ctx);

    expect(posts(primaryPath)).toHaveLength(1);
    expect(posts(fallbackPath)).toHaveLength(1);
    expect(posts(fallbackPath)[0].headers[OP_HEADER]).toBe(posts(primaryPath)[0].headers[OP_HEADER]);
    expect(sent).toEqual([JUDGE_TEXT]);
    expect(escaped).toEqual([]);
  });

  it('with no fallback candidate, the failure stays a failure', async () => {
    process.env['ANTHROPIC_BASE_URL'] = `${origin}/down`;
    setKeys('ANTHROPIC_API_KEY');
    const ctx = await startCtx('anthropic');
    expect(ctx.openrouterFallback).toBeUndefined();

    await expect(runPrimaryTurn(ctx)).rejects.toThrow(/503/);
    expect(posts('/down/v1/messages')).toHaveLength(1);
    expect(escaped).toEqual([]);
  });

  it('an Anthropic error that is not worth retrying does not fall back', async () => {
    process.env['ANTHROPIC_BASE_URL'] = `${origin}/down`;
    process.env['OPENAI_BASE_URL'] = `${origin}/openai/v1`;
    setKeys('ANTHROPIC_API_KEY', 'OPENAI_API_KEY');
    const ctx = await startCtx('anthropic');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/down/')) {
        seen.push({ method: 'POST', url: new URL(url).pathname, headers: {}, body: undefined });
        return new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 });
      }
      return guardedFetch(input, init);
    });

    await expect(runPrimaryTurn(ctx)).rejects.toThrow(/400/);
    expect(posts('/openai/v1/chat/completions')).toEqual([]);
  });

  it('an Ollama primary that cannot be reached goes to the fallback candidate', async () => {
    process.env['OLLAMA_BASE_URL'] = `${origin}/down/ollama`;
    process.env['OPENAI_BASE_URL'] = `${origin}/openai/v1`;
    setKeys('OPENAI_API_KEY');
    const ctx = await startCtx('ollama');
    expect(ctx.openrouterFallback).toBeDefined();

    await runPrimaryTurn(ctx);

    expect(posts('/openai/v1/chat/completions')).toHaveLength(1);
    expect(escaped).toEqual([]);
  }, 30_000);
});
