/**
 * @fileoverview RAG memory query tool for Wunderland agents.
 * Allows agents to search their RAG memory during tool-calling conversations.
 * Supports audit trail generation for transparent RAG operation tracking.
 * @module wunderland/tools/RAGTool
 */

import type { ITool, ToolExecutionResult, ToolExecutionContext, JSONSchemaObject } from '@framers/agentos';
import type { RAGAuditTrail } from '@framers/agentos';

/** Optional audit log interface (matches ActionAuditLog.log signature). */
interface AuditLogLike {
  log(entry: {
    seedId: string;
    action: string;
    outcome: string;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  }): void;
}

export interface RAGToolConfig {
  backendUrl: string;
  authToken?: string;
  defaultTopK?: number;
  /** Optional audit log for recording RAG operations. */
  auditLog?: AuditLogLike;
  /** Agent seed ID for audit attribution. */
  seedId?: string;
}

export const RAG_TOOL_ID = 'rag_query';

export class RAGTool implements ITool {
  readonly id = RAG_TOOL_ID;
  readonly name = 'RAG Memory Query';
  readonly displayName = 'RAG Memory Query';
  readonly description = 'Search the agent knowledge base using semantic and keyword retrieval. Returns relevant document chunks with audit trail.';
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
          includeAudit: true,
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

      // Log audit trail if available
      const auditTrail = result.auditTrail as RAGAuditTrail | undefined;
      if (auditTrail && this.config.auditLog && this.config.seedId) {
        this.config.auditLog.log({
          seedId: this.config.seedId,
          action: 'rag_query',
          outcome: 'success',
          durationMs: auditTrail.summary.totalDurationMs,
          metadata: {
            trailId: auditTrail.trailId,
            query: auditTrail.query,
            totalOperations: auditTrail.summary.totalOperations,
            totalLLMCalls: auditTrail.summary.totalLLMCalls,
            totalTokens: auditTrail.summary.totalTokens,
            totalCostUSD: auditTrail.summary.totalCostUSD,
            operationTypes: auditTrail.summary.operationTypes,
            sourceSummary: auditTrail.summary.sourceSummary,
          },
        });
      }

      // Build output with audit summary for agent transparency
      const output: Record<string, unknown> = {
        query,
        results: chunks,
        totalResults: result.totalResults,
      };
      if (auditTrail) {
        output.audit = {
          operations: auditTrail.summary.totalOperations,
          llmCalls: auditTrail.summary.totalLLMCalls,
          tokens: auditTrail.summary.totalTokens,
          costUSD: auditTrail.summary.totalCostUSD,
          methods: auditTrail.summary.operationTypes,
          sources: auditTrail.summary.sourceSummary.uniqueDocuments,
          durationMs: auditTrail.summary.totalDurationMs,
        };
      }

      return {
        success: true,
        output: JSON.stringify(output),
      };
    } catch (err) {
      return {
        success: false,
        output: `RAG query error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
