/**
 * @fileoverview `wunderland rag` -- RAG memory management (ingest, query, collections, media, graph).
 * @module wunderland/cli/commands/rag
 */

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, dim, success as sColor, error as eColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { getUiRuntime } from '../ui/runtime.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

function getBackendUrl(): string {
  return process.env.WUNDERLAND_BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';
}

function ragUrl(base: string): string {
  return base.replace(/\/+$/, '') + '/agentos/rag';
}

function arrow(): string {
  return getUiRuntime().ascii ? '->' : '→';
}

async function ragFetch(urlPath: string, options?: { method?: string; body?: unknown }): Promise<any> {
  const base = ragUrl(getBackendUrl());
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

// -- Sub-commands -----------------------------------------------------------

async function cmdIngest(args: string[], flags: Record<string, string | boolean>): Promise<void> {
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

  const result = await ragFetch('/ingest', { method: 'POST', body: { content, collectionId, category } });
  fmt.ok(`Ingested ${arrow()} document ${dim(result.documentId)} (${result.chunksCreated} chunks)`);
}

async function cmdIngestImage(args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    fmt.errorBlock('Missing argument', 'Usage: wunderland rag ingest-image <file>');
    process.exitCode = 1;
    return;
  }
  const base = ragUrl(getBackendUrl());
  const data = await readFile(filePath);
  const formData = new FormData();
  formData.append('file', new Blob([data]), path.basename(filePath));

  const res = await fetch(`${base}/multimodal/images/ingest`, { method: 'POST', body: formData });
  if (!res.ok) throw new Error(`Image ingest failed (${res.status})`);
  const result = await res.json() as any;
  fmt.ok(`Image ingested ${arrow()} asset ${dim(result.assetId)} (${result.chunksCreated} chunks)`);
}

async function cmdIngestAudio(args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    fmt.errorBlock('Missing argument', 'Usage: wunderland rag ingest-audio <file>');
    process.exitCode = 1;
    return;
  }
  const base = ragUrl(getBackendUrl());
  const data = await readFile(filePath);
  const formData = new FormData();
  formData.append('file', new Blob([data]), path.basename(filePath));

  const res = await fetch(`${base}/multimodal/audio/ingest`, { method: 'POST', body: formData });
  if (!res.ok) throw new Error(`Audio ingest failed (${res.status})`);
  const result = await res.json() as any;
  fmt.ok(`Audio ingested ${arrow()} asset ${dim(result.assetId)} (${result.chunksCreated} chunks)`);
}

async function cmdQuery(args: string[], flags: Record<string, string | boolean>): Promise<void> {
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

  const result = await ragFetch('/query', {
    method: 'POST',
    body: { query, topK, preset, collectionIds, includeAudit: verbose, includeGraphRag, debug },
  });

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
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

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  fmt.section(`Media Query: "${query}"`);
  if (!result.assets?.length) {
    fmt.note('No media assets found.');
    return;
  }
  for (const item of result.assets) {
    fmt.kvPair(`[${item.asset.modality}] ${item.asset.assetId}`, item.bestChunk?.content?.slice(0, 150) ?? '');
  }
  fmt.blank();
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
    const backendUrl = getBackendUrl();
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
    ${dim('ingest <file|text>')}       Ingest a document
    ${dim('ingest-image <file>')}      Ingest an image (LLM captioning)
    ${dim('ingest-audio <file>')}      Ingest audio (Whisper transcription)
    ${dim('query <text>')}             Search RAG memory
    ${dim('query-media <text>')}       Search media assets
    ${dim('collections [list|create|delete]')}  Manage collections
    ${dim('documents [list|delete]')}  Manage documents
    ${dim('graph [local-search|global-search|stats]')}  GraphRAG
    ${dim('stats')}                    RAG statistics
    ${dim('health')}                   Service health
    ${dim('audit')}                    View audit trail

  ${accent('Flags:')}
    ${dim('--collection <id>')}  Target collection
    ${dim('--format json|table')}  Output format
    ${dim('--top-k <n>')}        Max results (default: 5)
    ${dim('--preset <p>')}       Retrieval preset (fast|balanced|accurate)
    ${dim('--graph')}             Include GraphRAG context in query results
    ${dim('--debug')}             Show pipeline debug trace (query)
    ${dim('--modality <m>')}     Media filter (image|audio)
    ${dim('--category <c>')}     Document category
    ${dim('--verbose, -v')}      Show audit trail (query) / per-op details (audit)
    ${dim('--seed-id <id>')}     Filter by seed ID (audit)
    ${dim('--limit <n>')}        Max results (audit, default: 20)
    ${dim('--since <date>')}     Filter since ISO date (audit)
`);
    return;
  }

  try {
    if (sub === 'ingest') await cmdIngest(args.slice(1), flags);
    else if (sub === 'ingest-image') await cmdIngestImage(args.slice(1));
    else if (sub === 'ingest-audio') await cmdIngestAudio(args.slice(1));
    else if (sub === 'query') await cmdQuery(args.slice(1), flags);
    else if (sub === 'query-media') await cmdQueryMedia(args.slice(1), flags);
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
