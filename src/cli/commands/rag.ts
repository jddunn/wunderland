// @ts-nocheck
/**
 * @fileoverview `wunderland rag` -- RAG memory management (ingest, query, collections, media, graph).
 *
 * Provides subcommands for document ingestion (text, image, audio, PDF),
 * retrieval queries (vector, hybrid, HyDE, RAPTOR, graph), collection
 * management, GraphRAG exploration, audit trail, and the unified retrieval
 * status/plan inspection commands.
 *
 * @module wunderland/cli/commands/rag
 */

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, dim, bright, success as sColor, error as eColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { getUiRuntime } from '../ui/runtime.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { normalizeRagApiBaseUrl } from '../../memory-new/rag/rag-client.js';
import {
  heuristicClassify,
} from '@framers/agentos/query-router';
import type {
  RetrievalStrategy,
} from '@framers/agentos/query-router';
import {
  buildDefaultPlan,
} from '@framers/agentos/rag';
import type {
  RetrievalPlan,
} from '@framers/agentos/rag';

function getRagBaseUrl(): string {
  const base = process.env.WUNDERLAND_BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  return normalizeRagApiBaseUrl(base);
}

function arrow(): string {
  return getUiRuntime().ascii ? '->' : '→';
}

function guessMediaMimeType(filePath: string, fallback: string): string {
  const lower = filePath.trim().toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a')) return 'audio/x-m4a';
  if (lower.endsWith('.mp4')) return 'audio/mp4';
  if (lower.endsWith('.webm')) return fallback.startsWith('audio/') ? 'audio/webm' : 'video/webm';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.xml')) return 'application/xml';
  return fallback;
}

async function ragFetch(urlPath: string, options?: { method?: string; body?: unknown }): Promise<any> {
  const base = getRagBaseUrl();
  const method = options?.method ?? 'GET';
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${urlPath} ${arrow()} ${res.status}: ${text}`);
  }
  return res.json();
}

async function ragMultipartFetch(urlPath: string, formData: FormData): Promise<any> {
  const base = getRagBaseUrl();
  const res = await fetch(`${base}${urlPath}`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${urlPath} ${arrow()} ${res.status}: ${text}`);
  }
  return res.json();
}

function appendMediaQueryFlags(formData: FormData, flags: Record<string, string | boolean>): void {
  const modality = typeof flags['modality'] === 'string' ? flags['modality'] : undefined;
  const collection = typeof flags['collection'] === 'string' ? flags['collection'] : undefined;
  const topK = typeof flags['top-k'] === 'string' ? flags['top-k'] : undefined;
  const textRepresentation = typeof flags['text'] === 'string' ? flags['text'] : undefined;
  const retrievalMode =
    typeof flags['retrieval-mode'] === 'string' ? flags['retrieval-mode'] : undefined;

  if (modality) formData.append('modalities', modality);
  if (collection) formData.append('collectionIds', collection);
  if (topK) formData.append('topK', topK);
  if (flags['include-metadata'] === true) formData.append('includeMetadata', 'true');
  if (textRepresentation) formData.append('textRepresentation', textRepresentation);
  if (retrievalMode) formData.append('retrievalMode', retrievalMode);
}

function renderMediaQueryResult(title: string, result: any, format: string): void {
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  fmt.section(title);
  if (result.retrieval) {
    fmt.kvPair(
      'Retrieval',
      `${result.retrieval.resolvedMode} (requested ${result.retrieval.requestedMode})`
    );
    if (result.retrieval.fallbackReason) {
      fmt.kvPair('Fallback', result.retrieval.fallbackReason);
    }
  }
  if (!result.assets?.length) {
    fmt.note('No media assets found.');
    return;
  }

  for (const item of result.assets) {
    const score =
      typeof item.bestChunk?.score === 'number' ? ` (${(item.bestChunk.score * 100).toFixed(1)}%)` : '';
    fmt.kvPair(
      `[${item.asset.modality}] ${item.asset.assetId}${score}`,
      item.bestChunk?.content?.slice(0, 150) ?? ''
    );
  }
  fmt.blank();
}

// -- Sub-commands -----------------------------------------------------------

async function cmdIngestImage(args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    fmt.errorBlock('Missing argument', 'Usage: wunderland rag ingest-image <file>');
    process.exitCode = 1;
    return;
  }
  const data = await readFile(filePath);
  const formData = new FormData();
  formData.append(
    'image',
    new Blob([data], { type: guessMediaMimeType(filePath, 'image/*') }),
    path.basename(filePath)
  );

  const result = (await ragMultipartFetch('/multimodal/images/ingest', formData)) as any;
  fmt.ok(`Image ingested ${arrow()} asset ${dim(result.assetId)} (${result.chunksCreated} chunks)`);
}

async function cmdIngestAudio(args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    fmt.errorBlock('Missing argument', 'Usage: wunderland rag ingest-audio <file>');
    process.exitCode = 1;
    return;
  }
  const data = await readFile(filePath);
  const formData = new FormData();
  formData.append(
    'audio',
    new Blob([data], { type: guessMediaMimeType(filePath, 'audio/*') }),
    path.basename(filePath)
  );

  const result = (await ragMultipartFetch('/multimodal/audio/ingest', formData)) as any;
  fmt.ok(`Audio ingested ${arrow()} asset ${dim(result.assetId)} (${result.chunksCreated} chunks)`);
}

async function cmdIngestDocument(args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    fmt.errorBlock('Missing argument', 'Usage: wunderland rag ingest-document <file>');
    process.exitCode = 1;
    return;
  }
  const data = await readFile(filePath);
  const formData = new FormData();
  formData.append(
    'document',
    new Blob([data], { type: guessMediaMimeType(filePath, 'application/octet-stream') }),
    path.basename(filePath)
  );

  const result = (await ragMultipartFetch('/multimodal/documents/ingest', formData)) as any;
  fmt.ok(`Document ingested ${arrow()} asset ${dim(result.assetId)} (${result.chunksCreated} chunks)`);
}

