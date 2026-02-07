/**
 * @fileoverview MemoryReadTool — injects long-term memory into LLM tool-calling loops.
 *
 * Wunderland does not mandate a specific storage backend. This tool is created via
 * dependency injection so host apps (backend, CLI, etc.) can implement memory using
 * AgentOS RAG, a SQL keyword index, a vector DB, or anything else.
 *
 * @module wunderland/tools/MemoryReadTool
 */

import type {
  ITool,
  ToolExecutionContext,
  ToolExecutionResult,
  JSONSchemaObject,
} from '@framers/agentos';

export type MemoryReadItem = {
  text: string;
  score?: number;
  source?: string;
  metadata?: Record<string, unknown>;
};

export type MemoryReadResult = {
  items: MemoryReadItem[];
  context: string;
};

export type MemoryReadFn = (input: {
  query: string;
  topK: number;
  context: ToolExecutionContext;
}) => Promise<MemoryReadResult>;

export function createMemoryReadTool(read: MemoryReadFn): ITool {
  const inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to retrieve relevant long-term memory for this agent.',
      },
      topK: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        default: 6,
        description: 'Maximum number of memory items to return.',
      },
    },
    required: ['query'],
  };

  return {
    id: 'memory_read',
    name: 'memory_read',
    displayName: 'Memory Read',
    description: 'Retrieve long-term memory relevant to the current task or topic.',
    category: 'memory',
    hasSideEffects: false,
    inputSchema,

    async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return { success: false, error: 'Missing required field "query".', output: { error: 'Missing query.' } };
      }

      const topKRaw = typeof args.topK === 'number' ? args.topK : Number(args.topK);
      const topK = Number.isFinite(topKRaw) ? Math.max(1, Math.min(20, Math.trunc(topKRaw))) : 6;

      try {
        const result = await read({ query, topK, context: ctx });
        return { success: true, output: result };
      } catch (error: any) {
        return {
          success: false,
          error: error?.message ? String(error.message) : 'Memory read failed.',
          output: { error: error?.message ? String(error.message) : 'Memory read failed.' },
        };
      }
    },
  };
}

