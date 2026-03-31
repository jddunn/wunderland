/**
 * @fileoverview QueryRouter singleton for the Wunderland CLI.
 *
 * Initialises once on first use, shared across chat sessions within the
 * same process. The init is lazy and non-blocking — the CLI starts
 * immediately and the QueryRouter becomes available in the background.
 *
 * Corpus paths are resolved from multiple sources:
 * 1. The user's project working directory (for project-local docs)
 * 2. Wunderland built-in docs at `packages/wunderland/docs/`
 * 3. AgentOS live-docs at `apps/wunderland-live-docs/docs/`
 * 4. Shared monorepo docs at `docs/`
 * 5. Curated skill registry markdown
 *
 * When a `ragConfig` is supplied (from `agent.config.json`), the router is
 * enhanced with a {@link UnifiedRetriever} that orchestrates hybrid search
 * (BM25 + dense), RAPTOR hierarchical summaries, HyDE hypothesis generation,
 * and cognitive memory integration. Each feature is independently enabled
 * by the corresponding `rag.*` config field.
 *
 * The singleton gracefully degrades: if initialisation fails (missing API
 * key, no corpus files, network error), callers receive `null` instead of
 * a router instance, and the CLI falls back to its existing RAG tools.
 *
 * @module wunderland/runtime/query-router-init
 */

import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QueryRouter } from '@framers/agentos/query-router';
import type {
  ClassificationResult,
  QueryRouterConfig,
  QueryRouterCorpusStats,
  RetrievedChunk,
} from '@framers/agentos/query-router';
import type { WunderlandAgentRagConfig } from '../api/types.js';
import type { MemorySystem } from '../memory/index.js';
import type { IVectorStore, IEmbeddingManager } from '@framers/agentos';
import {
  buildUnifiedRetrieverFromConfig,
  formatUnifiedRetrievalLog,
  type UnifiedRetrieverBuildResult,
} from './unified-retriever-builder.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options accepted by {@link initCliQueryRouter} to customise the router
 * for the current agent session.
 */
export interface CliQueryRouterOptions {
  /** LLM API key for the classifier and generator. */
  apiKey?: string;

  /**
   * Base URL override for the LLM provider (e.g. OpenRouter compatibility
   * endpoint or a local Ollama URL).
   */
  baseUrl?: string;

  /** Separate API key for embedding calls (defaults to `apiKey`). */
  embeddingApiKey?: string;

  /** Separate base URL for embedding calls. */
  embeddingBaseUrl?: string;

  /** Classifier / generation model override. */
  model?: string;

  /**
   * Deep-generation model override (used for tier-2/3 queries).
   * Falls back to `model` when not specified.
   */
  modelDeep?: string;

  /** Extra corpus directories to index (e.g. user's project docs). */
  extraCorpusPaths?: string[];

  /** Maximum tier the classifier may assign (0-3). */
  maxTier?: 0 | 1 | 2 | 3;

  /** Whether verbose/debug logging is enabled. */
  verbose?: boolean;

  /**
   * Logger sink. Defaults to `console` when not supplied.
   * Accepts a minimal subset so callers can route through their own sink.
   */
  logger?: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };

  // ── Unified retrieval config (new) ──────────────────────────────────

  /**
   * Full RAG config from `agent.config.json`.
   *
   * When provided, the router is enhanced with a {@link UnifiedRetriever}
   * that wires BM25 hybrid search, RAPTOR tree, HyDE, and memory
   * integration based on the enabled features.
   */
  ragConfig?: WunderlandAgentRagConfig;

  /**
   * The wunderland MemorySystem (wraps CognitiveMemoryManager).
   * Wired into the UnifiedRetriever when `ragConfig.memoryIntegration.enabled`.
   */
  memorySystem?: MemorySystem | null;

  /**
   * The agent's vector store instance from AgentStorageManager.
   * Used for hybrid search (the dense side) and RAPTOR tree storage.
   */
  vectorStore?: IVectorStore;

  /**
   * Embedding manager for hybrid search and RAPTOR clustering.
   * When not provided, the builder attempts to create one from the
   * embedding API key.
   */
  embeddingManager?: IEmbeddingManager;

  /**
   * LLM caller function for HyDE hypothesis generation and RAPTOR summaries.
   * When not provided, HyDE and RAPTOR features that require LLM calls
   * will be skipped.
   */
  llmCaller?: (prompt: string) => Promise<string>;

  /**
   * Per-agent workspace directory for BM25/RAPTOR state persistence.
   * Typically `~/.wunderland/agents/<agent-id>/`.
   */
  agentDir?: string;

  /**
   * Optional RerankerService for provider-backed reranking (Cohere, local cross-encoder, LLM judge).
   * When provided with a `rerankChain` config, replaces the built-in lexical reranker.
   */
  rerankerService?: {
    rerankChain: (query: string, chunks: any[], chain: Array<{ provider: string; topK: number; model?: string }>) => Promise<any[]>;
  };

  /**
   * Reranker chain stages. Used with `rerankerService` to define a multi-stage pipeline.
   * Default: single-stage lexical reranker (built-in).
   */
  rerankChain?: Array<{ provider: string; topK: number; model?: string }>;
}

