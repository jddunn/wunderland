// @ts-nocheck
/**
 * A guardrail pack in a spawned `wunderland start`, built by `pnpm build`: the
 * agent config names the published `@framers/agentos-ext-self-harm-referral` in
 * `tools.allow.packs` alone, `OPENAI_BASE_URL` points at a fake provider and the
 * events variables at a fake events server.
 *
 * `POST /chat` with a self-harm expression gets the referral and the provider
 * sees no request; one `referral_sent` event arrives, with none of the person's
 * words. An ordinary message reaches the provider and its reply comes back; a
 * reply the guard refuses is replaced by the referral.
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
import { REFERRAL_TABLE, buildReferral } from '@framers/agentos-ext-self-harm-referral';

const BIN = fileURLToPath(new URL('../../../../../bin/wunderland.js', import.meta.url));
const EVENTS_TOKEN = 'events-token-guardrails-e2e';
/** The referral the pack sends when the turn names no country: the shipped table's own text. */
const REFERRAL = buildReferral(REFERRAL_TABLE, null).text;
const CRISIS = 'I want to die';
const USER_WORDS = 'USER-WORDS-what-should-i-read-tonight';
const MODEL_WORDS = 'MODEL-WORDS-the-model-wrote';
const REFUSED_WORDS = 'REFUSED-WORDS-the-person-never-sees';

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

const chatAnswer = (content: string) => ({
  status: 200,
  json: {
    model: 'gpt-test',
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    choices: [{ message: { role: 'assistant', content } }],
  },
});

describe('wunderland start with a guardrail pack in tools.allow', () => {
  let provider: Awaited<ReturnType<typeof startFake>>;
  let eventsServer: Awaited<ReturnType<typeof startFake>>;
  let child: ChildProcess;
  let exited = false;
  let output = '';
  let root = '';
  let port = 0;
  /** What the provider's next chat completion answers. */
  let nextReply = MODEL_WORDS;

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
      if (url.endsWith('/chat/completions')) return chatAnswer(nextReply);
      return { status: 404, json: { error: { message: 'not here' } } };
    });
    eventsServer = await startFake(() => ({ status: 202, json: { accepted: true } }));
    root = mkdtempSync(path.join(tmpdir(), 'wunderland-guardrails-e2e-'));
    port = await freePort();
    writeFileSync(path.join(root, 'agent.config.json'), JSON.stringify({
      seedId: 'seed_guardrails_e2e',
      displayName: 'Guardrails E2E',
      llmProvider: 'openai',
      llmModel: 'gpt-test',
      executionMode: 'autonomous',
      // The pack is named here alone: it loads as a guard and adds no tool.
      tools: { allow: { packs: ['self-harm-referral'], tools: [] } },
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
      OPENAI_API_KEY: 'sk-guardrails-e2e',
      OPENAI_BASE_URL: `${provider.origin}/v1`,
      WUNDERLAND_EVENTS_URL: `${eventsServer.origin}/hosted/agent`,
      WUNDERLAND_EVENTS_TOKEN: EVENTS_TOKEN,
    });

    // --no-guardrails turns off the security tier's packs; a pack the config names still runs.
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

  it('answers a self-harm expression with the referral, calls no model and reports one referral_sent', async () => {
    const answer = await chat(CRISIS);

    expect(answer.status).toBe(200);
    expect(answer.body.reply).toBe(REFERRAL);
    expect(chatsSeen()).toEqual([]);

    await until(() => finishedCount() >= 1, 'turn_finished', EVENT_WAIT_MS, () => output);
    expect(kinds()).toEqual(['turn_started', 'referral_sent', 'turn_finished']);
    expect(events()[1]).toMatchObject({ kind: 'referral_sent', code: 'input' });
    for (const request of eventsServer.seen) {
      expect(request.raw).not.toContain(CRISIS);
      expect(request.headers.authorization).toBe(`Bearer ${EVENTS_TOKEN}`);
    }
  }, TEST_TIMEOUT_MS);

  it('passes an ordinary message to the provider and returns its reply', async () => {
    nextReply = MODEL_WORDS;

    const answer = await chat(USER_WORDS);

    expect(answer.status).toBe(200);
    expect(answer.body.reply).toBe(MODEL_WORDS);
    expect(chatsSeen()).toHaveLength(1);
    expect(chatsSeen()[0].raw).toContain(USER_WORDS);
  }, TEST_TIMEOUT_MS);

  it('replaces a reply the guard refuses with the referral', async () => {
    nextReply = `${REFUSED_WORDS} Here is how to end your life.`;
    const finishedBefore = finishedCount();

    const answer = await chat(USER_WORDS);

    expect(answer.status).toBe(200);
    expect(answer.body.reply).toBe(REFERRAL);
    expect(JSON.stringify(answer.body)).not.toContain(REFUSED_WORDS);

    await until(() => finishedCount() > finishedBefore, 'turn_finished', EVENT_WAIT_MS, () => output);
    const referrals = events().filter((event: any) => event.kind === 'referral_sent');
    expect(referrals.at(-1)).toMatchObject({ code: 'output' });
    for (const request of eventsServer.seen) expect(request.raw).not.toContain(REFUSED_WORDS);
  }, TEST_TIMEOUT_MS);
});
