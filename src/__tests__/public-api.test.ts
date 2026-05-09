// @ts-nocheck
import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AgentMemory, type ITool } from '@framers/agentos';
import type { ICognitiveMemoryManager } from '@framers/agentos/memory';
import { createWunderland, WunderlandConfigError } from '../index.js';
import { resetRecordedWunderlandTokenUsage } from '../platform/observability/token-usage.js';

function mockOpenAIChatCompletionSequence(responses: Array<Record<string, unknown>>) {
  const queue = responses.slice();
  const fetchMock = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('Test bug: fetch called more times than expected.');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(next),
    } as any;
  });
  vi.stubGlobal('fetch', fetchMock as any);
  return fetchMock;
}

const quietRuntimeOptions = {
  discovery: { enabled: false },
  taskOutcomeTelemetry: { enabled: false },
  adaptiveExecution: { enabled: false },
} as const;

describe('wunderland public API', () => {
  let configDir: string | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    if (configDir) {
      await resetRecordedWunderlandTokenUsage(configDir);
      await rm(configDir, { recursive: true, force: true });
      configDir = undefined;
    }
  });

  it('throws a config error when no usable LLM credentials are provided', async () => {
    await expect(
      createWunderland({
        llm: { providerId: 'openai', apiKey: '', model: 'gpt-test' },
        tools: 'none',
        ...quietRuntimeOptions,
      }),
    ).rejects.toBeInstanceOf(WunderlandConfigError);
  });

  it('persists session history across turns', async () => {
    mockOpenAIChatCompletionSequence([
      { model: 'gpt-test', usage: {}, choices: [{ message: { role: 'assistant', content: 'first' } }] },
      { model: 'gpt-test', usage: {}, choices: [{ message: { role: 'assistant', content: 'second' } }] },
    ]);

    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: 'none',
      ...quietRuntimeOptions,
    });

    const s = app.session('s1');
    await s.sendText('hi');
    await s.sendText('again');

    const msgs = s.messages();
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant']);
    expect(msgs[2]?.content).toBe('first');
    expect(msgs[4]?.content).toBe('second');
  });

  it('streams graph-shaped events while preserving session history', async () => {
    mockOpenAIChatCompletionSequence([
      { model: 'gpt-test', usage: {}, choices: [{ message: { role: 'assistant', content: 'streamed response' } }] },
    ]);

    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: 'none',
      ...quietRuntimeOptions,
    });

    const session = app.session('stream-session');
    const eventTypes: string[] = [];
    let streamedText = '';

    for await (const event of session.stream('hello')) {
      eventTypes.push(event.type);
      if (event.type === 'text_delta') {
        streamedText += event.content;
      }
    }

    expect(eventTypes).toEqual(
      expect.arrayContaining(['run_start', 'node_start', 'text_delta', 'node_end', 'run_end']),
    );
    expect(streamedText.trim()).toBe('streamed response');
    expect(session.messages().map((message) => message.role)).toEqual(['system', 'user', 'assistant']);
    expect(session.messages()[2]?.content).toBe('streamed response');
  });

  it('exposes durable usage totals at the app and session level', async () => {
    configDir = await mkdtemp(path.join(tmpdir(), 'wunderland-public-usage-'));
    mockOpenAIChatCompletionSequence([
      {
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
        choices: [{ message: { role: 'assistant', content: 'usage test' } }],
      },
    ]);

    const app = await createWunderland({
      configDirOverride: configDir,
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-4o-mini' },
      tools: 'none',
      ...quietRuntimeOptions,
    });

    const session = app.session('usage-session');
    await session.sendText('track usage');

    const appUsage = await app.usage();
    const sessionUsage = await session.usage();

    expect(appUsage.totalTokens).toBe(50);
    expect(appUsage.totalCalls).toBe(1);
    expect(sessionUsage.totalTokens).toBe(50);
    expect(sessionUsage.perModel[0]?.model).toBe('gpt-4o-mini');
  });

  it('denies side-effect tools by default (deny-side-effects)', async () => {
    const sideEffectTool: ITool = {
      id: 'demo.side_effect',
      name: 'side_effect_tool',
      displayName: 'Side Effect Tool',
      description: 'Has side effects',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      hasSideEffects: true,
      execute: vi.fn(async () => ({ success: true, output: { ok: true } })),
    };

    mockOpenAIChatCompletionSequence([
      {
        model: 'gpt-test',
        usage: {},
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call-1', function: { name: 'side_effect_tool', arguments: JSON.stringify({}) } },
              ],
            },
          },
        ],
      },
      { model: 'gpt-test', usage: {}, choices: [{ message: { role: 'assistant', content: 'done' } }] },
    ]);

    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: { custom: [sideEffectTool] },
      approvals: { mode: 'deny-side-effects' },
      agentConfig: { security: { wrapToolOutputs: false } },
      ...quietRuntimeOptions,
    });

    const out = await app.session('s').sendText('run the tool');

    expect(out.text).toBe('done');
    expect((sideEffectTool.execute as any).mock.calls.length).toBe(0);
    expect(out.toolCalls.length).toBe(1);
    expect(out.toolCalls[0]?.toolName).toBe('side_effect_tool');
    expect(out.toolCalls[0]?.approved).toBe(false);
    expect(out.toolCalls[0]?.deniedReason).toBe('denied_by_default:side_effect_tool');
    expect(out.toolCalls[0]?.toolResult).toContain('Permission denied');
  });

  it('auto-approves read-only tools by default', async () => {
    const readTool: ITool = {
      id: 'demo.read',
      name: 'read_tool',
      displayName: 'Read Tool',
      description: 'Read-only tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      hasSideEffects: false,
      execute: vi.fn(async () => ({ success: true, output: { ok: true } })),
    };

    mockOpenAIChatCompletionSequence([
      {
        model: 'gpt-test',
        usage: {},
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call-1', function: { name: 'read_tool', arguments: JSON.stringify({}) } },
              ],
            },
          },
        ],
      },
      { model: 'gpt-test', usage: {}, choices: [{ message: { role: 'assistant', content: 'done' } }] },
    ]);

    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: { custom: [readTool] },
      agentConfig: { security: { wrapToolOutputs: false } },
      ...quietRuntimeOptions,
    });

    const out = await app.session('s').sendText('run the tool');

    expect(out.text).toBe('done');
    expect((readTool.execute as any).mock.calls.length).toBe(1);
    expect(out.toolCalls.length).toBe(1);
    expect(out.toolCalls[0]?.approved).toBe(true);
    expect(out.toolCalls[0]?.toolResult).toContain('"ok": true');
  });

  it('wraps a raw cognitive memory manager into AgentMemory', async () => {
    const manager = {
      initialize: vi.fn(),
      shutdown: vi.fn(),
      encode: vi.fn(),
      retrieve: vi.fn(),
      assembleForPrompt: vi.fn(),
      getMemoryHealth: vi.fn(),
    } as unknown as ICognitiveMemoryManager;

    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: 'none',
      ...quietRuntimeOptions,
      memory: manager,
    });

    expect(app.memory).toBeDefined();
    expect(app.memory).toBeInstanceOf(AgentMemory);
    expect(app.memory?.raw).toBe(manager);
  });

  it('preserves an existing AgentMemory instance', async () => {
    const memory = AgentMemory.wrap({
      initialize: vi.fn(),
      shutdown: vi.fn(),
      encode: vi.fn(),
      retrieve: vi.fn(),
      assembleForPrompt: vi.fn(),
      getMemoryHealth: vi.fn(),
    } as unknown as ICognitiveMemoryManager);

    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: 'none',
      ...quietRuntimeOptions,
      memory,
    });

    expect(app.memory).toBe(memory);
  });

  it('writes per-session text logs in the working directory for config-backed apps by default', async () => {
    configDir = await mkdtemp(path.join(tmpdir(), 'wunderland-public-logs-'));
    mockOpenAIChatCompletionSequence([
      { model: 'gpt-test', usage: {}, choices: [{ message: { role: 'assistant', content: 'logged reply' } }] },
    ]);

    const app = await createWunderland({
      workingDirectory: configDir,
      agentConfig: {
        seedId: 'seed_logged_app',
        discovery: { enabled: false },
      } as any,
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: 'none',
      ...quietRuntimeOptions,
    });

    await app.session('log-session').sendText('log this turn');

    const datedDir = join(configDir, 'logs', new Date().toISOString().slice(0, 10));
    const files = await readdir(datedDir);
    expect(files).toContain('log-session.log');

    const logText = await readFile(join(datedDir, 'log-session.log'), 'utf8');
    expect(logText).toContain('USER');
    expect(logText).toContain('ASSISTANT');
    expect(logText).toContain('log this turn');
    expect(logText).toContain('logged reply');
  });

  it('supports opting out of per-session text logs', async () => {
    configDir = await mkdtemp(path.join(tmpdir(), 'wunderland-public-no-logs-'));
    mockOpenAIChatCompletionSequence([
      { model: 'gpt-test', usage: {}, choices: [{ message: { role: 'assistant', content: 'no log reply' } }] },
    ]);

    const app = await createWunderland({
      workingDirectory: configDir,
      agentConfig: {
        seedId: 'seed_no_logs',
        discovery: { enabled: false },
        observability: {
          textLogs: { enabled: false },
        },
      } as any,
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: 'none',
      ...quietRuntimeOptions,
    });

    await app.session('disabled-log-session').sendText('skip logging');

    const datedDir = join(configDir, 'logs', new Date().toISOString().slice(0, 10));
    expect(existsSync(datedDir)).toBe(false);
  });

  it('loads and compiles workflow and mission YAML files', async () => {
    const app = await createWunderland({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      tools: 'none',
      ...quietRuntimeOptions,
    });

    const workflow = await app.loadWorkflow(join(process.cwd(), 'examples/workflow-research.yaml'));
    const mission = await app.loadMission(join(process.cwd(), 'examples/mission-deep-research.yaml'));

    expect(typeof workflow.toIR).toBe('function');
    expect(typeof mission.toIR).toBe('function');
  });
});
