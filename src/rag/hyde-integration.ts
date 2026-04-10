// @ts-nocheck
/**
 * @fileoverview HyDE integration for Wunderland's local memory retrieval.
 *
 * Wraps the memory_read tool's query function with HyDE: generates a
 * hypothetical answer before embedding, improving retrieval quality.
 * Configurable via agent.config.json under `rag.hyde`.
 *
 * @module wunderland/rag/hyde-integration
 */

import {
  HydeRetriever,
  type HydeConfig,
  type HydeLlmCaller,
  resolveHydeConfig,
} from '@framers/agentos/rag';
import type { IEmbeddingManager, IVectorStore } from '@framers/agentos';

import type { WunderlandAgentRagConfig } from '../api/types.js';

/** Resolve HyDE config from agent.config.json rag section. */
export function resolveHydeFromAgentConfig(
  ragConfig?: WunderlandAgentRagConfig,
): HydeConfig {
  const hyde = ragConfig?.hyde;
  return {
    // Default: enabled when RAG is enabled (user can disable per-agent)
    enabled: hyde?.enabled ?? true,
    initialThreshold: hyde?.initialThreshold ?? 0.7,
    minThreshold: hyde?.minThreshold ?? 0.3,
    thresholdStep: hyde?.thresholdStep ?? 0.1,
    adaptiveThreshold: hyde?.adaptiveThreshold ?? true,
    maxHypothesisTokens: hyde?.maxHypothesisTokens,
    hypothesisSystemPrompt: hyde?.hypothesisSystemPrompt,
    fullAnswerGranularity: hyde?.fullAnswerGranularity,
  };
}

/**
 * Create a HyDE-aware vector store query wrapper.
 *
 * When HyDE is enabled, the query text is first turned into a hypothetical
 * answer, embedded, and used for retrieval with adaptive thresholding.
 * When disabled, falls through to standard embedding + query.
 */
export function createHydeQueryWrapper(opts: {
  vectorStore: IVectorStore;
  embeddingManager: IEmbeddingManager;
  llmCaller: HydeLlmCaller;
  collectionName: string;
  hydeConfig: HydeConfig;
}): {
  query: (queryText: string, topK?: number) => Promise<{
    chunks: Array<{ content: string; score: number; metadata?: Record<string, unknown> }>;
    hydeUsed: boolean;
    hypothesis?: string;
    effectiveThreshold?: number;
  }>;
  retriever: HydeRetriever | null;
} {
  const config = resolveHydeConfig(opts.hydeConfig);

  if (!config.enabled) {
    // HyDE disabled — return passthrough
    return {
      query: async (queryText, topK = 5) => {
        const embedding = await opts.embeddingManager.generateEmbeddings({ texts: [queryText] });
        if (!embedding.embeddings?.[0]?.length) return { chunks: [], hydeUsed: false };

        const result = await opts.vectorStore.query(opts.collectionName, embedding.embeddings[0], {
          topK,
          includeTextContent: true,
          includeMetadata: true,
        });

        return {
          chunks: result.documents.map((doc) => ({
            content: doc.textContent || '',
            score: doc.similarityScore,
            metadata: doc.metadata as Record<string, unknown> | undefined,
          })),
          hydeUsed: false,
        };
      },
      retriever: null,
    };
  }

  const retriever = new HydeRetriever({
    config,
    llmCaller: opts.llmCaller,
    embeddingManager: opts.embeddingManager,
  });

  return {
    query: async (queryText, topK = 5) => {
      const result = await retriever.retrieve({
        query: queryText,
        vectorStore: opts.vectorStore,
        collectionName: opts.collectionName,
        queryOptions: { topK, includeTextContent: true, includeMetadata: true },
      });

      return {
        chunks: result.queryResult.documents.map((doc) => ({
          content: doc.textContent || '',
          score: doc.similarityScore,
          metadata: doc.metadata as Record<string, unknown> | undefined,
        })),
        hydeUsed: true,
        hypothesis: result.hypothesis,
        effectiveThreshold: result.effectiveThreshold,
      };
    },
    retriever,
  };
}