async function cmdQueryMedia(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const query = args.join(' ');
  if (!query) {
    fmt.errorBlock('Missing argument', 'Usage: wunderland rag query-media <text>');
    process.exitCode = 1;
    return;
  }
  const modality = typeof flags['modality'] === 'string' ? [flags['modality']] : undefined;
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  const result = await ragFetch('/multimodal/query', { method: 'POST', body: { query, modalities: modality } });
  renderMediaQueryResult(`Media Query: "${query}"`, result, format);
}

async function cmdQueryImage(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    fmt.errorBlock('Missing argument', 'Usage: wunderland rag query-image <file>');
    process.exitCode = 1;
    return;
  }

  const data = await readFile(filePath);
  const formData = new FormData();
  formData.append(
    'image',
    new Blob([data], { type: guessMediaMimeType(filePath, 'image/*') }),
    path.basename(filePath)
  );
  appendMediaQueryFlags(formData, flags);

  const sourceUrl = typeof flags['source-url'] === 'string' ? flags['source-url'] : undefined;
  if (sourceUrl) formData.append('sourceUrl', sourceUrl);

  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';
  const result = await ragMultipartFetch('/multimodal/images/query', formData);
  renderMediaQueryResult(`Image Query: ${path.basename(filePath)}`, result, format);
}

async function cmdQueryAudio(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    fmt.errorBlock('Missing argument', 'Usage: wunderland rag query-audio <file>');
    process.exitCode = 1;
    return;
  }

  const data = await readFile(filePath);
  const formData = new FormData();
  formData.append(
    'audio',
    new Blob([data], { type: guessMediaMimeType(filePath, 'audio/*') }),
    path.basename(filePath)
  );
  appendMediaQueryFlags(formData, flags);

  const userId = typeof flags['user-id'] === 'string' ? flags['user-id'] : undefined;
  if (userId) formData.append('userId', userId);

  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';
  const result = await ragMultipartFetch('/multimodal/audio/query', formData);
  renderMediaQueryResult(`Audio Query: ${path.basename(filePath)}`, result, format);
}

