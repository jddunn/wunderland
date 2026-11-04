// @ts-nocheck
/**
 * The hosted events path end to end: a spawned `wunderland start`, built by
 * `pnpm build`, with WUNDERLAND_EVENTS_URL and WUNDERLAND_EVENTS_TOKEN set and
 * OPENAI_BASE_URL at a fake provider. `POST /chat` turns reach the fake events
 * server with the token and the operation id, a 402 `allowance_exhausted` from
 * the provider answers the fixed line after one request, and SIGTERM sends what
 * is still waiting.
 *
 * The folder's `HOME` is a temporary one, so nothing reaches the real
 * `~/.wunderland`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../../../../bin/wunderland.js', import.meta.url));
const EVENTS_TOKEN = 'events-token-e2e';
const OP_HEADER = 'x-test-operation-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALLOWANCE_LINE = 'This agent has reached its monthly model allowance.';
const USER_WORDS = 'USER-WORDS-the-person-typed';
const MODEL_WORDS = 'MODEL-WORDS-the-model-wrote';

/** Start loads a whole agent; a runner's first load of its packs takes a while. */
const START_TIMEOUT_MS = 150_000;
const TEST_TIMEOUT_MS = 240_000;
/** Longer than the reporter's flush interval, shorter than a test's patience. */
const EVENT_WAIT_MS = 20_000;

type Seen = { url: string; headers: Record<string, any>; raw: string };

/** Starts a recording HTTP server on 127.0.0.1. */
async function startFake(answer: (seen: Seen) => { status: number; json: unknown }) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const entry = { url: req.url ?? '', headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') };
      seen.push(entry);
      const { status, json } = answer(entry);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, seen };
}

/** A port nothing listens on at this moment. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs: number, detail: () => string = () => ''): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('wunderland start with the events variables set', () => {
  let provider: Awaited<ReturnType<typeof startFake>>;
  let eventsServer: Awaited<ReturnType<typeof startFake>>;
  let child: ChildProcess;
  let exited = false;
  let output = '';
  let root = '';
  let port = 0;
  /** What the provider's next chat completion answers. */
  let nextChat: { status: number; json: unknown } = { status: 500, json: {} };

  const chatsSeen = () => provider.seen.filter((request) => request.url.endsWith('/chat/completions'));
  const events = () => eventsServer.seen.flatMap((request) => JSON.parse(request.raw).events);
  const kinds = () => events().map((event: any) => event.kind);
  const finishedCount = () => kinds().filter((kind: string) => kind === 'turn_finished').length;

  async function chat(message: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, autoClassify: false }),
    });
    return { status: res.status, body: await res.json() };
  }

  beforeAll(async () => {
    provider = await startFake(({ url }) => {
      if (url.endsWith('/chat/completions')) return nextChat;
      return { status: 404, json: { error: { message: 'not here' } } };
    });
    eventsServer = await startFake(() => ({ status: 202, json: { accepted: true } }));
    root = mkdtempSync(path.join(tmpdir(), 'wunderland-events-e2e-'));
    port = await freePort();
    writeFileSync(path.join(root, 'agent.config.json'), JSON.stringify({
      seedId: 'seed_events_e2e',
      displayName: 'Events E2E',
      llmProvider: 'openai',
      llmModel: 'gpt-test',
      executionMode: 'autonomous',
      tools: { allow: { packs: [], tools: [] } },
      discovery: { enabled: false },
      pairing: { enabled: false },
      research: { autoClassify: false },
    }));

    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !name.startsWith('VITEST') && name !== 'NODE_ENV' && !name.endsWith('_API_KEY')) {
        env[name] = value;
      }
    }
    Object.assign(env, {
      HOME: root,
      NO_COLOR: '1',
      OPENAI_API_KEY: 'sk-events-e2e',
      OPENAI_BASE_URL: `${provider.origin}/v1`,
      AGENTOS_OPERATION_ID_HEADER: OP_HEADER,
      WUNDERLAND_EVENTS_URL: `${eventsServer.origin}/hosted/agent`,
      WUNDERLAND_EVENTS_TOKEN: EVENTS_TOKEN,
    });

    child = spawn(process.execPath, [BIN, 'start', '--port', String(port), '--no-guardrails'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => { output += String(chunk); });
    child.stderr?.on('data', (chunk) => { output += String(chunk); });
    child.once('exit', () => { exited = true; });

    await until(async () => {
      if (exited) throw new Error(`wunderland start exited early\n${output}`);
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        return false;
      }
    }, 'the health route', START_TIMEOUT_MS, () => output);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (child && !exited) {
      child.kill('SIGKILL');
      await until(() => exited, 'the process to end', 10_000);
    }
    await new Promise<void>((resolve) => provider?.server.close(() => resolve()));
    await new Promise<void>((resolve) => eventsServer?.server.close(() => resolve()));
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('posts a turn\'s events with the token and the operation id, and no text', async () => {
    nextChat = {
      status: 200,
      json: {
        model: 'gpt-test',
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        choices: [{ message: { role: 'assistant', content: MODEL_WORDS } }],
      },
    };

    const answer = await chat(USER_WORDS);
    expect(answer.status).toBe(200);
    expect(answer.body.reply).toBe(MODEL_WORDS);

    await until(() => finishedCount() >= 1, 'turn_finished', EVENT_WAIT_MS, () => output);
    expect(kinds()).toEqual(['turn_started', 'turn_finished']);
    expect(events()[1]).toMatchObject({ promptTokens: 12, completionTokens: 3 });

    const [request] = eventsServer.seen;
    expect(request.url).toBe('/hosted/agent/events');
    expect(request.headers.authorization).toBe(`Bearer ${EVENTS_TOKEN}`);
    expect(request.headers[OP_HEADER]).toMatch(UUID_RE);
    expect(request.raw).not.toContain(USER_WORDS);
    expect(request.raw).not.toContain(MODEL_WORDS);
  }, TEST_TIMEOUT_MS);

  it('answers a 402 allowance_exhausted with the fixed line after one provider request', async () => {
    nextChat = { status: 402, json: { error: { code: 'allowance_exhausted' } } };
    const chatsBefore = chatsSeen().length;
    const finishedBefore = finishedCount();

    const answer = await chat(USER_WORDS);
    expect(answer.status).toBe(200);
    expect(answer.body.reply).toBe(ALLOWANCE_LINE);
    expect(chatsSeen().length).toBe(chatsBefore + 1);

    await until(() => finishedCount() > finishedBefore, 'turn_finished', EVENT_WAIT_MS, () => output);
    expect(events().filter((event: any) => event.kind === 'provider_error').map((event: any) => event.code)).toEqual(['402']);
  }, TEST_TIMEOUT_MS);

  it('sends what is still waiting when it gets SIGTERM', async () => {
    nextChat = {
      status: 200,
      json: { model: 'gpt-test', usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ message: { role: 'assistant', content: MODEL_WORDS } }] },
    };
    const finishedBefore = finishedCount();

    const answer = await chat(USER_WORDS);
    expect(answer.status).toBe(200);
    child.kill('SIGTERM');

    await until(() => exited, 'the process to end', 30_000, () => output);
    expect(finishedCount()).toBe(finishedBefore + 1);
  }, TEST_TIMEOUT_MS);
});
