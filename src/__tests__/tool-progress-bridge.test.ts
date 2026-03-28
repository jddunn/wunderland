import { afterEach, describe, expect, it, vi } from 'vitest';
import { runToolCallingTurn, type ToolInstance } from '../runtime/tool-calling.js';

function mockOpenAIChatCompletionSequence(messages: Array<Record<string, unknown>>) {
  const queue = messages.slice();
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

describe('tool progress bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('bridges per-tool progress events to the outer onToolProgress callback', async () => {
    const progressEvents: Array<{ toolName: string; phase: string; message: string; progress?: number }> = [];

    const tool: ToolInstance = {
      name: 'deep_research',
      description: 'Run deep research',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' } },
      },
      category: 'research',
      hasSideEffects: false,
      execute: vi.fn(async (_args, context: any) => {
        context?.onToolProgress?.({
          phase: 'searching',
          message: 'Searching sources',
          progress: 0.5,
        });
        return { success: true, output: { findings: 3 } };
      }),
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
                {
                  id: 'call-1',
                  function: { name: 'deep_research', arguments: JSON.stringify({ query: 'tmj diagnosis' }) },
                },
              ],
            },
          },
        ],
      },
      {
        model: 'gpt-test',
        usage: {},
        choices: [{ message: { role: 'assistant', content: 'done' } }],
      },
    ]);

    const reply = await runToolCallingTurn({
      apiKey: 'test-key',
      model: 'gpt-test',
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
      toolMap: new Map([[tool.name, tool]]),
      toolContext: { gmiId: 'gmi-1', personaId: 'persona-1', userContext: { userId: 'u-1' } },
      maxRounds: 3,
      dangerouslySkipPermissions: true,
      askPermission: vi.fn(async () => true),
      onToolProgress: (info) => {
        progressEvents.push(info);
      },
    });

    expect(reply).toBe('done');
    expect(progressEvents).toEqual([
      {
        toolName: 'deep_research',
        phase: 'searching',
        message: 'Searching sources',
        progress: 0.5,
      },
    ]);
  });
});
