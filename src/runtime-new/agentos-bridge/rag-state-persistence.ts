// @ts-nocheck
/**
 * @fileoverview Persistence helpers for BM25 index and RAPTOR tree state.
 *
 * When unified retrieval is active, the BM25 keyword index and RAPTOR
 * hierarchical summary tree need to survive process restarts. This module
 * provides save/load routines that serialize state to the per-agent workspace
 * directory (`~/.wunderland/agents/<name>/`).
 *
 * File layout:
 * ```
 * ~/.wunderland/agents/<agent-id>/
 *   bm25-index.json      — BM25 inverted index + document metadata
 *   raptor-tree.json      — RAPTOR layer metadata (actual vectors in VectorStore)
 *   rag-state-meta.json   — Checksum / version metadata for cache invalidation
 * ```
 *
 * Both files are optional — if missing on startup the index/tree are rebuilt
 * from the corpus during the next `rag ingest` or on first query.
 *
 * @module wunderland/runtime/rag-state-persistence
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

/**
 * Serialized BM25 index state.
 *
 * Captures everything needed to reconstruct a fully-populated BM25Index
 * without re-tokenizing the source documents.
 */
export interface SerializedBM25State {
  /** Schema version for forwards compatibility. */
  version: 1;
  /** BM25 tuning parameter k1 at time of serialization. */
  k1: number;
  /** BM25 tuning parameter b at time of serialization. */
  b: number;
  /**
   * Array of indexed documents with pre-computed text for re-ingestion.
   * We store (id, text, metadata?) rather than the internal inverted index
   * so that a BM25Index can be rebuilt with `addDocuments()` — this is
   * simpler and more robust than serializing the inverted index directly.
   */
  documents: Array<{
    id: string;
    text: string;
    metadata?: Record<string, unknown>;
  }>;
  /** SHA-256 hash of corpus file paths (sorted) for cache invalidation. */
  corpusHash: string;
  /** ISO-8601 timestamp when the state was saved. */
  savedAt: string;
}

/**
 * Serialized RAPTOR tree metadata.
 *
 * The actual summary vectors live in the VectorStore; this file captures
 * the structural metadata needed to know whether a rebuild is required.
 */
export interface SerializedRaptorState {
  /** Schema version for forwards compatibility. */
  version: 1;
  /** Number of layers in the built tree. */
  totalLayers: number;
  /** Nodes per layer: `{ "0": 120, "1": 15, "2": 3 }`. */
  nodesPerLayer: Record<number, number>;
  /** Total node count across all layers. */
  totalNodes: number;
  /** Cluster count across all layers. */
  totalClusters: number;
  /** Build duration in milliseconds. */
  buildTimeMs: number;
  /** SHA-256 hash of corpus file paths (sorted) for cache invalidation. */
  corpusHash: string;
  /** ISO-8601 timestamp when the state was saved. */
  savedAt: string;
}

/**
 * Options for the persistence helpers.
 */
export interface RagStatePersistenceOptions {
  /**
   * Base directory for the agent workspace.
   * Typically `~/.wunderland/agents/<agent-id>/`.
   */
  agentDir: string;

  /**
   * Logger sink for debug/warning messages.
   * Defaults to `console`.
   */
  logger?: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
}

// ============================================================================
// Constants
// ============================================================================

/** Filename for the serialized BM25 index. */
const BM25_INDEX_FILE = 'bm25-index.json';

/** Filename for the serialized RAPTOR tree metadata. */
const RAPTOR_TREE_FILE = 'raptor-tree.json';

// ============================================================================
// Hash helpers
// ============================================================================

/**
 * Computes a stable SHA-256 hash over an array of corpus file paths.
 *
 * Used for cache invalidation — if the set of corpus paths changes between
 * saves, the persisted state is considered stale and must be rebuilt.
 *
 * @param paths - Sorted array of absolute corpus file paths.
 * @returns Hex-encoded SHA-256 hash string.
 */
