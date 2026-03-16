/**
 * @fileoverview Local vector store memory_read tool.
 *
 * When no HTTP RAG backend is configured, this creates a memory_read tool
 * that queries the local SqlVectorStore directly. It generates query embeddings
 * via OpenAI and searches both `knowledge_base` and `auto_memories` collections.
 */

import type { IVectorStore } from '@framers/agentos';
import { HydeRetriever, type HydeConfig } from '@framers/agentos/rag';
import { createMemoryReadTool } from '../../../tools/MemoryReadTool.js';
import type { ToolExecutionContext } from '@framers/agentos';

const COLLECTIONS = ['knowledge_base', 'auto_memories'] as const;

type LocalMemoryLlmConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
};

type LocalMemoryHydeConfig = Partial<HydeConfig> & {
  llm?: LocalMemoryLlmConfig;
};

/**
 * Generate an embedding for a query string using OpenAI embeddings API.
 */
async function generateQueryEmbedding(
  text: string,
  apiKey: string,
  model = 'text-embedding-3-small',
): Promise<number[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text, model }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI embeddings API ${res.status}: ${detail}`);
  }

  const data = await res.json() as any;
  return data?.data?.[0]?.embedding ?? [];
}

function normalizeBaseUrl(baseUrl?: string): string {
  const trimmed = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  return trimmed ? trimmed.replace(/\/+$/, '') : 'https://api.openai.com/v1';
}

function createOpenAICompatibleLlmCaller(config: LocalMemoryLlmConfig) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);

  return async (systemPrompt: string, userPrompt: string): Promise<string> => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        ...(config.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LLM hypothesis generation failed (${res.status}): ${detail}`);
    }

    const data = await res.json() as any;
    return (
      data?.choices?.[0]?.message?.content
      ?? data?.choices?.[0]?.text
      ?? ''
    );
  };
}

async function queryCollections(opts: {
  vectorStore: IVectorStore;
  embedding: number[];
  queryText: string;
  topK: number;
  minSimilarityScore?: number;
  forceVectorOnly?: boolean;
}) {
  const { vectorStore, embedding, queryText, topK, minSimilarityScore, forceVectorOnly } = opts;
  const results = await Promise.all(
    COLLECTIONS.map(async (collection) => {
      try {
        if (!forceVectorOnly && typeof vectorStore.hybridSearch === 'function') {
          return await vectorStore.hybridSearch(collection, embedding, queryText, {
            topK,
            alpha: 0.7,
            minSimilarityScore,
          });
        }
        return await vectorStore.query(collection, embedding, {
          topK,
          minSimilarityScore,
        });
      } catch {
        return null;
      }
    }),
  );

  return results
    .filter(Boolean)
    .flatMap((result) => result!.documents ?? []);
}

/**
 * Create a memory_read tool backed by the local SqlVectorStore.
 * Returns null if required dependencies (vectorStore, apiKey) are missing.
 */
export function createLocalMemoryReadTool(opts: {
  vectorStore: IVectorStore;
  openaiApiKey: string;
  embeddingModel?: string;
  hyde?: LocalMemoryHydeConfig;
}) {
  const { vectorStore, openaiApiKey, embeddingModel } = opts;
  const hydeConfig = opts.hyde?.enabled ? opts.hyde : undefined;
  const hydeRetriever =
    hydeConfig?.llm
      ? new HydeRetriever({
          config: hydeConfig,
          llmCaller: createOpenAICompatibleLlmCaller(hydeConfig.llm),
          embeddingManager: {
            generateEmbeddings: async ({ texts }: { texts: string | string[] }) => {
              const firstText = Array.isArray(texts) ? texts[0] : texts;
              return {
                embeddings: [await generateQueryEmbedding(firstText, openaiApiKey, embeddingModel)],
              };
            },
          } as any,
        })
      : null;

  return createMemoryReadTool(async (input: {
    query: string;
    topK: number;
    context: ToolExecutionContext;
  }) => {
    const { query, topK } = input;
    let queryTextForEmbedding = query;
    let queryTextForSearch = query;
    let minSimilarityScore: number | undefined;
    let forceVectorOnly = false;

    if (hydeRetriever && hydeConfig) {
      try {
        const { hypothesis } = await hydeRetriever.generateHypothesis(query);
        if (hypothesis) {
          queryTextForEmbedding = hypothesis;
          queryTextForSearch = hypothesis;
          forceVectorOnly = true;
        }
      } catch {
        // Fall back to standard retrieval if HyDE generation fails.
      }
    }

    // Generate query embedding
    const embedding = await generateQueryEmbedding(
      queryTextForEmbedding,
      openaiApiKey,
      embeddingModel,
    );
    if (embedding.length === 0) {
      return { items: [], context: 'No embedding generated for query.' };
    }

    let allDocs = await queryCollections({
      vectorStore,
      embedding,
      queryText: queryTextForSearch,
      topK,
      minSimilarityScore,
      forceVectorOnly,
    });

    if (hydeConfig?.enabled && forceVectorOnly) {
      const threshold =
        typeof hydeConfig.initialThreshold === 'number'
          ? hydeConfig.initialThreshold
          : 0.7;
      const minThreshold =
        typeof hydeConfig.minThreshold === 'number'
          ? hydeConfig.minThreshold
          : 0.3;
      const thresholdStep =
        typeof hydeConfig.thresholdStep === 'number' && hydeConfig.thresholdStep > 0
          ? hydeConfig.thresholdStep
          : 0.1;
      const adaptiveThreshold = hydeConfig.adaptiveThreshold !== false;

      minSimilarityScore = threshold;
      allDocs = await queryCollections({
        vectorStore,
        embedding,
        queryText: queryTextForSearch,
        topK,
        minSimilarityScore,
        forceVectorOnly: true,
      });

      while (
        adaptiveThreshold &&
        allDocs.length === 0 &&
        minSimilarityScore - thresholdStep >= minThreshold
      ) {
        minSimilarityScore = Math.round((minSimilarityScore - thresholdStep) * 100) / 100;
        allDocs = await queryCollections({
          vectorStore,
          embedding,
          queryText: queryTextForSearch,
          topK,
          minSimilarityScore,
          forceVectorOnly: true,
        });
      }
    }

    allDocs = allDocs
      .sort((a, b) => (b.similarityScore ?? 0) - (a.similarityScore ?? 0))
      .slice(0, topK);

    const items = allDocs.map((doc) => ({
      text: doc.textContent ?? '',
      score: doc.similarityScore,
      source: (doc.metadata?.source as string | undefined)
        ?? (doc.metadata?.collection as string | undefined)
        ?? doc.id,
      metadata: doc.metadata,
    }));

    const context = items.length === 0
      ? 'No relevant long-term memory found.'
      : items
          .map((item, i) => {
            const source = item.source ? ` (${item.source})` : '';
            const score = typeof item.score === 'number' ? ` [${(item.score * 100).toFixed(0)}%]` : '';
            return `[${i + 1}]${source}${score}\n${item.text}`;
          })
          .join('\n\n');

    return { items, context };
  });
}
