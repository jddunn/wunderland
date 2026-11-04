// @ts-nocheck
/**
 * `wunderland start` sends each provider's calls to that provider's base-URL
 * variable (OPENAI_BASE_URL, ANTHROPIC_BASE_URL, OPENROUTER_BASE_URL): the
 * primary provider's turns, the fallback chain, the LLM judge, the local
 * memory tool's embeddings and HyDE call, the RAG bootstrap's embeddings and
 * the discovery index's embeddings. With the variables unset, every call goes
 * to the provider's own endpoint.
 *
 * Each variable points at one fake provider server on 127.0.0.1, under its own
 * path prefix. `fetch` is wrapped so a request for any other origin is answered
 * in process and recorded instead of leaving the machine; every case but the
 * unset one asserts that none did.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { setupLlmProvider } from '../llm-provider-setup.js';
import { createLocalMemoryReadTool } from '../local-memory-tool.js';
import { bootstrapRagKnowledge } from '../rag-bootstrap.js';
import { runToolCallingTurn, openaiChatWithTools } from '../../../../runtime/tools/tool-calling.js';
import { resolveEmbeddingConfig } from '../../../../platform/discovery/WunderlandDiscoveryManager.js';
import { createResearchClassifierLlmCall } from '../../../../runtime/agentos-bridge/research-classifier.js';

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
];

/** The judge's answer, valid JSON for AgentOS's llmJudge parser. */
const JUDGE_TEXT = JSON.stringify({ approved: true, confidence: 0.95, reasoning: 'fine' });

type Seen = { method: string; url: string; headers: Record<string, unknown>; body: any };

/** Requests the fake provider server received (path only). */
const seen: Seen[] = [];
/** Requests for any origin other than the fake server (full URL). */
const escaped: Seen[] = [];

let server: Server;
let origin = '';
let realFetch: typeof fetch;

/** The fake's answer for a request path, in each provider's own wire shape. */
function answer(method: string, url: string, body: any): { status: number; json: unknown } {
  const pathname = url.split('?')[0] ?? '';
  if (pathname.includes('/down/')) {
    return { status: 503, json: { error: { message: 'unavailable' } } };
  }
  if (pathname.endsWith('/embeddings')) {
    const inputs = Array.isArray(body?.input) ? body.input : [body?.input];
    return {
      status: 200,
      json: {
        object: 'list',
        model: body?.model ?? 'text-embedding-3-small',
        data: inputs.map((_: unknown, index: number) => ({ object: 'embedding', index, embedding: [0.1, 0.2, 0.3] })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
    };
  }
  if (pathname.endsWith('/v1/messages')) {
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
        data: ['gpt-4o-mini', 'openai/gpt-4o-mini', 'text-embedding-3-small'].map((id) => ({
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
    return {
      status: 200,
      json: {
        id: 'chatcmpl_test',
        object: 'chat.completion',
        created: 0,
        model: body?.model ?? 'gpt-test',
        choices: [{ index: 0, message: { role: 'assistant', content: JUDGE_TEXT }, finish_reason: 'stop' }],
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
  const { status, json } = answer(method, new URL(url).pathname, body);
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
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
      const { status, json } = answer(method, url, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
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

describe('start: the LLM judge', () => {
  it.each([
    ['openai', 'gpt-4o-mini', '/openai/v1/'],
    ['openrouter', 'openai/gpt-4o-mini', '/openrouter/api/v1/'],
  ])('a %s judge sends its request to the base-URL variable', async (judgeProvider, judgeModel, prefix) => {
    // The judge is AgentOS's: it reads the variable itself and appends its
    // paths to the value as set, without trimming, so these values are plain.
    pointVariablesAtFake({ plain: true });
    setKeys('OPENAI_API_KEY', 'OPENROUTER_API_KEY');
    const ctx = await startCtx('openai', { hitl: { mode: 'llm-judge', judgeProvider, judgeModel } });
    expect(typeof ctx.llmJudgeHandler).toBe('function');

    await ctx.llmJudgeHandler({ name: 'send_message', hasSideEffects: true }, { text: 'hello' });

    expect(posts(prefix).length).toBeGreaterThanOrEqual(1);
    expect(escaped).toEqual([]);
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
