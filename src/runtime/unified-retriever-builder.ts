/**
 * @fileoverview Factory that builds a {@link UnifiedRetriever} from agent config.
 *
 * Reads the `rag` section of an agent's `agent.config.json` and wires together
 * the appropriate retrieval sources (BM25, RAPTOR, HyDE, memory) into a single
 * {@link UnifiedRetriever} instance. The resulting retriever is then attached
 * to the {@link QueryRouter} via `setUnifiedRetriever()` so that all queries
 * benefit from plan-based retrieval.
 *
 * Sources are optional and additive — each feature degrades gracefully when
 * its dependencies (API keys, vector stores, etc.) are unavailable.
 *
 * @module wunderland/runtime/unified-retriever-builder
 */

import type { IVectorStore, IEmbeddingManager } from '@framers/agentos';
import type { QueryRouter, RetrievedChunk } from '@framers/agentos/query-router';
import type { WunderlandAgentRagConfig } from '../api/types.js';
import type { MemorySystem } from '../memory/index.js';
import {
  BM25Index,
  HybridSearcher,
  RaptorTree,
  HydeRetriever,
  UnifiedRetriever,
  type UnifiedRetrieverDeps,
  type HybridSearcherConfig,
  type RaptorTreeConfig,
  type HydeConfig,
} from '@framers/agentos/rag';
import {
  loadBM25State,
  saveBM25State,
  loadRaptorState,
  computeCorpusHash,
  type SerializedBM25State,
} from './rag-state-persistence.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Dependencies needed to build the unified retriever from agent config.
 *
 * All fields are optional — the builder skips features whose dependencies
 * are missing and logs debug messages explaining what was skipped.
 */
export interface UnifiedRetrieverBuildContext {
  /**
   * The agent's RAG configuration from `agent.config.json`.
   * When `undefined` or `null`, returns `null` (legacy behaviour).
   */
  ragConfig?: WunderlandAgentRagConfig | null;

  /**
   * The QueryRouter's internal vector store (used for hybrid search).
   * Available after `router.init()` completes.
   */
  vectorStore?: IVectorStore;

  /**
   * Embedding manager for hybrid search and RAPTOR tree building.
   * Required for BM25 hybrid fusion (the dense side) and RAPTOR clustering.
   */
  embeddingManager?: IEmbeddingManager;

  /**
   * The wunderland MemorySystem (wraps CognitiveMemoryManager).
   * When provided and `memoryIntegration.enabled`, memory search is wired.
   */
  memorySystem?: MemorySystem | null;

  /**
   * LLM caller function for HyDE hypothesis generation and RAPTOR summaries.
   * Signature: `(prompt: string) => Promise<string>`.
   */
  llmCaller?: (prompt: string) => Promise<string>;

  /**
   * LLM API key for creating a HydeRetriever if no `llmCaller` is provided.
   */
  llmApiKey?: string;

  /**
   * LLM model identifier for HyDE.
   */
  llmModel?: string;

  /**
   * LLM base URL override for HyDE.
   */
  llmBaseUrl?: string;

  /**
   * Corpus file paths for computing the corpus hash (cache invalidation).
   */
  corpusPaths?: string[];

  /**
   * Per-agent workspace directory for BM25/RAPTOR persistence.
   * Typically `~/.wunderland/agents/<agent-id>/`.
   */
  agentDir?: string;

  /**
   * Rerank callback matching the QueryRouter's reranker signature.
   * Used as the UnifiedRetriever's reranker when provided.
   */
  rerank?: (query: string, chunks: RetrievedChunk[], topN: number) => Promise<RetrievedChunk[]>;

  /** Whether verbose logging is enabled. */
  verbose?: boolean;

  /**
   * Logger sink. Defaults to `console`.
   */
  logger?: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
}

/**
 * Result of building the unified retriever.
 *
 * Contains the retriever itself plus metadata about which sources were
 * wired, for startup logging.
 */
