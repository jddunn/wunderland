/**
 * @fileoverview LLM-based Query Expansion for RAG full-text search.
 * @module wunderland/rag/QueryExpander
 *
 * Expands a user query into 3-5 semantically diverse variant queries
 * using a small/cheap LLM call, then merges and deduplicates results
 * from the RAG backend.
 *
 * Ported from OpenClaw upstream (feat: llm-query-expansion-fts).
 */

import type { RAGQueryInput, RAGQueryResult, WunderlandRAGClient } from './rag-client.js';

// ============================================================================
// Configuration
// ============================================================================

export interface QueryExpanderConfig {
  /**
   * LLM invoker that takes a prompt string and returns expanded queries as JSON.
   * Should use a fast/cheap model (e.g. via SmallModelResolver).
   */
  invoker: (prompt: string) => Promise<string>;

  /**
   * Maximum number of expanded queries to generate.
   * @default 4
   */
  maxExpansions?: number;

  /**
   * Whether to include the original query alongside expansions.
   * @default true
   */
  includeOriginal?: boolean;

  /**
   * Minimum query length (in chars) to trigger expansion.
   * Very short queries (e.g. "hi") are not worth expanding.
   * @default 8
   */
  minQueryLength?: number;

  /**
   * Timeout in ms for the LLM expansion call.
   * @default 5000
   */
  timeoutMs?: number;

  /**
   * Enable debug logging.
   * @default false
   */
  debug?: boolean;
}

// ============================================================================
// QueryExpander
// ============================================================================

/**
 * Expands user queries for better RAG full-text search recall.
 *
 * Strategy:
 * 1. Send the original query to a small LLM with instructions to produce
 *    diverse reformulations (synonyms, rephrasing, aspect decomposition).
 * 2. Run each expanded query against the RAG backend in parallel.
 * 3. Merge results, deduplicate by chunkId, take best scores.
 *
 * @example
 * ```typescript
 * const expander = new QueryExpander({
 *   invoker: async (prompt) => callSmallLLM(prompt),
 * });
 *
 * const result = await expander.expandedQuery(ragClient, {
 *   query: 'How do I deploy to production?',
 *   topK: 10,
 * });
 * ```
 */
export class QueryExpander {
  private readonly config: Required<
    Pick<QueryExpanderConfig, 'maxExpansions' | 'includeOriginal' | 'minQueryLength' | 'timeoutMs' | 'debug'>
  > & { invoker: QueryExpanderConfig['invoker'] };

  constructor(config: QueryExpanderConfig) {
    this.config = {
      invoker: config.invoker,
      maxExpansions: config.maxExpansions ?? 4,
      includeOriginal: config.includeOriginal ?? true,
      minQueryLength: config.minQueryLength ?? 8,
      timeoutMs: config.timeoutMs ?? 5000,
      debug: config.debug ?? false,
    };
  }

  /**
   * Expand a query into multiple variant queries using LLM.
   * Returns the original query plus expansions.
   */
  async expand(query: string): Promise<string[]> {
    const trimmed = query.trim();

    // Short queries don't benefit from expansion
    if (trimmed.length < this.config.minQueryLength) {
      return [trimmed];
    }

    const prompt = this.buildExpansionPrompt(trimmed);

    try {
      const raw = await this.withTimeout(
        this.config.invoker(prompt),
        this.config.timeoutMs,
      );

      const expansions = this.parseExpansions(raw);

      if (this.config.debug) {
        console.log('[QueryExpander] Original:', trimmed);
        console.log('[QueryExpander] Expansions:', expansions);
      }

      const queries = this.config.includeOriginal
        ? [trimmed, ...expansions]
        : expansions.length > 0 ? expansions : [trimmed];

      // Deduplicate (case-insensitive)
      const seen = new Set<string>();
      return queries.filter((q) => {
        const key = q.toLowerCase().trim();
        if (seen.has(key) || !key) return false;
        seen.add(key);
        return true;
      });
    } catch (err) {
      if (this.config.debug) {
        console.warn('[QueryExpander] Expansion failed, using original query:', err);
      }
      // Graceful fallback — just use original query
      return [trimmed];
    }
  }

  /**
   * Run an expanded query against a RAG client, merging results.
   */
  async expandedQuery(
    client: WunderlandRAGClient,
    input: RAGQueryInput,
  ): Promise<RAGQueryResult> {
    const start = Date.now();
    const variants = await this.expand(input.query);

    if (variants.length <= 1) {
      // No expansion needed/possible, just run normally
      return client.query(input);
    }

    // Run all variant queries in parallel
    const results = await Promise.allSettled(
      variants.map((q) =>
        client.query({ ...input, query: q }),
      ),
    );

    // Merge results: deduplicate by chunkId, keep highest score
    const chunkMap = new Map<
      string,
      RAGQueryResult['chunks'][number]
    >();

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const chunk of result.value.chunks) {
        const existing = chunkMap.get(chunk.chunkId);
        if (!existing || chunk.score > existing.score) {
          chunkMap.set(chunk.chunkId, chunk);
        }
      }
    }

    // Sort by score descending, take topK
    const topK = input.topK ?? 10;
    const merged = [...chunkMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    const processingTimeMs = Date.now() - start;

    return {
      success: true,
      query: input.query,
      chunks: merged,
      totalResults: merged.length,
      processingTimeMs,
    };
  }

  /**
   * Build the LLM prompt for query expansion.
   */
  private buildExpansionPrompt(query: string): string {
    return `You are a search query expansion assistant. Given a user's search query, generate ${this.config.maxExpansions} diverse reformulations that would help find relevant documents.

Rules:
- Each reformulation should capture a different aspect or use different terminology
- Include synonyms, related concepts, and alternative phrasings
- Keep reformulations concise (under 30 words each)
- Output ONLY a JSON array of strings, nothing else

User query: "${query}"

Output:`;
  }

  /**
   * Parse LLM response into an array of expanded queries.
   */
  private parseExpansions(raw: string): string[] {
    const trimmed = raw.trim();

    // Try JSON array parse
    try {
      // Find the JSON array in the response
      const match = trimmed.match(/\[[\s\S]*?\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .slice(0, this.config.maxExpansions)
            .map((s) => s.trim());
        }
      }
    } catch {
      // Fall through to line-by-line parsing
    }

    // Fallback: parse line-by-line (numbered or bulleted lists)
    const lines = trimmed
      .split('\n')
      .map((line) => line.replace(/^\s*[\d\-\*\•\.]+[\s\.\)]*/, '').trim())
      .filter((line) => line.length > 3 && line.length < 200);

    return lines.slice(0, this.config.maxExpansions);
  }

  /**
   * Wrap a promise with a timeout.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Query expansion timeout')), ms);
      promise
        .then((val) => { clearTimeout(timer); resolve(val); })
        .catch((err) => { clearTimeout(timer); reject(err); });
    });
  }
}