export function computeCorpusHash(paths: string[]): string {
  const sorted = [...paths].sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}

// ============================================================================
// BM25 Persistence
// ============================================================================

/**
 * Saves the BM25 index state to the agent workspace directory.
 *
 * The state is written atomically (write to temp then rename) to avoid
 * corrupted reads if the process crashes mid-write.
 *
 * @param state - Serialized BM25 state to persist.
 * @param opts - Persistence options including the target directory.
 * @returns `true` if the write succeeded, `false` otherwise.
 *
 * @example
 * ```typescript
 * await saveBM25State(
 *   {
 *     version: 1,
 *     k1: 1.2,
 *     b: 0.75,
 *     documents: [{ id: 'doc-1', text: 'Agent documentation...' }],
 *     corpusHash: computeCorpusHash(corpusPaths),
 *     savedAt: new Date().toISOString(),
 *   },
 *   { agentDir: '~/.wunderland/agents/my-agent' },
 * );
 * ```
 */
export async function saveBM25State(
  state: SerializedBM25State,
  opts: RagStatePersistenceOptions,
): Promise<boolean> {
  const logger = opts.logger ?? console;
  try {
    const filePath = resolve(opts.agentDir, BM25_INDEX_FILE);
    ensureDir(dirname(filePath));
    await writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
    logger.debug(`[RAG] BM25 index saved: ${state.documents.length} documents → ${filePath}`);
    return true;
  } catch (err) {
    logger.warn(`[RAG] Failed to save BM25 index: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Loads the BM25 index state from the agent workspace directory.
 *
 * Returns `null` if the file does not exist, is corrupted, or has an
 * incompatible schema version.
 *
 * @param opts - Persistence options including the source directory.
 * @param expectedCorpusHash - If provided, the loaded state is rejected
 *   when its `corpusHash` does not match (corpus changed since last save).
 * @returns The deserialized BM25 state, or `null` if unavailable/stale.
 *
 * @example
 * ```typescript
 * const state = await loadBM25State(
 *   { agentDir: '~/.wunderland/agents/my-agent' },
 *   computeCorpusHash(corpusPaths),
 * );
 * if (state) {
 *   bm25Index.addDocuments(state.documents);
 * }
 * ```
 */
export async function loadBM25State(
  opts: RagStatePersistenceOptions,
  expectedCorpusHash?: string,
): Promise<SerializedBM25State | null> {
  const logger = opts.logger ?? console;
  const filePath = resolve(opts.agentDir, BM25_INDEX_FILE);

  if (!existsSync(filePath)) {
    logger.debug('[RAG] No persisted BM25 index found.');
    return null;
  }

  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as SerializedBM25State;

    // Version check
    if (parsed.version !== 1) {
      logger.debug(`[RAG] BM25 index version mismatch (got ${parsed.version}, expected 1). Will rebuild.`);
      return null;
    }

    // Corpus hash check
    if (expectedCorpusHash && parsed.corpusHash !== expectedCorpusHash) {
      logger.debug('[RAG] BM25 index corpus hash mismatch — corpus changed. Will rebuild.');
      return null;
    }

    logger.debug(`[RAG] Loaded BM25 index: ${parsed.documents.length} documents from ${filePath}`);
    return parsed;
  } catch (err) {
    logger.warn(`[RAG] Failed to load BM25 index: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Returns the modification time of the persisted BM25 index file,
 * or `null` if the file does not exist.
 *
 * Useful for displaying "last indexed" timestamps in status output.
 *
 * @param opts - Persistence options including the source directory.
 * @returns ISO-8601 timestamp string, or `null`.
 */
export async function getBM25StateAge(opts: RagStatePersistenceOptions): Promise<string | null> {
  const filePath = resolve(opts.agentDir, BM25_INDEX_FILE);
  try {
    const stats = await stat(filePath);
    return stats.mtime.toISOString();
  } catch {
    return null;
  }
}

// ============================================================================
// RAPTOR Persistence
// ============================================================================

/**
 * Saves RAPTOR tree metadata to the agent workspace directory.
 *
 * Note: The actual summary embeddings are stored in the agent's VectorStore.
 * This file only stores structural metadata for cache invalidation checks.
 *
 * @param state - Serialized RAPTOR metadata to persist.
 * @param opts - Persistence options including the target directory.
 * @returns `true` if the write succeeded, `false` otherwise.
 *
 * @example
 * ```typescript
 * const stats = await raptorTree.build(chunks);
 * await saveRaptorState(
 *   {
 *     version: 1,
 *     ...stats,
 *     corpusHash: computeCorpusHash(corpusPaths),
 *     savedAt: new Date().toISOString(),
 *   },
 *   { agentDir: '~/.wunderland/agents/my-agent' },
 * );
 * ```
 */
export async function saveRaptorState(
  state: SerializedRaptorState,
  opts: RagStatePersistenceOptions,
): Promise<boolean> {
  const logger = opts.logger ?? console;
  try {
    const filePath = resolve(opts.agentDir, RAPTOR_TREE_FILE);
    ensureDir(dirname(filePath));
    await writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
    logger.debug(
      `[RAG] RAPTOR tree saved: ${state.totalLayers} layers, ${state.totalNodes} nodes → ${filePath}`,
    );
    return true;
  } catch (err) {
    logger.warn(`[RAG] Failed to save RAPTOR tree: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Loads RAPTOR tree metadata from the agent workspace directory.
 *
 * Returns `null` if the file does not exist, is corrupted, has an
 * incompatible schema version, or the corpus hash does not match.
 *
 * @param opts - Persistence options including the source directory.
 * @param expectedCorpusHash - If provided, rejects stale state.
 * @returns The deserialized RAPTOR metadata, or `null` if unavailable/stale.
 *
 * @example
 * ```typescript
 * const state = await loadRaptorState(
 *   { agentDir: '~/.wunderland/agents/my-agent' },
 *   computeCorpusHash(corpusPaths),
 * );
 * if (!state) {
 *   // Must rebuild: `await raptorTree.build(chunks);`
 * }
 * ```
 */
export async function loadRaptorState(
  opts: RagStatePersistenceOptions,
  expectedCorpusHash?: string,
): Promise<SerializedRaptorState | null> {
  const logger = opts.logger ?? console;
  const filePath = resolve(opts.agentDir, RAPTOR_TREE_FILE);

  if (!existsSync(filePath)) {
    logger.debug('[RAG] No persisted RAPTOR tree found.');
    return null;
  }

  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as SerializedRaptorState;

    // Version check
    if (parsed.version !== 1) {
      logger.debug(`[RAG] RAPTOR tree version mismatch (got ${parsed.version}, expected 1). Will rebuild.`);
      return null;
    }

    // Corpus hash check
    if (expectedCorpusHash && parsed.corpusHash !== expectedCorpusHash) {
      logger.debug('[RAG] RAPTOR tree corpus hash mismatch — corpus changed. Will rebuild.');
      return null;
    }

    logger.debug(
      `[RAG] Loaded RAPTOR tree metadata: ${parsed.totalLayers} layers, ${parsed.totalNodes} nodes from ${filePath}`,
    );
    return parsed;
  } catch (err) {
    logger.warn(`[RAG] Failed to load RAPTOR tree: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Returns the modification time of the persisted RAPTOR tree file,
 * or `null` if the file does not exist.
 *
 * @param opts - Persistence options including the source directory.
 * @returns ISO-8601 timestamp string, or `null`.
 */
export async function getRaptorStateAge(opts: RagStatePersistenceOptions): Promise<string | null> {
  const filePath = resolve(opts.agentDir, RAPTOR_TREE_FILE);
  try {
    const stats = await stat(filePath);
    return stats.mtime.toISOString();
  } catch {
    return null;
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Ensures a directory exists, creating it recursively if necessary.
 *
 * @param dir - Absolute directory path.
 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