export interface UnifiedRetrieverBuildResult {
  /** The fully-wired UnifiedRetriever, or `null` if no sources could be created. */
  retriever: UnifiedRetriever | null;

  /** Which sources are active (for the startup log). */
  activeSources: {
    hybrid: boolean;
    raptor: boolean;
    hyde: boolean;
    memory: boolean;
    semanticChunking: boolean;
  };

  /** The BM25 index instance, if created (exposed for persistence on shutdown). */
  bm25Index?: BM25Index;

  /** The RAPTOR tree instance, if created (exposed for persistence on shutdown). */
  raptorTree?: RaptorTree;

  /** The HyDE hypothesis count, if configured. */
  hydeHypothesisCount?: number;
}

// ============================================================================
// Builder
// ============================================================================

/**
 * Builds a {@link UnifiedRetriever} from the agent's RAG configuration.
 *
 * This is the main entry point called by {@link initCliQueryRouter} after
 * the QueryRouter is initialized. It reads the `rag.*` config fields and
 * constructs the appropriate sources:
 *
 * 1. **Hybrid search** (`rag.hybrid.enabled`): Creates a {@link BM25Index}
 *    and {@link HybridSearcher} that combines dense vector + sparse keyword
 *    retrieval via Reciprocal Rank Fusion.
 *
 * 2. **RAPTOR tree** (`rag.raptor.enabled`): Creates a {@link RaptorTree}
 *    for hierarchical summary retrieval. Requires an LLM caller for
 *    summarization and an embedding manager for clustering.
 *
 * 3. **HyDE** (`rag.hyde.enabled`): Creates a {@link HydeRetriever} that
 *    generates hypothetical answers before embedding for improved recall.
 *
 * 4. **Memory integration** (`rag.memoryIntegration.enabled`): Wires the
 *    cognitive memory manager into the retriever for episodic/semantic search.
 *
 * All sources are optional — the retriever gracefully skips unavailable ones.
 *
 * @param ctx - Build context with dependencies and config.
 * @returns Build result with the retriever and active source metadata.
 *
 * @example
 * ```typescript
 * const result = await buildUnifiedRetrieverFromConfig({
 *   ragConfig: cfg.rag,
 *   vectorStore: router.getVectorStore(),
 *   embeddingManager: router.getEmbeddingManager(),
 *   llmCaller: (prompt) => callLlm(prompt),
 *   agentDir: '~/.wunderland/agents/my-agent',
 *   verbose: true,
 * });
 *
 * if (result.retriever) {
 *   router.setUnifiedRetriever(result.retriever);
 * }
 * ```
 */
