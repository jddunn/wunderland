import { describe, it, expect, vi, afterEach } from 'vitest';

import type { ITool } from '@framers/agentos';
import { createWunderland, WunderlandConfigError } from '../index.js';

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

describe('wunderland public API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('throws a config error when no usable LLM credentials are provided', async () => {
    await expect(
      createWunderland({
        llm: { providerId: 'openai', apiKey: '', model: 'gpt-test' },
        tools: 'none',
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
    });

    const s = app.session('s1');
    await s.sendText('hi');
    await s.sendText('again');

    const msgs = s.messages();
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant']);
    expect(msgs[2]?.content).toBe('first');
    expect(msgs[4]?.content).toBe('second');
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
    });

    const out = await app.session('s').sendText('run the tool');

    expect(out.text).toBe('done');
    expect((readTool.execute as any).mock.calls.length).toBe(1);
    expect(out.toolCalls.length).toBe(1);
    expect(out.toolCalls[0]?.approved).toBe(true);
    expect(out.toolCalls[0]?.toolResult).toContain('"ok": true');
  });
});

