// @ts-nocheck
/**
 * Remote approvals end to end: a spawned `wunderland start`, built by `pnpm
 * build`, with `hitl.mode: "remote"` in its config, the real `shell_execute`
 * tool and OPENAI_BASE_URL at a fake provider. The model asks to run the tool
 * against another channel, which makes the call outward.
 *
 * With both events variables set, the approval server's yes runs the tool and
 * its no ends the turn with the word. With the token gone, nothing is asked and
 * nothing runs. The agent's execution mode is `autonomous`, so nothing but the
 * approval stands between the model and the tool.
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
const TOKEN = 'approvals-token-e2e';
const OP_HEADER = 'x-test-operation-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL_WORDS = 'MODEL-WORDS-the-model-wrote';

/** What the real `id` command prints, and only it. */
const TOOL_RAN = 'uid=';

/** Start loads a whole agent; a runner's first load of its packs takes a while. */
const START_TIMEOUT_MS = 150_000;
const TEST_TIMEOUT_MS = 240_000;

type Seen = { method: string; url: string; headers: Record<string, any>; raw: string };

/** Starts a recording HTTP server on 127.0.0.1. */
async function startFake(answer: (seen: Seen) => { status: number; json: unknown }) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') };
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

/** The model's first answer asks for the tool, aimed at another channel; its next one is text. */
const askForTheTool = {
  status: 200,
  json: {
    model: 'gpt-test',
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'shell_execute', arguments: JSON.stringify({ command: 'id', channelId: 'another-channel' }) },
        }],
      },
    }],
  },
};
const answerInText = {
  status: 200,
  json: {
    model: 'gpt-test',
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    choices: [{ message: { role: 'assistant', content: MODEL_WORDS } }],
  },
};

/** One spawned `wunderland start` with the given events variables and its fakes. */
async function startAgent(eventsVariables: (approvalsUrl: string) => Record<string, string>) {
  /** What the provider answers next, in order. */
  const script: Array<{ status: number; json: unknown }> = [];
  /** What `GET /approvals/:id` answers. */
  const answer = { state: 'waiting' };
  const provider = await startFake(({ url }) => {
    if (url.endsWith('/chat/completions')) return script.shift() ?? { status: 500, json: { error: { message: 'script ran out' } } };
    return { status: 404, json: { error: { message: 'not here' } } };
  });
  const approvals = await startFake(({ method, url }) => {
    if (method === 'POST' && url.endsWith('/approvals')) return { status: 201, json: { id: 'apr-1', state: 'waiting' } };
    if (method === 'POST') return { status: 202, json: { accepted: true } };
    return { status: 200, json: { id: 'apr-1', state: answer.state } };
  });
  const root = mkdtempSync(path.join(tmpdir(), 'wunderland-approvals-e2e-'));
  const port = await freePort();
  writeFileSync(path.join(root, 'agent.config.json'), JSON.stringify({
    seedId: 'seed_approvals_e2e',
    displayName: 'Approvals E2E',
    llmProvider: 'openai',
    llmModel: 'gpt-test',
    permissionSet: 'unrestricted',
    toolAccessProfile: 'unrestricted',
    executionMode: 'autonomous',
    hitl: { mode: 'remote' },
    tools: { allow: { packs: ['cli-executor'], tools: ['shell_execute'] } },
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
  delete env.WUNDERLAND_EVENTS_URL;
  delete env.WUNDERLAND_EVENTS_TOKEN;
  Object.assign(env, {
    HOME: root,
    NO_COLOR: '1',
    OPENAI_API_KEY: 'sk-approvals-e2e',
    OPENAI_BASE_URL: `${provider.origin}/v1`,
    AGENTOS_OPERATION_ID_HEADER: OP_HEADER,
    ...eventsVariables(`${approvals.origin}/hosted/agent`),
  });

  let exited = false;
  let output = '';
  const child: ChildProcess = spawn(process.execPath, [BIN, 'start', '--port', String(port), '--no-guardrails'], {
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

  return {
    provider,
    approvals,
    script,
    answer,
    output: () => output,
    chatsSeen: () => provider.seen.filter((request) => request.url.endsWith('/chat/completions')),
    requests: () => approvals.seen.filter((request) => request.method === 'POST' && request.url.endsWith('/approvals')),
    async chat(message: string): Promise<{ status: number; body: any }> {
      const res = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, autoClassify: false }),
      });
      return { status: res.status, body: await res.json() };
    },
    async stop(): Promise<void> {
      if (!exited) {
        child.kill('SIGKILL');
        await until(() => exited, 'the process to end', 10_000);
      }
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
      await new Promise<void>((resolve) => approvals.server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('wunderland start with hitl.mode "remote" and both events variables', () => {
  let agent: Awaited<ReturnType<typeof startAgent>>;

  beforeAll(async () => {
    agent = await startAgent((approvalsUrl) => ({
      WUNDERLAND_EVENTS_URL: approvalsUrl,
      WUNDERLAND_EVENTS_TOKEN: TOKEN,
    }));
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await agent?.stop();
  });

  it('the server\'s approved runs the tool', async () => {
    agent.answer.state = 'approved';
    agent.script.push(askForTheTool, answerInText);

    const { status, body } = await agent.chat('run it');

    expect(status).toBe(200);
    expect(body.reply).toBe(MODEL_WORDS);

    expect(agent.requests()).toHaveLength(1);
    const [request] = agent.requests();
    expect(request.url).toBe('/hosted/agent/approvals');
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const asked = JSON.parse(request.raw);
    expect(asked.toolName).toBe('shell_execute');
    expect(asked.action.summary).toBe('shell_execute to another-channel');
    expect(asked.action.text).toContain('another-channel');
    expect(asked.operationId).toMatch(UUID_RE);

    expect(agent.chatsSeen()).toHaveLength(2);
    expect(agent.chatsSeen()[1].raw).toContain(TOOL_RAN);
  }, TEST_TIMEOUT_MS);

  it('the server\'s declined ends the turn with the word and the tool never runs', async () => {
    agent.answer.state = 'declined';
    agent.script.push(askForTheTool);
    const chatsBefore = agent.chatsSeen().length;
    const requestsBefore = agent.requests().length;

    const { status, body } = await agent.chat('run it again');

    expect(status).toBe(200);
    expect(body.reply).toContain('declined');
    expect(agent.requests().length).toBe(requestsBefore + 1);
    expect(agent.chatsSeen().length).toBe(chatsBefore + 1);
  }, TEST_TIMEOUT_MS);
});

describe('wunderland start with hitl.mode "remote" and the token gone', () => {
  let agent: Awaited<ReturnType<typeof startAgent>>;

  beforeAll(async () => {
    agent = await startAgent((approvalsUrl) => ({ WUNDERLAND_EVENTS_URL: approvalsUrl }));
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await agent?.stop();
  });

  it('refuses the tool approval_unavailable, asks nothing and runs nothing', async () => {
    agent.script.push(askForTheTool);

    const { status, body } = await agent.chat('run it');

    expect(status).toBe(200);
    expect(body.reply).toContain('approval_unavailable');
    expect(agent.approvals.seen).toEqual([]);
    expect(agent.chatsSeen()).toHaveLength(1);
    expect(agent.chatsSeen()[0].raw).not.toContain(TOOL_RAN);
  }, TEST_TIMEOUT_MS);
});