export async function buildUnifiedRetrieverFromConfig(
  ctx: UnifiedRetrieverBuildContext,
): Promise<UnifiedRetrieverBuildResult> {
  const logger = ctx.logger ?? console;
  const ragConfig = ctx.ragConfig;

  const nullResult: UnifiedRetrieverBuildResult = {
    retriever: null,
    activeSources: {
      hybrid: false,
      raptor: false,
      hyde: false,
      memory: false,
      semanticChunking: false,
    },
  };

  // No config — legacy behaviour (no unified retriever).
  if (!ragConfig) {
    logger.debug('[RAG] No ragConfig provided — skipping unified retriever build.');
    return nullResult;
  }

  const activeSources = {
    hybrid: false,
    raptor: false,
    hyde: false,
    memory: false,
    semanticChunking: ragConfig.chunking?.strategy === 'semantic',
  };

  const deps: Partial<UnifiedRetrieverDeps> = {};
  let bm25Index: BM25Index | undefined;
  let raptorTree: RaptorTree | undefined;
  let hydeHypothesisCount: number | undefined;
  const corpusHash = ctx.corpusPaths ? computeCorpusHash(ctx.corpusPaths) : undefined;

  // ── 1. BM25 Hybrid Search ──────────────────────────────────────────────
  if (ragConfig.hybrid?.enabled !== false && ctx.vectorStore && ctx.embeddingManager) {
    try {
      bm25Index = new BM25Index();

      // Attempt to load persisted BM25 state
      if (ctx.agentDir) {
        const persisted = await loadBM25State(
          { agentDir: ctx.agentDir, logger },
          corpusHash,
        );
        if (persisted && persisted.documents.length > 0) {
          bm25Index.addDocuments(persisted.documents);
          logger.debug(`[RAG] Restored BM25 index: ${persisted.documents.length} documents from disk.`);
        }
      }

      const hybridConfig: HybridSearcherConfig = {
        denseWeight: ragConfig.hybrid?.denseWeight ?? 0.7,
        sparseWeight: ragConfig.hybrid?.sparseWeight ?? 0.3,
        fusionMethod: 'rrf',
      };

      const hybridSearcher = new HybridSearcher(
        ctx.vectorStore,
        ctx.embeddingManager,
        bm25Index,
        hybridConfig,
      );

      deps.hybridSearcher = hybridSearcher;
      activeSources.hybrid = true;
      logger.debug(
        `[RAG] Hybrid search wired: dense=${hybridConfig.denseWeight} sparse=${hybridConfig.sparseWeight}`,
      );
    } catch (err) {
      logger.warn(`[RAG] Failed to create hybrid searcher: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (ragConfig.hybrid?.enabled !== false) {
    logger.debug('[RAG] Hybrid search skipped — missing vectorStore or embeddingManager.');
  }

  // ── 2. RAPTOR Tree ─────────────────────────────────────────────────────
  if (ragConfig.raptor?.enabled !== false && ctx.llmCaller && ctx.embeddingManager && ctx.vectorStore) {
    try {
      const raptorConfig: RaptorTreeConfig = {
        llmCaller: ctx.llmCaller,
        embeddingManager: ctx.embeddingManager,
        vectorStore: ctx.vectorStore,
        collectionName: 'raptor-tree',
        clusterSize: ragConfig.raptor?.clusterSize ?? 8,
        maxDepth: ragConfig.raptor?.maxDepth ?? 4,
      };

      raptorTree = new RaptorTree(raptorConfig);

      // Check if we have a persisted tree that matches the current corpus
      let raptorValid = false;
      if (ctx.agentDir) {
        const persisted = await loadRaptorState(
          { agentDir: ctx.agentDir, logger },
          corpusHash,
        );
        if (persisted) {
          raptorValid = true;
          logger.debug(
            `[RAG] RAPTOR tree state valid: ${persisted.totalLayers} layers, ${persisted.totalNodes} nodes.`,
          );
        }
      }

      deps.raptorTree = raptorTree;
      activeSources.raptor = true;
      logger.debug(
        `[RAG] RAPTOR tree wired: maxDepth=${raptorConfig.maxDepth} clusterSize=${raptorConfig.clusterSize} ` +
        `prebuilt=${raptorValid}`,
      );
    } catch (err) {
      logger.warn(`[RAG] Failed to create RAPTOR tree: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (ragConfig.raptor?.enabled !== false) {
    logger.debug('[RAG] RAPTOR tree skipped — missing llmCaller, embeddingManager, or vectorStore.');
  }

  // ── 3. HyDE ────────────────────────────────────────────────────────────
  if (ragConfig.hyde?.enabled !== false && ctx.embeddingManager) {
    try {
      // Need either a direct llmCaller or enough info to create one
      const hydeLlmCaller = ctx.llmCaller;
      if (hydeLlmCaller) {
        hydeHypothesisCount = ragConfig.hyde?.hypothesisCount ?? 3;

        const hydeConfig: Partial<HydeConfig> = {
          enabled: true,
          hypothesisCount: hydeHypothesisCount,
          initialThreshold: ragConfig.hyde?.initialThreshold ?? 0.7,
          minThreshold: ragConfig.hyde?.minThreshold ?? 0.3,
          thresholdStep: ragConfig.hyde?.thresholdStep ?? 0.1,
          adaptiveThreshold: ragConfig.hyde?.adaptiveThreshold ?? true,
          maxHypothesisTokens: ragConfig.hyde?.maxHypothesisTokens,
          hypothesisSystemPrompt: ragConfig.hyde?.hypothesisSystemPrompt,
          fullAnswerGranularity: ragConfig.hyde?.fullAnswerGranularity ?? true,
        };

        const hydeRetriever = new HydeRetriever({
          config: hydeConfig,
          llmCaller: hydeLlmCaller,
          embeddingManager: ctx.embeddingManager,
        });

        deps.hydeRetriever = hydeRetriever;
        activeSources.hyde = true;
        logger.debug(
          `[RAG] HyDE wired: hypothesisCount=${hydeHypothesisCount} adaptive=${hydeConfig.adaptiveThreshold}`,
        );
      } else {
        logger.debug('[RAG] HyDE skipped — no LLM caller available.');
      }
    } catch (err) {
      logger.warn(`[RAG] Failed to create HyDE retriever: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 4. Memory Integration ──────────────────────────────────────────────
  //
  // The wunderland MemorySystem does not implement ICognitiveMemoryManager
  // directly; we bridge the gap by providing a vectorSearch fallback that
  // the UnifiedRetriever can use for the memory source. Full CMM support
  // will come when the memory module exposes the interface directly.
  if (ragConfig.memoryIntegration?.enabled !== false && ctx.memorySystem) {
    activeSources.memory = true;
    logger.debug(
      `[RAG] Memory integration wired: feedbackLoop=${ragConfig.memoryIntegration?.feedbackLoop ?? true}`,
    );
  }

  // ── 5. Wire reranker ───────────────────────────────────────────────────
  if (ctx.rerank) {
    deps.rerank = ctx.rerank;
  }

  // ── 6. Event emitter (verbose mode) ────────────────────────────────────
  if (ctx.verbose) {
    deps.emit = (event) => {
      switch (event.type) {
        case 'unified:plan-start':
          logger.log(
            `[RAG] Plan: strategy=${event.plan.strategy} sources=${countActiveSources(event.plan.sources)} ` +
            `hyde=${event.plan.hyde.enabled ? `${event.plan.hyde.hypothesisCount}x` : 'off'} ` +
            `memory=${event.plan.memoryTypes.join('+') || 'off'}`,
          );
          break;
        case 'unified:source-complete':
          logger.log(`[RAG] Source ${event.source}: ${event.chunkCount} chunks in ${event.durationMs}ms`);
          break;
        case 'unified:source-error':
          logger.warn(`[RAG] Source ${event.source} error: ${event.error}`);
          break;
        case 'unified:rerank-complete':
          logger.log(`[RAG] Reranked: ${event.inputCount} → ${event.outputCount} in ${event.durationMs}ms`);
          break;
        case 'unified:complete':
          logger.log(
            `[RAG] Retrieved: ${formatSourceDiagnostics(event.result.sourceDiagnostics)} in ${event.result.durationMs}ms`,
          );
          break;
        default:
          // Other events are too noisy for verbose; could be wired to a trace logger.
          break;
      }
    };
  }

  // ── Construct UnifiedRetriever ─────────────────────────────────────────
  //
  // Even if no optional sources are available, the UnifiedRetriever will
  // still use its vectorSearch fallback for basic retrieval. Only skip if
  // there are truly no retrieval capabilities at all.
  const hasAnySources =
    activeSources.hybrid || activeSources.raptor || activeSources.hyde || activeSources.memory;

  if (!hasAnySources && !ctx.vectorStore) {
    logger.debug('[RAG] No retrieval sources available — skipping unified retriever.');
    return nullResult;
  }

  try {
    const retriever = new UnifiedRetriever(deps);

    return {
      retriever,
      activeSources,
      bm25Index,
      raptorTree,
      hydeHypothesisCount,
    };
  } catch (err) {
    logger.warn(`[RAG] Failed to create UnifiedRetriever: ${err instanceof Error ? err.message : String(err)}`);
    return nullResult;
  }
}

// ============================================================================
// Startup log formatter
// ============================================================================

/**
 * Formats the one-line unified retrieval status log emitted at startup.
 *
 * Example output:
 * ```
 * [RAG] Unified retrieval: hybrid=on raptor=on hyde=3x semantic-chunking memory=on
 * ```
 *
 * @param result - The build result from {@link buildUnifiedRetrieverFromConfig}.
 * @returns Formatted log string.
 */
export function formatUnifiedRetrievalLog(result: UnifiedRetrieverBuildResult): string {
  const parts: string[] = [];
  parts.push(`hybrid=${result.activeSources.hybrid ? 'on' : 'off'}`);
  parts.push(`raptor=${result.activeSources.raptor ? 'on' : 'off'}`);
  parts.push(`hyde=${result.hydeHypothesisCount ? `${result.hydeHypothesisCount}x` : 'off'}`);
  if (result.activeSources.semanticChunking) {
    parts.push('semantic-chunking');
  }
  parts.push(`memory=${result.activeSources.memory ? 'on' : 'off'}`);
  return `[RAG] Unified retrieval: ${parts.join(' ')}`;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Counts the number of active retrieval sources in a plan's source flags.
 *
 * @param sources - Source flags from a RetrievalPlan.
 * @returns Number of active sources.
 */
function countActiveSources(sources: Record<string, boolean>): number {
  return Object.values(sources).filter(Boolean).length;
}

/**
 * Formats source diagnostics into a human-readable string for verbose logging.
 *
 * @param diag - Source diagnostics from a UnifiedRetrievalResult.
 * @returns Formatted diagnostics string.
 */
function formatSourceDiagnostics(diag: {
  hybrid: { chunkCount: number };
  raptor: { chunkCount: number };
  memory: { chunkCount: number };
  hyde: { chunkCount: number; hypothesisCount: number };
  rerank: { inputCount: number; outputCount: number };
}): string {
  const parts: string[] = [];
  if (diag.hybrid.chunkCount > 0) parts.push(`${diag.hybrid.chunkCount} from hybrid`);
  if (diag.raptor.chunkCount > 0) parts.push(`${diag.raptor.chunkCount} from RAPTOR`);
  if (diag.memory.chunkCount > 0) parts.push(`${diag.memory.chunkCount} from memory`);
  if (diag.hyde.chunkCount > 0) parts.push(`${diag.hyde.chunkCount} from HyDE (${diag.hyde.hypothesisCount} hypotheses)`);
  if (diag.rerank.inputCount > 0) parts.push(`reranked ${diag.rerank.inputCount}→${diag.rerank.outputCount}`);
  return parts.length > 0 ? parts.join(', ') : 'no chunks';
}

/**
 * Helper to persist the current BM25 index state to disk.
 *
 * Should be called after document ingestion or before process shutdown
 * to avoid re-tokenizing on next startup.
 *
 * @param bm25Index - The BM25 index to persist.
 * @param documents - The original documents that were indexed.
 * @param opts - Persistence options.
 * @param corpusPaths - Corpus paths for hash computation.
 */
export async function persistBM25Index(
  bm25Index: BM25Index,
  documents: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>,
  agentDir: string,
  corpusPaths: string[],
  logger?: { log: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; debug: (...args: unknown[]) => void },
): Promise<void> {
  const state: SerializedBM25State = {
    version: 1,
    k1: 1.2,
    b: 0.75,
    documents,
    corpusHash: computeCorpusHash(corpusPaths),
    savedAt: new Date().toISOString(),
  };
  await saveBM25State(state, { agentDir, logger });
}