// ============================================================================
// Module state
// ============================================================================

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Best-effort detection of the monorepo root by walking upward from this
 * file's directory until we find a `pnpm-workspace.yaml` or top-level
 * `package.json` with a `workspaces` field. Falls back to four levels up.
 */
function findMonorepoRoot(): string {
  let dir = MODULE_DIR;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: packages/wunderland/src/runtime -> 4 levels up
  return resolve(MODULE_DIR, '../../../..');
}

const REPO_ROOT = findMonorepoRoot();

/**
 * Static corpus paths relative to the monorepo root.
 * Additional user-supplied paths are prepended at init time.
 */
function getBuiltInCorpusPaths(): string[] {
  return [
    resolve(REPO_ROOT, 'apps/wunderland-live-docs/docs/'),
    resolve(REPO_ROOT, 'packages/wunderland/docs/'),
    resolve(REPO_ROOT, 'docs/'),
    resolve(REPO_ROOT, 'packages/agentos-skills/registry/curated/'),
  ].filter((p) => existsSync(p));
}

/** Cached singleton instance, set after first successful init. */
let routerInstance: QueryRouter | null = null;

/** In-flight initialisation promise, used to deduplicate concurrent callers. */
let initPromise: Promise<QueryRouter | null> | null = null;

/**
 * Cached unified retriever build result, set after successful init.
 * Exposed for shutdown persistence and status reporting.
 */
let unifiedBuildResult: UnifiedRetrieverBuildResult | null = null;

// ============================================================================
// Reranker (same lightweight heuristic the bot uses)
// ============================================================================

function normalizeRerankText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenizeRerankText(text: string): Set<string> {
  const STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
    'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this',
    'to', 'what', 'when', 'where', 'which', 'why', 'with',
  ]);
  return new Set(
    normalizeRerankText(text)
      .split(/\s+/)
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term)),
  );
}

function computeOverlap(queryTerms: Set<string>, candidateTerms: Set<string>): number {
  if (queryTerms.size === 0 || candidateTerms.size === 0) return 0;
  let matches = 0;
  for (const term of queryTerms) {
    if (candidateTerms.has(term)) matches += 1;
  }
  return matches / queryTerms.size;
}

/**
 * Lightweight lexical reranker that boosts chunks whose headings, content,
 * or source paths overlap with the query terms. Used as the host-provided
 * `rerank` callback for the QueryRouter.
 */
async function rerankCliChunks(
  query: string,
  chunks: RetrievedChunk[],
  topN: number,
): Promise<RetrievedChunk[]> {
  if (chunks.length <= 1) return chunks.slice(0, topN);

  const queryTerms = tokenizeRerankText(query);
  const normalizedQuery = normalizeRerankText(query);

  const scored = chunks.map((chunk, index) => {
    const headingOverlap = computeOverlap(queryTerms, tokenizeRerankText(chunk.heading));
    const contentOverlap = computeOverlap(queryTerms, tokenizeRerankText(chunk.content));
    const pathOverlap = computeOverlap(queryTerms, tokenizeRerankText(chunk.sourcePath));

    const normalizedChunkText = normalizeRerankText(
      `${chunk.heading} ${chunk.content} ${chunk.sourcePath}`,
    );
    const exactPhraseBoost =
      normalizedQuery.length >= 4 && normalizedChunkText.includes(normalizedQuery) ? 0.18 : 0;

    const score =
      chunk.relevanceScore * 0.42 +
      headingOverlap * 0.22 +
      contentOverlap * 0.18 +
      pathOverlap * 0.08 +
      exactPhraseBoost;

    return { chunk, index, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.chunk.relevanceScore !== a.chunk.relevanceScore) {
      return b.chunk.relevanceScore - a.chunk.relevanceScore;
    }
    return a.index - b.index;
  });

  return scored.slice(0, topN).map((entry) => entry.chunk);
}

// ============================================================================
// Provider resolution (mirrors bot logic but accepts explicit overrides)
// ============================================================================