async function cmdCollections(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = args[0] ?? 'list';
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  if (sub === 'list') {
    const result = await ragFetch('/collections');
    if (format === 'json') { console.log(JSON.stringify(result, null, 2)); return; }
    fmt.section('RAG Collections');
    if (!result.collections?.length) { fmt.note('No collections.'); return; }
    for (const c of result.collections) {
      const name = c.displayName ? ` - ${c.displayName}` : '';
      fmt.kvPair(c.collectionId, `${c.documentCount} docs, ${c.chunkCount} chunks${name}`);
    }
    fmt.blank();
  } else if (sub === 'create') {
    const id = args[1];
    if (!id) { fmt.errorBlock('Missing ID', 'Usage: wunderland rag collections create <id> [display-name]'); process.exitCode = 1; return; }
    const displayName = args.slice(2).join(' ') || undefined;
    const result = await ragFetch('/collections', { method: 'POST', body: { collectionId: id, displayName } });
    fmt.ok(`Collection created: ${dim(result.collectionId)}`);
  } else if (sub === 'delete') {
    const id = args[1];
    if (!id) { fmt.errorBlock('Missing ID', 'Usage: wunderland rag collections delete <id>'); process.exitCode = 1; return; }
    await ragFetch(`/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
    fmt.ok(`Collection deleted: ${dim(id)}`);
  } else {
    fmt.errorBlock('Unknown subcommand', `"${sub}". Use: list, create, delete`);
    process.exitCode = 1;
  }
}

async function cmdDocuments(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = args[0] ?? 'list';
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  if (sub === 'list') {
    const collectionId = typeof flags['collection'] === 'string' ? flags['collection'] : undefined;
    const params = new URLSearchParams();
    if (collectionId) params.set('collectionId', collectionId);
    const result = await ragFetch(`/documents?${params.toString()}`);
    if (format === 'json') { console.log(JSON.stringify(result, null, 2)); return; }
    fmt.section('RAG Documents');
    if (!result.documents?.length) { fmt.note('No documents.'); return; }
    for (const d of result.documents) {
      fmt.kvPair(d.documentId, `[${d.category}] collection=${d.collectionId}`);
    }
    fmt.blank();
  } else if (sub === 'delete') {
    const id = args[1];
    if (!id) { fmt.errorBlock('Missing ID', 'Usage: wunderland rag documents delete <id>'); process.exitCode = 1; return; }
    await ragFetch(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    fmt.ok(`Document deleted: ${dim(id)}`);
  } else {
    fmt.errorBlock('Unknown subcommand', `"${sub}". Use: list, delete`);
    process.exitCode = 1;
  }
}

async function cmdStats(flags: Record<string, string | boolean>): Promise<void> {
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';
  const result = await ragFetch('/stats');
  if (format === 'json') { console.log(JSON.stringify(result, null, 2)); return; }
  fmt.section('RAG Statistics');
  fmt.kvPair('Storage', result.storageAdapter ?? 'unknown');
  fmt.kvPair('Documents', String(result.totalDocuments ?? 0));
  fmt.kvPair('Chunks', String(result.totalChunks ?? 0));
  fmt.kvPair('Collections', String(result.collections?.length ?? result.totalCollections ?? 0));
  if (result.collections?.length) {
    for (const c of result.collections) {
      fmt.kvPair(`  ${c.collectionId}`, `${c.documentCount} docs, ${c.chunkCount} chunks`);
    }
  }
  fmt.blank();
}

async function cmdHealth(): Promise<void> {
  try {
    const result = await ragFetch('/health');
    fmt.section('RAG Health');
    const ready = result.status === 'ready' || result.available;
    fmt.kvPair('Status', ready ? sColor(result.status ?? 'ready') : eColor(result.status ?? 'unavailable'));
    fmt.kvPair('Adapter', result.storageAdapter ?? result.adapterKind ?? 'unknown');
    fmt.kvPair('Vector Provider', result.vectorProvider ?? 'sql');
    if (result.hnswParams) {
      fmt.kvPair('  HNSW M', String(result.hnswParams.M));
      fmt.kvPair('  HNSW efConstruction', String(result.hnswParams.efConstruction));
      fmt.kvPair('  HNSW efSearch', String(result.hnswParams.efSearch));
      fmt.kvPair('  HNSW Persist Dir', result.hnswParams.persistDir);
    }
    fmt.kvPair('Vector Store', result.vectorStoreConnected ? sColor('connected') : eColor('disconnected'));
    fmt.kvPair('Embeddings', result.embeddingServiceAvailable ? sColor('available') : eColor('unavailable'));
    fmt.kvPair('GraphRAG', result.graphRagEnabled ? sColor('enabled') : dim('disabled'));
    if (result.stats) {
      fmt.kvPair('Documents', String(result.stats.totalDocuments ?? 0));
      fmt.kvPair('Chunks', String(result.stats.totalChunks ?? 0));
      fmt.kvPair('Collections', String(result.stats.collectionCount ?? 0));
    }
    fmt.blank();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const backendUrl = getRagBaseUrl();
    let hint = '';
    if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
      hint = `\n\nBackend not running at ${backendUrl}.\nStart it with: cd backend && npx tsx src/main.ts`;
    }
    fmt.errorBlock('RAG Unavailable', message + hint);
    process.exitCode = 1;
  }
}

async function cmdGraph(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = args[0];
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  if (sub === 'local-search') {
    const query = args.slice(1).join(' ');
    if (!query) { fmt.errorBlock('Missing query', 'Usage: wunderland rag graph local-search <text>'); process.exitCode = 1; return; }
    const result = await ragFetch('/graphrag/local-search', { method: 'POST', body: { query } });
    if (format === 'json') { console.log(JSON.stringify(result, null, 2)); return; }
    const r = result.result ?? result;
    fmt.section(`GraphRAG Local Search: "${query}"`);
    if (r.entities?.length) {
      fmt.kvPair('Entities Found', String(r.entities.length));
      for (const e of r.entities.slice(0, 8)) {
        fmt.kvPair(`  ${e.name}`, `(${e.type}) ${e.description?.slice(0, 120) ?? ''}`);
      }
      if (r.entities.length > 8) fmt.note(`  ... and ${r.entities.length - 8} more entities`);
    }
    if (r.relationships?.length) {
      fmt.kvPair('Relationships', String(r.relationships.length));
    }
    if (r.communityContext?.length) {
      fmt.kvPair('Communities', String(r.communityContext.length));
      for (const c of r.communityContext.slice(0, 3)) {
        fmt.kvPair(`  ${c.communityId?.slice(0, 16) ?? '?'}`, c.title?.slice(0, 120) ?? '');
      }
    }
    if (r.diagnostics) {
      fmt.note(`Search: ${r.diagnostics.searchTimeMs}ms, traversal: ${r.diagnostics.graphTraversalTimeMs ?? 0}ms`);
    }
    fmt.blank();
  } else if (sub === 'global-search') {
    const query = args.slice(1).join(' ');
    if (!query) { fmt.errorBlock('Missing query', 'Usage: wunderland rag graph global-search <text>'); process.exitCode = 1; return; }
    const result = await ragFetch('/graphrag/global-search', { method: 'POST', body: { query } });
    if (format === 'json') { console.log(JSON.stringify(result, null, 2)); return; }
    const r = result.result ?? result;
    fmt.section(`GraphRAG Global Search: "${query}"`);
    fmt.kvPair('Communities Searched', String(r.totalCommunitiesSearched ?? 0));
    if (r.answer) {
      fmt.kvPair('Answer', r.answer.slice(0, 500));
    }
    if (r.communitySummaries?.length) {
      for (const cs of r.communitySummaries.slice(0, 5)) {
        fmt.kvPair(`  ${cs.communityId?.slice(0, 16) ?? '?'}`, cs.title?.slice(0, 120) ?? cs.summary?.slice(0, 120) ?? '');
      }
    }
    if (!r.answer && !r.communitySummaries?.length) {
      fmt.note('No global summary available. Enable AGENTOS_GRAPHRAG_LLM_ENABLED=true for LLM-powered community summaries.');
    }
    if (r.diagnostics) {
      fmt.note(`Search: ${r.diagnostics.searchTimeMs}ms`);
    }
    fmt.blank();
  } else if (sub === 'stats') {
    const result = await ragFetch('/graphrag/stats');
    if (format === 'json') { console.log(JSON.stringify(result, null, 2)); return; }
    const stats = result.stats ?? result;
    fmt.section('GraphRAG Statistics');
    fmt.kvPair('Entities', String(stats.totalEntities ?? 0));
    fmt.kvPair('Relationships', String(stats.totalRelationships ?? 0));
    fmt.kvPair('Communities', String(stats.totalCommunities ?? 0));
    fmt.kvPair('Community Levels', String(stats.communityLevels ?? 0));
    fmt.kvPair('Documents Indexed', String(stats.documentsIngested ?? 0));
    fmt.blank();
  } else {
    fmt.errorBlock('Unknown subcommand', `"${sub ?? '(none)'}". Use: local-search, global-search, stats`);
    process.exitCode = 1;
  }
}

async function cmdAudit(_args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const seedId = typeof flags['seed-id'] === 'string' ? flags['seed-id'] : undefined;
  const limit = typeof flags['limit'] === 'string' ? parseInt(flags['limit'], 10) : 20;
  const since = typeof flags['since'] === 'string' ? flags['since'] : undefined;
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';
  const verbose = flags['verbose'] === true || flags['v'] === true;

  const params = new URLSearchParams();
  if (seedId) params.set('seedId', seedId);
  params.set('limit', String(limit));
  if (since) params.set('since', since);

  const result = await ragFetch(`/audit?${params.toString()}`);

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  fmt.section('RAG Audit Trail');
  if (!result.trails?.length) {
    fmt.note('No audit entries found.');
    return;
  }

  for (const trail of result.trails) {
    // Trail header
    const queryPreview = trail.query.length > 60 ? trail.query.slice(0, 57) + '...' : trail.query;
    fmt.kvPair(
      accent(`[${trail.trailId.slice(0, 12)}]`),
      `"${queryPreview}" @ ${trail.timestamp}`,
    );

    // Summary line
    fmt.kvPair('  Summary', [
      `${trail.summary.totalOperations} ops`,
      `${trail.summary.totalLLMCalls} LLM calls`,
      `${trail.summary.totalTokens} tokens`,
      `$${trail.summary.totalCostUSD.toFixed(4)}`,
      `${trail.summary.totalDurationMs}ms`,
    ].join(' | '));

    fmt.kvPair('  Methods', trail.summary.operationTypes.join(', '));
    fmt.kvPair('  Sources', `${trail.summary.sourceSummary.uniqueDocuments} docs, ${trail.summary.sourceSummary.uniqueDataSources} data sources`);

    // Per-operation breakdown (when --verbose)
    if (verbose) {
      for (const op of trail.operations) {
        const typeLabel = op.operationType.padEnd(14);
        const tokLabel = `${op.tokenUsage.totalTokens} tok`;
        const costLabel = `$${op.costUSD.toFixed(4)}`;
        const durLabel = `${op.durationMs}ms`;
        const srcLabel = `${op.sources.length} src`;
        fmt.kvPair(`    ${typeLabel}`, `${durLabel} | ${tokLabel} | ${costLabel} | ${srcLabel}`);

        if (op.retrievalMethod) {
          fmt.kvPair('      method', `${op.retrievalMethod.strategy}${op.retrievalMethod.topK ? ` (topK=${op.retrievalMethod.topK})` : ''}`);
        }
        if (op.graphDetails) {
          fmt.kvPair('      graph', `${op.graphDetails.entitiesMatched} entities, ${op.graphDetails.communitiesSearched} communities, ${op.graphDetails.traversalTimeMs}ms traversal`);
        }
        if (op.rerankDetails) {
          fmt.kvPair('      rerank', `${op.rerankDetails.providerId}/${op.rerankDetails.modelId} (${op.rerankDetails.documentsReranked} docs)`);
        }

        // Show source snippets
        for (const src of op.sources.slice(0, 3)) {
          const snippet = src.contentSnippet.slice(0, 80).replace(/\n/g, ' ');
          fmt.kvPair(`      [${(src.relevanceScore * 100).toFixed(0)}%]`, `${dim(src.documentId.slice(0, 16))} "${snippet}..."`);
        }
        if (op.sources.length > 3) {
          fmt.note(`      ... and ${op.sources.length - 3} more source(s)`);
        }
      }
    }

    fmt.blank();
  }
}

// -- Unified retrieval subcommands ------------------------------------------

/**
 * Valid strategy names for the `--strategy` flag.
 * `'auto'` means the heuristic classifier decides.
 */
const VALID_STRATEGIES = new Set<string>(['none', 'simple', 'moderate', 'complex', 'auto']);

/**
 * Resolves a `--strategy` flag value into either a forced {@link RetrievalStrategy}
 * or `undefined` for auto-detection via the heuristic classifier.
 *
 * @param raw - The raw `--strategy` flag value.
 * @returns The resolved strategy, or `undefined` for auto.
 */
function resolveStrategy(raw: string | boolean | undefined): RetrievalStrategy | undefined {
  if (raw === undefined || raw === true || raw === 'auto') return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (!VALID_STRATEGIES.has(normalized) || normalized === 'auto') return undefined;
  return normalized as RetrievalStrategy;
}

/**
 * Renders a human-friendly check/cross glyph for a boolean value.
 *
 * @param enabled - Whether the feature is enabled.
 * @returns A coloured tick or cross.
 */
function boolGlyph(enabled: boolean): string {
  return enabled ? sColor('Y') : dim('N');
}

/**
 * `wunderland rag status` — display unified retrieval system status.
 *
 * Shows the current state of all retrieval sources (vector, BM25, RAPTOR,
 * GraphRAG, HyDE, reranker, memory) by querying the RAG health endpoint
 * and supplementing with local configuration data.
 */
async function cmdStatus(flags: Record<string, string | boolean>): Promise<void> {
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  // Fetch health info from the RAG backend
  let health: any = null;
  try {
    health = await ragFetch('/health');
  } catch {
    // Backend may be offline — show what we can from local state
  }

  // Fetch stats for document counts
  let stats: any = null;
  try {
    stats = await ragFetch('/stats');
  } catch {
    // Non-fatal
  }

  // Fetch GraphRAG stats if available
  let graphStats: any = null;
  try {
    graphStats = await ragFetch('/graphrag/stats');
  } catch {
    // Non-fatal — GraphRAG may not be enabled
  }

  if (format === 'json') {
    console.log(JSON.stringify({ health, stats, graphStats }, null, 2));
    return;
  }

  fmt.section('Unified Retrieval System Status');
  fmt.blank();

  // Vector store
  const vectorReady = health?.vectorStoreConnected ?? false;
  const totalDocs = stats?.totalDocuments ?? health?.stats?.totalDocuments ?? 0;
  const totalChunks = stats?.totalChunks ?? health?.stats?.totalChunks ?? 0;
  const vectorProvider = health?.vectorProvider ?? health?.adapterKind ?? 'unknown';
  fmt.kvPair(
    'Vector Store',
    vectorReady
      ? `${sColor(vectorProvider)} (${totalDocs.toLocaleString()} documents, ${totalChunks.toLocaleString()} chunks)`
      : eColor('disconnected'),
  );

  // BM25 index
  const bm25Enabled = health?.bm25Enabled ?? false;
  fmt.kvPair(
    'BM25 Index',
    bm25Enabled
      ? `${sColor('enabled')} (${totalChunks.toLocaleString()} documents)`
      : dim('disabled'),
  );

  // RAPTOR tree
  const raptorEnabled = health?.raptorEnabled ?? false;
  if (raptorEnabled && health?.raptorStats) {
    const rs = health.raptorStats;
    fmt.kvPair(
      'RAPTOR Tree',
      `${rs.layerCount ?? 0} layers (leaf: ${rs.leafCount ?? 0}, L1: ${rs.l1Count ?? 0}, L2: ${rs.l2Count ?? 0})`,
    );
  } else {
    fmt.kvPair('RAPTOR Tree', raptorEnabled ? sColor('enabled') : dim('disabled'));
  }

  // GraphRAG
  const graphEnabled = health?.graphRagEnabled ?? false;
  if (graphEnabled && graphStats) {
    const gs = graphStats.stats ?? graphStats;
    fmt.kvPair(
      'GraphRAG',
      `${gs.totalEntities ?? 0} entities, ${gs.totalRelationships ?? 0} relationships`,
    );
  } else {
    fmt.kvPair('GraphRAG', graphEnabled ? sColor('enabled') : dim('disabled'));
  }

  // HyDE
  const hydeEnabled = health?.hydeEnabled ?? true;
  fmt.kvPair(
    'HyDE',
    hydeEnabled ? sColor('enabled') : dim('disabled'),
  );

  // Reranker
  const rerankMode = health?.rerankMode ?? 'lexical';
  fmt.kvPair('Reranker', rerankMode);

  // Embeddings
  const embeddingsAvailable = health?.embeddingServiceAvailable ?? false;
  fmt.kvPair(
    'Embeddings',
    embeddingsAvailable ? sColor('available') : eColor('unavailable'),
  );

  // Memory connection
  const memoryConnected = health?.memoryConnected ?? false;
  if (memoryConnected && health?.memoryStats) {
    const ms = health.memoryStats;
    fmt.kvPair(
      'Memory',
      `connected (episodic: ${ms.episodic ?? 0}, semantic: ${ms.semantic ?? 0})`,
    );
  } else {
    fmt.kvPair('Memory', memoryConnected ? sColor('connected') : dim('not connected'));
  }

  fmt.blank();
}

/**
 * `wunderland rag plan "<query>"` — preview what the classifier would do.
 *
 * Runs the heuristic classifier against the supplied query and displays the
 * resulting {@link RetrievalPlan} without executing any retrieval. Useful for
 * debugging strategy selection and understanding which sources would be queried.
 *
 * @param args - Positional arguments (the query text).
 * @param flags - CLI flags (--strategy, --json).
 */
async function cmdPlan(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const query = args.join(' ');
  if (!query) {
    fmt.errorBlock('Missing argument', 'Usage: wunderland rag plan "<query text>"');
    process.exitCode = 1;
    return;
  }

  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';
  const forcedStrategy = resolveStrategy(flags['strategy'] as string | undefined);

  // Determine strategy — use forced value or run heuristic classifier
  const strategy: RetrievalStrategy = forcedStrategy ?? heuristicClassify(query);
  const plan: RetrievalPlan = buildDefaultPlan(strategy);

  if (format === 'json') {
    console.log(JSON.stringify({ query, plan }, null, 2));
    return;
  }

  fmt.section(`Retrieval Plan: "${query.length > 60 ? query.slice(0, 57) + '...' : query}"`);
  fmt.blank();

  fmt.kvPair('Strategy', bright(plan.strategy));
  fmt.kvPair('Confidence', `${(plan.confidence * 100).toFixed(0)}%`);
  fmt.kvPair('Reasoning', plan.reasoning);
  fmt.blank();

  // Sources grid
  fmt.kvPair('Sources', [
    `vector ${boolGlyph(plan.sources.vector)}`,
    `bm25 ${boolGlyph(plan.sources.bm25)}`,
    `graph ${boolGlyph(plan.sources.graph)}`,
    `raptor ${boolGlyph(plan.sources.raptor)}`,
    `memory ${boolGlyph(plan.sources.memory)}`,
    `multimodal ${boolGlyph(plan.sources.multimodal)}`,
  ].join('  '));

  // HyDE
  if (plan.hyde.enabled) {
    fmt.kvPair('HyDE', `${plan.hyde.hypothesisCount} hypothesis(es)`);
  } else {
    fmt.kvPair('HyDE', dim('disabled'));
  }

  // Deep Research
  fmt.kvPair('Deep Research', plan.deepResearch ? sColor('enabled') : dim('disabled'));

  // Memory types
  if (plan.memoryTypes.length > 0) {
    fmt.kvPair('Memory Types', plan.memoryTypes.join(', '));
  }

  // RAPTOR layers
  if (plan.raptorLayers.length > 0) {
    fmt.kvPair('RAPTOR Layers', plan.raptorLayers.join(', '));
  }

  // Graph config
  if (plan.sources.graph) {
    fmt.kvPair('Graph Traversal', `depth=${plan.graphConfig.maxDepth} minWeight=${plan.graphConfig.minEdgeWeight}`);
  }

  // Temporal
  if (plan.temporal.preferRecent) {
    fmt.kvPair('Temporal', `recencyBoost=${plan.temporal.recencyBoost}x${plan.temporal.maxAgeMs ? ` maxAge=${plan.temporal.maxAgeMs}ms` : ''}`);
  }

  fmt.blank();
}

/**
 * Enhanced `wunderland rag query` — supports unified retrieval strategy
 * selection, hybrid search, and plan-based retrieval.
 *
 * This wraps the existing query command but adds `--strategy`, `--hyde`,
 * `--hyde-count`, `--bm25`, `--raptor`, `--memory`, `--memory-types`,
 * and `--deep-research` flags. When these are supplied, the query builds
 * a {@link RetrievalPlan} and sends it alongside the standard query.
 *
 * @param args - Positional arguments (the query text).
 * @param flags - CLI flags for retrieval configuration.
 */
async function cmdQueryUnified(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const query = args.join(' ');
  if (!query) {
    fmt.errorBlock('Missing argument', 'Usage: wunderland rag query <text>');
    process.exitCode = 1;
    return;
  }

  const topK = typeof flags['top-k'] === 'string' ? parseInt(flags['top-k'], 10) : 5;
  const preset = typeof flags['preset'] === 'string' ? flags['preset'] : undefined;
  const collectionId = typeof flags['collection'] === 'string' ? flags['collection'] : undefined;
  const collectionIds = collectionId ? [collectionId] : undefined;
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  const verbose = flags['verbose'] === true || flags['v'] === true;
  const includeGraphRag = flags['graph'] === true;
  const debug = flags['debug'] === true;

  // ── Unified retrieval flags ──
  const hasUnifiedFlags = (
    flags['strategy'] !== undefined ||
    flags['hyde'] === true ||
    flags['hyde-count'] !== undefined ||
    flags['bm25'] === true ||
    flags['raptor'] === true ||
    flags['memory'] === true ||
    flags['memory-types'] !== undefined ||
    flags['deep-research'] === true
  );

  // Build a RetrievalPlan when unified flags are present
  let plan: RetrievalPlan | undefined;
  if (hasUnifiedFlags) {
    const forcedStrategy = resolveStrategy(flags['strategy'] as string | undefined);
    const strategy: RetrievalStrategy = forcedStrategy ?? heuristicClassify(query);
    const basePlan = buildDefaultPlan(strategy);

    // Apply flag overrides
    if (flags['hyde'] === true) {
      basePlan.hyde.enabled = true;
    }
    if (typeof flags['hyde-count'] === 'string') {
      basePlan.hyde.enabled = true;
      basePlan.hyde.hypothesisCount = parseInt(flags['hyde-count'], 10) || 3;
    }
    if (flags['bm25'] === true) {
      basePlan.sources.bm25 = true;
    }
    if (flags['graph'] === true || includeGraphRag) {
      basePlan.sources.graph = true;
    }
    if (flags['raptor'] === true) {
      basePlan.sources.raptor = true;
    }
    if (flags['memory'] === true) {
      basePlan.sources.memory = true;
    }
    if (typeof flags['memory-types'] === 'string') {
      basePlan.sources.memory = true;
      basePlan.memoryTypes = flags['memory-types']
        .split(',')
        .map((t) => t.trim())
        .filter((t) => ['episodic', 'semantic', 'procedural', 'prospective'].includes(t)) as any[];
    }
    if (flags['deep-research'] === true) {
      basePlan.deepResearch = true;
    }

    plan = basePlan;
  }

  // Build the request body
  const body: Record<string, unknown> = {
    query,
    topK,
    preset,
    collectionIds,
    includeAudit: verbose,
    includeGraphRag: includeGraphRag || plan?.sources.graph,
    debug,
  };

  // Attach the plan when unified flags were used
  if (plan) {
    body.retrievalPlan = plan;
  }

  const result = await ragFetch('/query', { method: 'POST', body });

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Show strategy info when unified flags were used
  if (plan && verbose) {
    fmt.section('Retrieval Plan');
    fmt.kvPair('Strategy', plan.strategy);
    fmt.kvPair('Sources', [
      plan.sources.vector ? 'vector' : null,
      plan.sources.bm25 ? 'bm25' : null,
      plan.sources.graph ? 'graph' : null,
      plan.sources.raptor ? 'raptor' : null,
      plan.sources.memory ? 'memory' : null,
    ].filter(Boolean).join(' + '));
    if (plan.hyde.enabled) {
      fmt.kvPair('HyDE', `${plan.hyde.hypothesisCount} hypothesis(es)`);
    }
    if (plan.deepResearch) {
      fmt.kvPair('Deep Research', sColor('enabled'));
    }
    fmt.blank();
  }

  fmt.section(`RAG Query: "${query}"`);
  if (!result.chunks?.length) {
    fmt.note('No results found.');
    return;
  }
  for (const chunk of result.chunks) {
    const score = typeof chunk.score === 'number' ? ` (${(chunk.score * 100).toFixed(1)}%)` : '';
    fmt.kvPair(`[${chunk.chunkId}]${score}`, chunk.content.slice(0, 200) + (chunk.content.length > 200 ? '...' : ''));
  }
  fmt.blank();
  fmt.note(`${result.totalResults} result(s) in ${result.processingTimeMs}ms`);

  // Show GraphRAG context when --graph
  if (result.graphContext) {
    const gc = result.graphContext;
    fmt.blank();
    fmt.section('GraphRAG Context');
    const cleanName = (s: string) => s.replace(/[\n\r]+/g, ' ').trim().slice(0, 40);
    if (gc.entities?.length) {
      fmt.kvPair('Entities', String(gc.entities.length));
      for (const e of gc.entities.slice(0, 8)) {
        const score = typeof e.relevanceScore === 'number' ? ` ${(e.relevanceScore * 100).toFixed(0)}%` : '';
        const desc = e.description?.replace(/[\n\r]+/g, ' ').trim().slice(0, 80) ?? '';
        fmt.kvPair(`  ${cleanName(e.name)}`, `(${e.type})${score} ${desc}`);
      }
      if (gc.entities.length > 8) fmt.note(`  ... and ${gc.entities.length - 8} more entities`);
    }
    if (gc.relationships?.length) {
      fmt.kvPair('Relationships', String(gc.relationships.length));
      for (const r of gc.relationships.slice(0, 6)) {
        const desc = r.description?.replace(/[\n\r]+/g, ' ').trim().slice(0, 80) ?? '';
        fmt.kvPair(`  ${cleanName(r.source)} ${arrow()} ${cleanName(r.target)}`, `[${r.type}] ${desc}`);
      }
      if (gc.relationships.length > 6) fmt.note(`  ... and ${gc.relationships.length - 6} more relationships`);
    }
    if (gc.communityContext) {
      const ctx = typeof gc.communityContext === 'string'
        ? gc.communityContext
        : Array.isArray(gc.communityContext)
          ? (gc.communityContext as any[]).map((c: any) => c.title ?? c.summary ?? JSON.stringify(c).slice(0, 80)).join('; ')
          : JSON.stringify(gc.communityContext);
      fmt.kvPair('Community Context', ctx.slice(0, 300) + (ctx.length > 300 ? '...' : ''));
    }
  }

  // Show debug pipeline trace when --debug
  if (result.debugTrace?.length) {
    fmt.blank();
    fmt.section('Debug Pipeline Trace');
    for (const step of result.debugTrace) {
      const dataEntries = Object.entries(step.data)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(', ');
      fmt.kvPair(`  [+${step.ms}ms] ${step.step}`, dataEntries);
    }
  }

  // Show audit trail when --verbose
  if (verbose && result.auditTrail) {
    const trail = result.auditTrail;
    fmt.blank();
    fmt.section('Audit Trail');
    fmt.kvPair('Trail ID', trail.trailId);
    fmt.kvPair('Summary', [
      `${trail.summary.totalOperations} ops`,
      `${trail.summary.totalLLMCalls} LLM calls`,
      `${trail.summary.totalTokens} tokens`,
      `$${trail.summary.totalCostUSD.toFixed(4)}`,
      `${trail.summary.totalDurationMs}ms`,
    ].join(' | '));
    fmt.kvPair('Methods', trail.summary.operationTypes.join(', '));
    fmt.kvPair('Sources', `${trail.summary.sourceSummary.uniqueDocuments} docs, ${trail.summary.sourceSummary.uniqueDataSources} data sources`);

    for (const op of trail.operations) {
      const typeLabel = op.operationType.padEnd(14);
      const tokLabel = `${op.tokenUsage.totalTokens} tok`;
      const costLabel = `$${op.costUSD.toFixed(4)}`;
      const durLabel = `${op.durationMs}ms`;
      const srcLabel = `${op.sources.length} src`;
      fmt.kvPair(`  ${typeLabel}`, `${durLabel} | ${tokLabel} | ${costLabel} | ${srcLabel}`);
    }
  }
}

/**
 * Enhanced `wunderland rag ingest` — supports semantic chunking, RAPTOR tree
 * building, BM25 index building, and GraphRAG entity extraction.
 *
 * @param args - Positional arguments (file path or inline text).
 * @param flags - CLI flags for ingestion configuration.
 */
async function cmdIngestUnified(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const target = args[0];
  if (!target) {
    fmt.errorBlock('Missing argument', 'Usage: wunderland rag ingest <file-or-text>');
    process.exitCode = 1;
    return;
  }

  let content: string;
  try {
    const s = await stat(target);
    if (s.isFile()) {
      content = await readFile(target, 'utf8');
      fmt.note(`Reading file: ${path.basename(target)} (${(s.size / 1024).toFixed(1)} KB)`);
    } else {
      content = target;
    }
  } catch {
    content = target;
  }

  const collectionId = typeof flags['collection'] === 'string' ? flags['collection'] : undefined;
  const category = typeof flags['category'] === 'string' ? flags['category'] : undefined;

  // ── Unified ingestion flags ──
  const chunkingMethod = typeof flags['chunking'] === 'string' ? flags['chunking'] : undefined;
  const chunkSize = typeof flags['chunk-size'] === 'string' ? parseInt(flags['chunk-size'], 10) : undefined;
  const chunkOverlap = typeof flags['chunk-overlap'] === 'string' ? parseInt(flags['chunk-overlap'], 10) : undefined;
  const buildRaptor = flags['build-raptor'] === true;
  const buildBm25 = flags['build-bm25'] === true;
  const extractEntities = flags['extract-entities'] === true;

  // Build request body with optional unified ingestion parameters
  const body: Record<string, unknown> = { content, collectionId, category };

  if (chunkingMethod) {
    body.chunking = {
      method: chunkingMethod,
      targetSize: chunkSize,
      overlap: chunkOverlap,
    };
  }
  if (buildRaptor) body.buildRaptor = true;
  if (buildBm25) body.buildBm25 = true;
  if (extractEntities) body.extractEntities = true;

  const result = await ragFetch('/ingest', { method: 'POST', body });
  fmt.ok(`Ingested ${arrow()} document ${dim(result.documentId)} (${result.chunksCreated} chunks)`);

  // Report post-processing results when available
  if (result.raptorUpdated) {
    fmt.ok(`RAPTOR tree updated (${result.raptorLayers ?? '?'} layers)`);
  }
  if (result.bm25Updated) {
    fmt.ok('BM25 index updated');
  }
  if (result.entitiesExtracted) {
    fmt.ok(`Entities extracted: ${result.entityCount ?? 0} entities, ${result.relationshipCount ?? 0} relationships`);
  }
}

// -- Main dispatcher --------------------------------------------------------

export default async function cmdRag(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];

  if (!sub || sub === 'help') {
    fmt.section('wunderland rag');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('ingest <file|text>')}       Ingest a document (semantic chunking, RAPTOR, BM25)
    ${dim('ingest-image <file>')}      Ingest an image (LLM captioning)
    ${dim('ingest-audio <file>')}      Ingest audio (Whisper transcription)
    ${dim('ingest-document <file>')}   Ingest a document file (PDF/DOCX/TXT/MD/CSV/JSON/XML)
    ${dim('query <text>')}             Search with unified retrieval (strategy selection, hybrid, HyDE)
    ${dim('query-media <text>')}       Search media assets
    ${dim('query-image <file>')}       Search assets using a query image
    ${dim('query-audio <file>')}       Search assets using a query audio clip
    ${dim('status')}                   Show unified retrieval system status
    ${dim('plan "<query>"')}           Preview retrieval plan without executing
    ${dim('collections [list|create|delete]')}  Manage collections
    ${dim('documents [list|delete]')}  Manage documents
    ${dim('graph [local-search|global-search|stats]')}  GraphRAG
    ${dim('stats')}                    RAG statistics
    ${dim('health')}                   Service health
    ${dim('audit')}                    View audit trail

  ${accent('Query Flags (unified retrieval):')}
    ${dim('--strategy <s>')}     Retrieval strategy: none|simple|moderate|complex|auto (default: auto)
    ${dim('--hyde')}              Enable HyDE hypothesis generation
    ${dim('--hyde-count <n>')}   Number of hypotheses (default: 3)
    ${dim('--bm25')}              Enable BM25 keyword search alongside vector
    ${dim('--graph')}             Enable GraphRAG entity traversal
    ${dim('--raptor')}            Enable RAPTOR hierarchical tree search
    ${dim('--memory')}            Search cognitive memory alongside documents
    ${dim('--memory-types <t>')} Memory types: episodic,semantic,procedural (default: all)
    ${dim('--deep-research')}    Enable deep research decomposition
    ${dim('--json')}              Output raw JSON result

  ${accent('Ingest Flags (unified chunking):')}
    ${dim('--chunking <method>')}   Chunking: fixed|semantic (default: semantic)
    ${dim('--chunk-size <n>')}      Target chunk size in chars (default: 1000)
    ${dim('--chunk-overlap <n>')}   Overlap chars (default: 100)
    ${dim('--build-raptor')}        Build/update RAPTOR summary tree after ingestion
    ${dim('--build-bm25')}          Build/update BM25 keyword index after ingestion
    ${dim('--extract-entities')}    Run GraphRAG entity extraction

  ${accent('General Flags:')}
    ${dim('--collection <id>')}  Target collection
    ${dim('--format json|table')}  Output format
    ${dim('--top-k <n>')}        Max results (default: 5)
    ${dim('--preset <p>')}       Retrieval preset (fast|balanced|accurate)
    ${dim('--debug')}             Show pipeline debug trace (query)
    ${dim('--modality <m>')}     Media filter (image|audio|document)
    ${dim('--text <text>')}       Precomputed caption/transcript for multimodal query
    ${dim('--retrieval-mode <m>')} Retrieval mode (auto|text|native|hybrid)
    ${dim('--include-metadata')}  Include asset metadata in multimodal query results
    ${dim('--source-url <url>')}  Source URL hint for image query attribution
    ${dim('--user-id <id>')}      User ID hint for hosted audio transcription
    ${dim('--category <c>')}     Document category
    ${dim('--verbose, -v')}      Show audit trail (query) / per-op details (audit)
    ${dim('--seed-id <id>')}     Filter by seed ID (audit)
    ${dim('--limit <n>')}        Max results (audit, default: 20)
    ${dim('--since <date>')}     Filter since ISO date (audit)
`);
    return;
  }

  try {
    if (sub === 'ingest') await cmdIngestUnified(args.slice(1), flags);
    else if (sub === 'ingest-image') await cmdIngestImage(args.slice(1));
    else if (sub === 'ingest-audio') await cmdIngestAudio(args.slice(1));
    else if (sub === 'ingest-document') await cmdIngestDocument(args.slice(1));
    else if (sub === 'query') await cmdQueryUnified(args.slice(1), flags);
    else if (sub === 'query-media') await cmdQueryMedia(args.slice(1), flags);
    else if (sub === 'query-image') await cmdQueryImage(args.slice(1), flags);
    else if (sub === 'query-audio') await cmdQueryAudio(args.slice(1), flags);
    else if (sub === 'status') await cmdStatus(flags);
    else if (sub === 'plan') await cmdPlan(args.slice(1), flags);
    else if (sub === 'collections') await cmdCollections(args.slice(1), flags);
    else if (sub === 'documents') await cmdDocuments(args.slice(1), flags);
    else if (sub === 'graph') await cmdGraph(args.slice(1), flags);
    else if (sub === 'stats') await cmdStats(flags);
    else if (sub === 'health') await cmdHealth();
    else if (sub === 'audit') await cmdAudit(args.slice(1), flags);
    else {
      fmt.errorBlock('Unknown subcommand', `"${sub}" is not valid. Run ${accent('wunderland rag')} for help.`);
      process.exitCode = 1;
    }
  } catch (err) {
    fmt.errorBlock('RAG Error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
