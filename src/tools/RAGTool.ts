/**
 * @fileoverview RAG memory query tool for Wunderland agents.
 * Allows agents to search their RAG memory during tool-calling conversations.
 * @module wunderland/tools/RAGTool
 */

import type { ITool, ToolExecutionResult, ToolExecutionContext, JSONSchemaObject } from '@framers/agentos';

export interface RAGToolConfig {
  backendUrl: string;
  authToken?: string;
  defaultTopK?: number;
}

export const RAG_TOOL_ID = 'rag_query';

export class RAGTool implements ITool {
  readonly id = RAG_TOOL_ID;
  readonly name = 'RAG Memory Query';
  readonly displayName = 'RAG Memory Query';
  readonly description = 'Search the agent knowledge base using semantic and keyword retrieval. Returns relevant document chunks.';
  readonly hasSideEffects = false;

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query text.' },
      topK: { type: 'number', description: 'Maximum number of results to return (default: 5).' },
      collectionId: { type: 'string', description: 'Optional collection ID to search within.' },
    },
    required: ['query'],
  };

  private readonly config: RAGToolConfig;

  constructor(config: RAGToolConfig) {
    this.config = config;
  }

  async execute(input: Record<string, unknown>, _context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    const query = input.query as string;
    const topK = (input.topK as number) ?? this.config.defaultTopK ?? 5;
    const collectionId = input.collectionId as string | undefined;

    const baseUrl = this.config.backendUrl.replace(/\/+$/, '') + '/api/agentos/rag';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.authToken) headers['Authorization'] = `Bearer ${this.config.authToken}`;

    try {
      const res = await fetch(`${baseUrl}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          topK,
          collectionIds: collectionId ? [collectionId] : undefined,
        }),
      });

      if (!res.ok) {
        return { success: false, output: `RAG query failed (${res.status})` };
      }

      const result = await res.json() as any;
      const chunks = (result.chunks ?? []).map((c: any) => ({
        content: c.content,
        score: c.score,
        documentId: c.documentId,
      }));

      return {
        success: true,
        output: JSON.stringify({ query, results: chunks, totalResults: result.totalResults }),
      };
    } catch (err) {
      return {
        success: false,
        output: `RAG query error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
