/**
 * @fileoverview `wunderland rag` -- RAG memory management (ingest, query, collections, media, graph).
 * @module wunderland/cli/commands/rag
 */

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, dim, success as sColor, error as eColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

function getBackendUrl(): string {
  return process.env.WUNDERLAND_BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';
}

function ragUrl(base: string): string {
  return base.replace(/\/+$/, '') + '/agentos/rag';
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
    throw new Error(`${method} ${urlPath} → ${res.status}: ${text}`);
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
  fmt.ok(`Ingested → document ${dim(result.documentId)} (${result.chunksCreated} chunks)`);
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
  fmt.ok(`Image ingested → asset ${dim(result.assetId)} (${result.chunksCreated} chunks)`);
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
  fmt.ok(`Audio ingested → asset ${dim(result.assetId)} (${result.chunksCreated} chunks)`);
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

  const result = await ragFetch('/query', { method: 'POST', body: { query, topK, preset, collectionIds } });

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
      fmt.kvPair(c.collectionId, `${c.documentCount} docs, ${c.chunkCount} chunks — ${c.displayName || ''}`);
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
  fmt.kvPair('Documents', String(result.totalDocuments ?? 0));
  fmt.kvPair('Chunks', String(result.totalChunks ?? 0));
  fmt.kvPair('Collections', String(result.totalCollections ?? 0));
  fmt.kvPair('Vector Store', result.vectorStoreProvider ?? 'unknown');
  fmt.kvPair('Embedding', result.embeddingProvider ?? 'unknown');
  fmt.blank();
}

async function cmdHealth(): Promise<void> {
  try {
    const result = await ragFetch('/health');
    fmt.section('RAG Health');
    fmt.kvPair('Available', result.available ? sColor('yes') : eColor('no'));
    fmt.kvPair('Adapter', result.adapterKind ?? 'unknown');
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
    fmt.section(`GraphRAG Local: "${query}"`);
    for (const r of result.results ?? []) { fmt.kvPair(`(${(r.score * 100).toFixed(0)}%)`, r.content?.slice(0, 200) ?? ''); }
    fmt.blank();
  } else if (sub === 'global-search') {
    const query = args.slice(1).join(' ');
    if (!query) { fmt.errorBlock('Missing query', 'Usage: wunderland rag graph global-search <text>'); process.exitCode = 1; return; }
    const result = await ragFetch('/graphrag/global-search', { method: 'POST', body: { query } });
    if (format === 'json') { console.log(JSON.stringify(result, null, 2)); return; }
    fmt.section(`GraphRAG Global: "${query}"`);
    for (const r of result.results ?? []) { fmt.kvPair(`(${(r.score * 100).toFixed(0)}%)`, r.content?.slice(0, 200) ?? ''); }
    fmt.blank();
  } else if (sub === 'stats') {
    const result = await ragFetch('/graphrag/stats');
    if (format === 'json') { console.log(JSON.stringify(result, null, 2)); return; }
    fmt.section('GraphRAG Statistics');
    for (const [k, v] of Object.entries(result)) { fmt.kvPair(k, String(v)); }
    fmt.blank();
  } else {
    fmt.errorBlock('Unknown subcommand', `"${sub ?? '(none)'}". Use: local-search, global-search, stats`);
    process.exitCode = 1;
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

  ${accent('Flags:')}
    ${dim('--collection <id>')}  Target collection
    ${dim('--format json|table')}  Output format
    ${dim('--top-k <n>')}        Max results (default: 5)
    ${dim('--preset <p>')}       Retrieval preset (fast|balanced|accurate)
    ${dim('--modality <m>')}     Media filter (image|audio)
    ${dim('--category <c>')}     Document category
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
    else {
      fmt.errorBlock('Unknown subcommand', `"${sub}" is not valid. Run ${accent('wunderland rag')} for help.`);
      process.exitCode = 1;
    }
  } catch (err) {
    fmt.errorBlock('RAG Error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
