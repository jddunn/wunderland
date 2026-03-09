/**
 * @fileoverview RAG memory query tool for Wunderland agents.
 * Allows agents to search their RAG memory during tool-calling conversations.
 * Supports audit trail generation for transparent RAG operation tracking.
 * @module wunderland/tools/RAGTool
 */

import type { ITool, ToolExecutionResult, ToolExecutionContext, JSONSchemaObject } from '@framers/agentos';
import type { RAGAuditTrail } from '@framers/agentos';
import { WunderlandRAGClient, type RAGQueryInput } from '../rag/rag-client.js';

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
  defaultCollectionIds?: string[];
  preset?: 'fast' | 'balanced' | 'accurate';
  includeAudit?: boolean;
  includeGraphRag?: boolean;
  includeDebug?: boolean;
  queryVariants?: string[];
  rewrite?: {
    enabled?: boolean;
    maxVariants?: number;
  };
  strategy?: 'similarity' | 'mmr' | 'hybrid_search';
  strategyParams?: {
    mmrLambda?: number;
    mmrCandidateMultiplier?: number;
  };
  similarityThreshold?: number;
  filters?: Record<string, unknown>;
  includeMetadata?: boolean;
  /** Optional audit log for recording RAG operations. */
  auditLog?: AuditLogLike;
  /** Agent seed ID for audit attribution. */
  seedId?: string;
}

export const RAG_TOOL_ID = 'rag_query';

export class RAGTool implements ITool {
  readonly id = RAG_TOOL_ID;
  readonly name = RAG_TOOL_ID;
  readonly displayName = 'RAG Memory Query';
  readonly description = 'Search the agent knowledge base using semantic and keyword retrieval. Returns relevant document chunks with audit trail.';
  readonly hasSideEffects = false;
  readonly category = 'memory';

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query text.' },
      topK: { type: 'number', description: 'Maximum number of results to return (default: 5).' },
      collectionId: { type: 'string', description: 'Optional collection ID to search within.' },
      preset: { type: 'string', enum: ['fast', 'balanced', 'accurate'], description: 'Retrieval preset override.' },
      includeGraphRag: { type: 'boolean', description: 'When true, include graph-based entity and relationship context.' },
      includeAudit: { type: 'boolean', description: 'When true, include RAG audit metadata.' },
      debug: { type: 'boolean', description: 'When true, include pipeline debug trace.' },
    },
    required: ['query'],
  };

  private readonly config: RAGToolConfig;
  private readonly client: WunderlandRAGClient;

  constructor(config: RAGToolConfig) {
    this.config = config;
    this.client = new WunderlandRAGClient({ baseUrl: config.backendUrl, authToken: config.authToken });
  }

  async execute(input: Record<string, unknown>, _context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    const query = input.query as string;
    const topK = (input.topK as number) ?? this.config.defaultTopK ?? 5;
    const collectionId = input.collectionId as string | undefined;
    const request: RAGQueryInput = {
      query,
      topK,
      preset:
        (input.preset as RAGQueryInput['preset'])
        ?? this.config.preset
        ?? undefined,
      collectionIds: collectionId
        ? [collectionId]
        : this.config.defaultCollectionIds,
      includeAudit:
        typeof input.includeAudit === 'boolean'
          ? input.includeAudit
          : (this.config.includeAudit ?? true),
      includeGraphRag:
        typeof input.includeGraphRag === 'boolean'
          ? input.includeGraphRag
          : (this.config.includeGraphRag ?? false),
      debug:
        typeof input.debug === 'boolean'
          ? input.debug
          : (this.config.includeDebug ?? false),
      queryVariants: this.config.queryVariants,
      rewrite: this.config.rewrite,
      strategy: this.config.strategy,
      strategyParams: this.config.strategyParams,
      similarityThreshold: this.config.similarityThreshold,
      filters: this.config.filters,
      includeMetadata: this.config.includeMetadata,
    };

    try {
      const result = await this.client.query(request);
      const chunks = (result.chunks ?? []).map((c: any) => ({
        content: c.content,
        score: c.score,
        documentId: c.documentId,
        metadata: c.metadata,
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
      if (result.graphContext) output.graphContext = result.graphContext;
      if (result.debugTrace) output.debugTrace = result.debugTrace;

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
