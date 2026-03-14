/**
 * @fileoverview Local vector store memory_read tool.
 *
 * When no HTTP RAG backend is configured, this creates a memory_read tool
 * that queries the local SqlVectorStore directly. It generates query embeddings
 * via OpenAI and searches both `knowledge_base` and `auto_memories` collections.
 */

import type { IVectorStore } from '@framers/agentos';
import { createMemoryReadTool } from '../../../tools/MemoryReadTool.js';
import type { ToolExecutionContext } from '@framers/agentos';

const COLLECTIONS = ['knowledge_base', 'auto_memories'] as const;

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

/**
 * Create a memory_read tool backed by the local SqlVectorStore.
 * Returns null if required dependencies (vectorStore, apiKey) are missing.
 */
export function createLocalMemoryReadTool(opts: {
  vectorStore: IVectorStore;
  openaiApiKey: string;
  embeddingModel?: string;
}) {
  const { vectorStore, openaiApiKey, embeddingModel } = opts;

  return createMemoryReadTool(async (input: {
    query: string;
    topK: number;
    context: ToolExecutionContext;
  }) => {
    const { query, topK } = input;

    // Generate query embedding
    const embedding = await generateQueryEmbedding(query, openaiApiKey, embeddingModel);
    if (embedding.length === 0) {
      return { items: [], context: 'No embedding generated for query.' };
    }

    // Query all collections in parallel, gracefully skip missing ones
    const results = await Promise.all(
      COLLECTIONS.map(async (collection) => {
        try {
          // Prefer hybridSearch (combines vector + FTS) if available
          if (typeof vectorStore.hybridSearch === 'function') {
            return await vectorStore.hybridSearch(collection, embedding, query, {
              topK,
              alpha: 0.7, // 70% semantic, 30% lexical
            });
          }
          return await vectorStore.query(collection, embedding, { topK });
        } catch {
          // Collection may not exist yet — skip silently
          return null;
        }
      }),
    );

    // Merge and sort by similarity score (descending)
    const allDocs = results
      .filter(Boolean)
      .flatMap((r) => r!.documents ?? [])
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
