import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runtime/tool-calling.js', () => ({
  runToolCallingTurn: vi.fn(async () => '{"artifacts":{"summary":"gmi summary"},"scratch":{"judge":{"score":9}}}'),
  safeJsonStringify: (value: unknown) => JSON.stringify(value),
}));

import { workflow } from '@framers/agentos/orchestration';

import { invokeWunderlandGraph, streamWunderlandGraph } from '../runtime/graph-runner.js';

describe('Wunderland graph runner', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('executes tool nodes with graph input merged into tool args', async () => {
    const collectTool = {
      name: 'collect_topic',
      description: 'Collect a topic and return a final artifact.',
      inputSchema: {
        type: 'object',
        required: ['topic'],
        properties: {
          topic: { type: 'string' },
        },
      },
      hasSideEffects: false,
      execute: vi.fn(async (args: Record<string, unknown>) => ({
        artifacts: {
          summary: `Collected ${String(args.topic ?? 'unknown')}`,
        },
      })),
    };

    const compiled = workflow('collect-workflow')
      .input({
        type: 'object',
        required: ['topic'],
        properties: {
          topic: { type: 'string' },
        },
      })
      .returns({
        type: 'object',
        properties: {
          summary: { type: 'string' },
        },
      })
      .step('collect', { tool: 'collect_topic' })
      .compile();

    const result = await invokeWunderlandGraph(compiled, { topic: 'agent graphs' }, {
      llm: { apiKey: 'test-key', model: 'gpt-test' },
      systemPrompt: 'You are a graph runner.',
      toolMap: new Map([['collect_topic', collectTool as any]]),
      toolContext: {},
      askPermission: async () => true,
    });

    expect(result).toEqual({ summary: 'Collected agent graphs' });
    expect(collectTool.execute).toHaveBeenCalledTimes(1);
    expect(collectTool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'agent graphs' }),
      {},
    );
  });

  it('executes gmi nodes and merges structured JSON into graph state', async () => {
    const compiled = workflow('judge-workflow')
      .input({
        type: 'object',
        properties: {
          topic: { type: 'string' },
        },
      })
      .returns({
        type: 'object',
        properties: {
          summary: { type: 'string' },
        },
      })
      .step('judge', {
        gmi: {
          instructions: 'Return a structured judge response.',
        },
      })
      .compile();

    const events: string[] = [];
    for await (const event of streamWunderlandGraph(compiled, { topic: 'judging' }, {
      llm: { apiKey: 'test-key', model: 'gpt-test' },
      systemPrompt: 'You are a graph runner.',
      toolMap: new Map(),
      toolContext: {},
      askPermission: async () => true,
    })) {
      events.push(event.type);
      if (event.type === 'run_end') {
        expect(event.finalOutput).toEqual({ summary: 'gmi summary' });
      }
    }

    expect(events).toContain('run_start');
    expect(events).toContain('node_end');
    expect(events).toContain('run_end');
  });
});
