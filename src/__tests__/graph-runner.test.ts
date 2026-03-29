import { afterEach, describe, expect, it, vi } from 'vitest';

const { runToolCallingTurnMock } = vi.hoisted(() => ({
  runToolCallingTurnMock: vi.fn(async (opts?: {
    onTextDelta?: (content: string) => void;
    onToolCall?: (tool: { name: string }, args: Record<string, unknown>) => void;
    onToolResult?: (info: {
      toolName: string;
      args: Record<string, unknown>;
      success: boolean;
      output?: unknown;
      error?: string;
      durationMs: number;
    }) => void;
  }) => {
    opts?.onTextDelta?.('thinking...');
    opts?.onToolCall?.({ name: 'web_search' }, { q: 'agent graphs' });
    opts?.onToolResult?.({
      toolName: 'web_search',
      args: { q: 'agent graphs' },
      success: true,
      output: { hits: 3 },
      durationMs: 12,
    });
    return '{"artifacts":{"summary":"gmi summary"},"scratch":{"judge":{"score":9}}}';
  }),
}));

vi.mock('../runtime/tool-calling.js', () => ({
  runToolCallingTurn: runToolCallingTurnMock,
  safeJsonStringify: (value: unknown) => JSON.stringify(value),
}));

vi.mock('../runtime/agentos-runtime.js', async () => import('../../../agentos/src/orchestration/runtime-kernel.ts'));

import { workflow } from '../../../agentos/src/orchestration/builders/WorkflowBuilder.ts';