function modelRequiresOpenRouter(model: string | undefined): boolean {
  const normalized = model?.trim();
  if (!normalized || !normalized.includes('/')) return false;
  return !normalized.startsWith('openai/');
}

function isOpenAiShorthand(model: string): boolean {
  return /^(gpt-|o[1-9]|chatgpt-)/i.test(model);
}

function shouldUseOpenRouter(model?: string): boolean {
  if (modelRequiresOpenRouter(model) && process.env.OPENROUTER_API_KEY) return true;
  return !process.env.OPENAI_API_KEY && Boolean(process.env.OPENROUTER_API_KEY);
}

function normalizeModel(
  model: string | undefined,
  useOpenRouter: boolean,
  fallback: string,
): string {
  const normalized = model?.trim();
  if (!normalized) return useOpenRouter ? `openai/${fallback}` : fallback;
  if (useOpenRouter) {
    if (normalized.includes('/')) return normalized;
    return isOpenAiShorthand(normalized) ? `openai/${normalized}` : normalized;
  }
  if (normalized.includes('/') && !normalized.startsWith('openai/')) return fallback;
  return normalized.startsWith('openai/') ? normalized.slice('openai/'.length) : normalized;
}

// ============================================================================
// Config builder
// ============================================================================

/**
 * Builds the full {@link QueryRouterConfig} from CLI session options.
 * Falls back to environment variables when explicit overrides are not supplied.
 */
function buildCliQueryRouterConfig(opts: CliQueryRouterOptions): QueryRouterConfig {
  const useOR = shouldUseOpenRouter(opts.model);
  const standardModel = normalizeModel(opts.model, useOR, 'gpt-4o-mini');

  // Provider config
  const apiKey =
    opts.apiKey ||
    (useOR ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY) ||
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENAI_API_KEY;
  const baseUrl =
    opts.baseUrl ||
    (useOR ? 'https://openrouter.ai/api/v1' : undefined);

  // Embedding config — prefer a direct OpenAI key for embeddings
  const embeddingApiKey = opts.embeddingApiKey || process.env.OPENAI_API_KEY || apiKey;
  const embeddingBaseUrl =
    opts.embeddingBaseUrl ||
    (embeddingApiKey === process.env.OPENAI_API_KEY ? undefined : baseUrl);

  // Deep-research (requires SERPER_API_KEY)
  const deepResearchEnabled = Boolean(process.env.SERPER_API_KEY);

  // Corpus paths: user extras first, then built-in, with cwd docs at the front
  const cwdDocs = resolve(process.cwd(), 'docs');
  const extraPaths = opts.extraCorpusPaths ?? [];
  const allCorpusPaths = [
    ...(existsSync(cwdDocs) ? [cwdDocs] : []),
    ...extraPaths.filter((p) => existsSync(p)),
    ...getBuiltInCorpusPaths(),
  ];

  // Deduplicate corpus paths (resolve to absolute before comparing)
  const seen = new Set<string>();
  const corpusPaths: string[] = [];
  for (const p of allCorpusPaths) {
    const abs = resolve(p);
    if (!seen.has(abs)) {
      seen.add(abs);
      corpusPaths.push(abs);
    }
  }

  const logger = opts.logger ?? console;

  return {
    knowledgeCorpus: corpusPaths,
    classifierModel: standardModel,
    generationModel: standardModel,
    generationModelDeep: normalizeModel(opts.modelDeep, useOR, 'gpt-4o'),
    apiKey,
    baseUrl,
    embeddingApiKey,
    embeddingBaseUrl,
    graphEnabled: false,
    deepResearchEnabled,
    rerank: opts.rerankerService && opts.rerankChain
      ? (query: string, chunks: RetrievedChunk[], topN: number) =>
          opts.rerankerService!.rerankChain(query, chunks as any[], opts.rerankChain!).then((r: any[]) => r.slice(0, topN) as RetrievedChunk[])
      : rerankCliChunks,
    availableTools: deepResearchEnabled ? ['web_search', 'deep_research'] : [],
    maxTier: opts.maxTier ?? 3,
    onClassification: (result: ClassificationResult) => {
      if (opts.verbose) {
        logger.log(
          `[QueryRouter] tier=${result.tier} confidence=${result.confidence.toFixed(2)} strategy=${result.strategy} reasoning="${result.reasoning}"`,
        );
      }
    },
  };
}

// ============================================================================
// Formatting helpers
// ============================================================================

/**
 * Formats the one-line startup log emitted after successful init.
 */
