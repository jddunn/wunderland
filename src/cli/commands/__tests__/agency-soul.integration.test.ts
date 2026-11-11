// @ts-nocheck
/**
 * `wunderland agency run` with a seat that names a soul, on the real `agency()` from `@framers/agentos`.
 *
 * The agency block of `agent.config.json` reaches `agency()` as written, and each config seat is built with
 * `agent()`, so a seat's `soul` is loaded by AgentOS. A soul the seat names that fails to load (a missing
 * folder, or a front matter field of the wrong type) stops the run with the soul's error and a hint, before any
 * model request. `soul: { path, optional: true }` runs the seat without it.
 *
 * The model is a local HTTP server that answers the OpenAI chat completions API and counts what it is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import cmdAgency from '../agency.js';

vi.mock('../../config/env-manager.js', () => ({
  loadDotEnvIntoProcessUpward: vi.fn().mockResolvedValue(undefined),
}));

/** Importing `@framers/agentos` and running a seat takes longer than vitest's 5 s default. */
const RUN_TIMEOUT_MS = 120_000;

/** A key of an OpenAI key's shape for the local server; synthetic, never a real one. */
const FAKE_KEY = `sk-test-${'a'.repeat(40)}`;

const SEAT_REPLY = 'The seat answered without its soul.';

let dir = '';
let server: Server;
let baseUrl = '';
let requests: Array<{ url: string; body: any }> = [];
let savedOpenAiKey: string | undefined;

/** Answers a chat completion, streamed when the request asks for it. */
function answer(body: any, res: import('node:http').ServerResponse): void {
  const model = body?.model ?? 'gpt-4o-mini';
  const usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };
  if (body?.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (choice: any, extra: any = {}) =>
      `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model, choices: [choice], ...extra })}\n\n`;
    res.write(chunk({ index: 0, delta: { role: 'assistant', content: SEAT_REPLY }, finish_reason: null }));
    res.write(chunk({ index: 0, delta: {}, finish_reason: 'stop' }, { usage }));
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: SEAT_REPLY }, finish_reason: 'stop' }],
      usage,
    }),
  );
}

/**
 * The error panel wraps its text at 76 columns, splitting a long path across lines between border bars. This
 * drops colour codes, whitespace and the bars, so a phrase can be found wherever the panel broke it.
 */
function flat(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\s│|]/g, '');
}

function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const push = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  console.log = push;
  console.warn = push;
  console.error = push;
  return {
    logs,
    restore: () => {
      console.log = saved.log;
      console.warn = saved.warn;
      console.error = saved.error;
    },
  };
}

/** Writes `agent.config.json` with a one-seat sequential agency whose seat takes `soul`. */
async function writeAgency(soul: unknown): Promise<void> {
  const config = {
    agency: {
      strategy: 'sequential',
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: FAKE_KEY,
      baseUrl,
      agents: {
        writer: { instructions: 'Answer in one sentence.', soul },
      },
    },
  };
  await fs.writeFile(path.join(dir, 'agent.config.json'), JSON.stringify(config, null, 2), 'utf8');
}

/** Runs `wunderland agency run team "<prompt>"` in the test folder and returns what it printed. */
async function runAgency(flags: Record<string, string | boolean> = {}): Promise<string> {
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  const cap = captureConsole();
  const write = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    cap.logs.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await cmdAgency(['run', 'team', 'Say', 'hello.'], flags, {});
  } finally {
    process.stdout.write = write;
    cap.restore();
  }
  return cap.logs.join('\n');
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wunderland-agency-soul-'));
  requests = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (part) => {
      raw += part;
    });
    req.on('end', () => {
      let body: any;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({ url: req.url ?? '', body });
      if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      answer(body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  savedOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = FAKE_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenAiKey;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
});

describe('wunderland agency run with a seat soul that fails to load', () => {
  for (const mode of ['generate', 'stream'] as const) {
    const flags = mode === 'stream' ? { stream: true } : {};

    it(
      `stops with the soul's error and a hint, and sends the model nothing, when the soul's folder is missing (${mode})`,
      async () => {
        const missing = path.join(dir, 'souls', 'writer');
        await writeAgency(missing);

        const output = flat(await runAgency(flags));

        expect(output).toContain(flat('Agency Error'));
        expect(output).toContain(flat(`The soul failed to load (${missing})`));
        expect(output).toContain(flat('"optional": true'));
        expect(output).not.toContain(flat(SEAT_REPLY));
        expect(requests).toHaveLength(0);
        expect(process.exitCode).toBe(1);
      },
      RUN_TIMEOUT_MS,
    );

    it(
      `stops with the soul's error, naming the field, when a front matter field has the wrong type (${mode})`,
      async () => {
        const soulDir = path.join(dir, 'souls', 'writer');
        await fs.mkdir(soulDir, { recursive: true });
        await fs.writeFile(
          path.join(soulDir, 'SOUL.md'),
          '---\nname: Writer\nhexaco: high\n---\nYou write short answers.\n',
          'utf8',
        );
        await writeAgency(soulDir);

        const output = flat(await runAgency(flags));

        expect(output).toContain(flat('Agency Error'));
        expect(output).toContain(flat(`The soul failed to load (${soulDir})`));
        expect(output).toContain(flat("front matter field 'hexaco'"));
        expect(requests).toHaveLength(0);
        expect(process.exitCode).toBe(1);
      },
      RUN_TIMEOUT_MS,
    );
  }

  it(
    'runs the seat without its soul when the seat marks the soul optional',
    async () => {
      await writeAgency({ path: path.join(dir, 'souls', 'writer'), optional: true });

      const output = flat(await runAgency());

      expect(output).not.toContain(flat('Agency Error'));
      expect(output).toContain(flat(SEAT_REPLY));
      expect(requests.filter((r) => r.url.endsWith('/chat/completions')).length).toBeGreaterThan(0);
      expect(process.exitCode).toBeUndefined();
    },
    RUN_TIMEOUT_MS,
  );
});
