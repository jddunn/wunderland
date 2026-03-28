import { afterEach, describe, expect, it, vi } from 'vitest';

const runToolCallingTurnMock = vi.fn(async () => '{"artifacts":{"summary":"gmi summary"},"scratch":{"judge":{"score":9}}}');

vi.mock('../runtime/tool-calling.js', () => ({
  runToolCallingTurn: runToolCallingTurnMock,
  safeJsonStringify: (value: unknown) => JSON.stringify(value),
}));

import { workflow } from '../../../agentos/src/orchestration/builders/WorkflowBuilder.ts';

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

  it('honors per-node LLM overrides when a provider map is supplied', async () => {
    const compiled = workflow('provider-routed-workflow')
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
          instructions: 'Route this node through Anthropic.',
        },
      })
      .compile()
      .toIR();

    compiled.nodes[0] = {
      ...compiled.nodes[0]!,
      llm: {
        providerId: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        reason: 'high-complexity reasoning',
      },
    };

    await invokeWunderlandGraph(compiled, { topic: 'routing' }, {
      llm: { providerId: 'openai', apiKey: 'openai-key', model: 'gpt-test' },
      llmByProvider: {
        anthropic: {
          providerId: 'anthropic',
          apiKey: 'anthropic-key',
          model: 'claude-sonnet-4-20250514',
        },
      },
      systemPrompt: 'You are a graph runner.',
      toolMap: new Map(),
      toolContext: {},
      askPermission: async () => true,
    });

    expect(runToolCallingTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'anthropic',
        apiKey: 'anthropic-key',
        model: 'claude-sonnet-4-20250514',
      }),
    );
  });
});