export function formatCliQueryRouterReadyLog(stats: QueryRouterCorpusStats): string {
  return (
    `[QueryRouter] Ready — paths=${stats.configuredPathCount} chunks=${stats.chunkCount} ` +
    `sources=${stats.sourceCount} topics=${stats.topicCount} mode=${stats.retrievalMode} ` +
    `embeddingDim=${stats.embeddingDimension} rerank=${stats.rerankRuntimeMode} ` +
    `deepResearch=${stats.deepResearchEnabled}/${stats.deepResearchRuntimeMode}`
  );
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialise the CLI QueryRouter singleton.
 *
 * Returns a promise that resolves to the router instance on success, or
 * `null` if initialisation fails (missing API key, empty corpus, etc.).
 * The promise is cached so concurrent callers deduplicate. A failed init
 * resets the cache so subsequent calls can retry.
 *
 * This function is intentionally non-throwing — callers should treat a
 * `null` result as "QueryRouter unavailable, proceed without it".
 */
export async function initCliQueryRouter(
  opts: CliQueryRouterOptions = {},
): Promise<QueryRouter | null> {
  if (routerInstance) return routerInstance;
  if (initPromise) return initPromise;

  const logger = opts.logger ?? console;

  initPromise = (async (): Promise<QueryRouter | null> => {
    const config = buildCliQueryRouterConfig(opts);

    // Note: even with empty knowledgeCorpus, the QueryRouter loads bundled
    // platform knowledge (243 entries) so it can still answer platform questions.

    // Bail early if no API key is available — classifier/generator need one.
    if (!config.apiKey) {
      logger.debug('[QueryRouter] No LLM API key available, skipping init.');
      return null;
    }

    logger.debug('[QueryRouter] Initialising...');
    const router = new QueryRouter(config);

    try {
      await router.init();
      routerInstance = router;
      const stats = router.getCorpusStats();
      logger.log(formatCliQueryRouterReadyLog(stats));

      // ── Unified Retriever wiring ────────────────────────────────────
      //
      // If the caller provided ragConfig from agent.config.json, build a
      // UnifiedRetriever with the configured sources (BM25, RAPTOR, HyDE,
      // memory) and attach it to the QueryRouter. This upgrades the
      // route() method from legacy QueryDispatcher to plan-based retrieval.
      if (opts.ragConfig) {
        try {
          const buildResult = await buildUnifiedRetrieverFromConfig({
            ragConfig: opts.ragConfig,
            vectorStore: opts.vectorStore,
            embeddingManager: opts.embeddingManager,
            memorySystem: opts.memorySystem,
            llmCaller: opts.llmCaller,
            llmApiKey: opts.apiKey,
            llmModel: opts.model,
            llmBaseUrl: opts.baseUrl,
            corpusPaths: config.knowledgeCorpus,
            agentDir: opts.agentDir,
            rerank: opts.rerankerService && opts.rerankChain
              ? (query: string, chunks: any[], topN: number) =>
                  opts.rerankerService!.rerankChain(query, chunks, opts.rerankChain!).then((r: any[]) => r.slice(0, topN))
              : rerankCliChunks,
            verbose: opts.verbose,
            logger,
          });

          if (buildResult.retriever) {
            router.setUnifiedRetriever(buildResult.retriever);
            unifiedBuildResult = buildResult;
            logger.log(formatUnifiedRetrievalLog(buildResult));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[RAG] Unified retriever wiring failed (continuing with legacy): ${msg}`);
        }
      }

      return router;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[QueryRouter] Init failed (continuing without): ${message}`);
      return null;
    }
  })();

  try {
    return await initPromise;
  } catch {
    // Reset so subsequent calls can retry instead of replaying the failure.
    initPromise = null;
    return null;
  }
}

/**
 * Returns the cached QueryRouter instance, or `null` if not yet initialised
 * or if init failed. Does NOT trigger initialisation — use
 * {@link initCliQueryRouter} for that.
 */
export function getCliQueryRouter(): QueryRouter | null {
  return routerInstance;
}

/**
 * Returns the cached unified retriever build result, or `null` if unified
 * retrieval was not configured or has not yet been built.
 *
 * Useful for status reporting and shutdown persistence.
 *
 * @returns The build result, or `null`.
 */
export function getUnifiedRetrieverBuildResult(): UnifiedRetrieverBuildResult | null {
  return unifiedBuildResult;
}

/**
 * Test-only reset hook so unit tests can clear the singleton between runs.
 */
export function resetCliQueryRouterForTests(): void {
  routerInstance = null;
  initPromise = null;
  unifiedBuildResult = null;
}

// Re-export types that consumers need
export type { ClassificationResult, QueryRouterCorpusStats, RetrievedChunk } from '@framers/agentos/query-router';
export type { UnifiedRetrieverBuildResult } from './unified-retriever-builder.js';