import { InMemoryCheckpointStore } from '../../../agentos/src/orchestration/checkpoint/InMemoryCheckpointStore.ts';
import {
  invokeWunderlandGraph,
  streamResumeWunderlandGraph,
  streamWunderlandGraph,
} from '../runtime/graph-runner.js';

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
    expect(events).toContain('text_delta');
    expect(events).toContain('tool_call');
    expect(events).toContain('tool_result');
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

  it('resumes a graph run from a saved checkpoint', async () => {
    const checkpointStore = new InMemoryCheckpointStore();
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
        output: String(args.topic),
      })),
    };

    const compiled = {
      id: 'resume-workflow',
      name: 'resume-workflow',
      nodes: [
        {
          id: 'first',
          type: 'tool',
          executorConfig: {
            type: 'tool',
            toolName: 'collect_topic',
            args: { topic: 'first' },
          },
          executionMode: 'single_turn',
          effectClass: 'read',
          checkpoint: 'after',
        },
        {
          id: 'second',
          type: 'tool',
          executorConfig: {
            type: 'tool',
            toolName: 'collect_topic',
            args: { topic: 'second' },
          },
          executionMode: 'single_turn',
          effectClass: 'read',
          checkpoint: 'after',
        },
      ],
      edges: [
        { id: 'start-first', source: '__START__', target: 'first', type: 'static' },
        { id: 'first-second', source: 'first', target: 'second', type: 'static' },
        { id: 'second-end', source: 'second', target: '__END__', type: 'static' },
      ],
      stateSchema: { input: {}, scratch: {}, artifacts: {} },
      reducers: {},
      checkpointPolicy: 'every_node',
      memoryConsistency: 'live',
    } as const;

    for await (const _event of streamWunderlandGraph(compiled, { topic: 'ignored' }, {
      llm: { apiKey: 'test-key', model: 'gpt-test' },
      systemPrompt: 'You are a graph runner.',
      toolMap: new Map([['collect_topic', collectTool as any]]),
      toolContext: {},
      checkpointStore,
      askPermission: async () => true,
    })) {
      // drain
    }

    const checkpointForFirst = (await checkpointStore.list(compiled.id))
      .find((checkpoint) => checkpoint.nodeId === 'first');
    expect(checkpointForFirst).toBeDefined();

    collectTool.execute.mockClear();
    const resumedNodes: string[] = [];
    for await (const event of streamResumeWunderlandGraph(compiled, checkpointForFirst!.id, {
      llm: { apiKey: 'test-key', model: 'gpt-test' },
      systemPrompt: 'You are a graph runner.',
      toolMap: new Map([['collect_topic', collectTool as any]]),
      toolContext: {},
      checkpointStore,
      askPermission: async () => true,
    })) {
      if (event.type === 'node_start') {
        resumedNodes.push(event.nodeId);
      }
    }

    expect(resumedNodes).toEqual(['second']);
    expect(collectTool.execute).toHaveBeenCalledTimes(1);
    expect(collectTool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'second' }),
      {},
    );
  });

  it('translates request_expansion tool results into live graph expansion', async () => {
    runToolCallingTurnMock.mockImplementationOnce(async (opts?: {
      onTextDelta?: (content: string) => void;
      onToolCall?: (tool: { name: string }, args: Record<string, unknown>) => void;
      onToolResult?: (info: {
        toolName: string;
        args: Record<string, unknown>;
        success: boolean;
        output?: unknown;
        error?: string;
        durationMs: number;
      }) => void;
    }) => {
      opts?.onTextDelta?.('need a verifier');
      opts?.onToolCall?.({ name: 'request_expansion' }, { need: 'Need a verifier', urgency: 'blocking' });
      opts?.onToolResult?.({
        toolName: 'request_expansion',
        args: { need: 'Need a verifier', urgency: 'blocking' },
        success: true,
        output: { acknowledged: true },
        durationMs: 4,
      });
      return '{"output":"expansion requested"}';
    });

    const verifyTool = {
      name: 'verify_result',
      description: 'Verify the prior result.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
        },
      },
      hasSideEffects: false,
      execute: vi.fn(async () => ({
        output: 'verified',
      })),
    };

    const compiled = {
      id: 'expansion-workflow',
      name: 'expansion-workflow',
      nodes: [
        {
          id: 'judge',
          type: 'gmi',
          executorConfig: {
            type: 'gmi',
            instructions: 'Judge the current result and ask for expansion if needed.',
          },
          executionMode: 'single_turn',
          effectClass: 'read',
          checkpoint: 'after',
        },
      ],
      edges: [
        { id: 'start-judge', source: '__START__', target: 'judge', type: 'static' },
        { id: 'judge-end', source: 'judge', target: '__END__', type: 'static' },
      ],
      stateSchema: { input: {}, scratch: {}, artifacts: {} },
      reducers: {},
      checkpointPolicy: 'every_node',
      memoryConsistency: 'live',
    } as const;

    const expansionHandler = {
      handle: vi.fn(async (context: { graph: typeof compiled }) => ({
        graph: {
          ...context.graph,
          nodes: [
            ...context.graph.nodes,
            {
              id: 'verify',
              type: 'tool',
              executorConfig: {
                type: 'tool',
                toolName: 'verify_result',
                args: { topic: 'verification' },
              },
              executionMode: 'single_turn',
              effectClass: 'read',
              checkpoint: 'after',
            },
          ],
          edges: [
            { id: 'start-judge', source: '__START__', target: 'judge', type: 'static' as const },
            { id: 'judge-verify', source: 'judge', target: 'verify', type: 'static' as const },
            { id: 'verify-end', source: 'verify', target: '__END__', type: 'static' as const },
          ],
        },
        events: [
          {
            type: 'mission:expansion_proposed' as const,
            patch: {
              addNodes: [],
              addEdges: [],
              removeNodes: [],
              rewireEdges: [],
              reason: 'Need a verifier',
              estimatedCostDelta: 0.2,
              estimatedLatencyDelta: 400,
            },
            trigger: 'agent_request' as const,
            reason: 'Need a verifier',
          },
          { type: 'mission:expansion_applied' as const, nodesAdded: 1, edgesAdded: 2 },
        ],
      })),
    };

    const eventTypes: string[] = [];
    const visitedNodes: string[] = [];

    for await (const event of streamWunderlandGraph(compiled, {}, {
      llm: { apiKey: 'test-key', model: 'gpt-test' },
      systemPrompt: 'You are a graph runner.',
      toolMap: new Map([['verify_result', verifyTool as any]]),
      toolContext: {},
      askPermission: async () => true,
      expansionHandler,
    })) {
      eventTypes.push(event.type);
      if (event.type === 'node_start') {
        visitedNodes.push(event.nodeId);
      }
    }

    expect(expansionHandler.handle).toHaveBeenCalledTimes(1);
    expect(visitedNodes).toEqual(['judge', 'verify']);
    expect(eventTypes).toContain('tool_call');
    expect(eventTypes).toContain('mission:expansion_applied');
    expect(verifyTool.execute).toHaveBeenCalledTimes(1);
  });
});
