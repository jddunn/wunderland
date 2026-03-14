/**
 * @fileoverview RAG knowledge bootstrap — seeds the agent's vector store with
 * documentation on first startup (or when docs change). Skips if already seeded
 * with the same content hash.
 *
 * Reads *.md files from {workingDirectory}/knowledge/ and ingests them into the
 * agent's SqlVectorStore collection "knowledge_base".
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const COLLECTION_NAME = 'knowledge_base';
const STATE_KEY = 'rag_bootstrap:v1';
const CHUNK_SIZE = 500;       // chars per chunk
const CHUNK_OVERLAP = 50;     // overlap between chunks

interface BootstrapState {
  contentHash: string;
  documentCount: number;
  chunkCount: number;
  timestamp: number;
}

/** Split text into overlapping chunks at sentence/paragraph boundaries. */
function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 1 > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      // Keep overlap from end of current chunk
      const words = current.split(/\s+/);
      const overlapWords = words.slice(-Math.ceil(overlap / 5));
      current = overlapWords.join(' ') + '\n\n' + para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks;
}

/** Generate embeddings via OpenAI API. */
async function generateEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
  const batchSize = 20; // OpenAI supports up to 2048 inputs but let's be conservative
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: batch,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings API error ${res.status}: ${text}`);
    }

    const data = await res.json() as any;
    const embeddings = data.data.map((d: any) => d.embedding);
    allEmbeddings.push(...embeddings);
  }

  return allEmbeddings;
}

export async function bootstrapRagKnowledge(ctx: any): Promise<void> {
  const storageManager = ctx.agentStorageManager;
  if (!storageManager) {
    console.log('[RAG Bootstrap] No storage manager — skipping');
    return;
  }

  const apiKey = ctx.llmApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log('[RAG Bootstrap] No OpenAI API key — skipping RAG seeding');
    return;
  }

  // Resolve knowledge directory
  const workingDir = ctx.workingDirectory || process.cwd();
  const knowledgeDir = path.join(workingDir, 'knowledge');
  if (!fs.existsSync(knowledgeDir)) {
    console.log('[RAG Bootstrap] No knowledge/ directory — skipping');
    return;
  }

  // Read all .md files
  const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md')).sort();
  if (files.length === 0) {
    console.log('[RAG Bootstrap] No .md files in knowledge/ — skipping');
    return;
  }

  // Build content hash to detect changes
  const contentParts: string[] = [];
  const fileDocs: Array<{ name: string; content: string }> = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(knowledgeDir, file), 'utf-8');
    contentParts.push(`${file}:${content}`);
    fileDocs.push({ name: file, content });
  }
  const contentHash = crypto.createHash('sha256').update(contentParts.join('\n---\n')).digest('hex').slice(0, 16);

  // Check if already seeded with this hash
  const stateStore = storageManager.getStateStore();
  const existing = await stateStore.get(STATE_KEY) as BootstrapState | null;
  if (existing?.contentHash === contentHash) {
    console.log(`[RAG Bootstrap] Already seeded (${existing.documentCount} docs, ${existing.chunkCount} chunks) — skipping`);
    return;
  }

  console.log(`[RAG Bootstrap] Seeding ${fileDocs.length} knowledge docs into vector store...`);

  // Chunk all documents
  const allChunks: Array<{ id: string; text: string; metadata: Record<string, any> }> = [];
  for (const doc of fileDocs) {
    const chunks = chunkText(doc.content, CHUNK_SIZE, CHUNK_OVERLAP);
    for (let i = 0; i < chunks.length; i++) {
      allChunks.push({
        id: `kb_${doc.name.replace(/\.md$/, '')}_${i}`,
        text: chunks[i],
        metadata: {
          source: doc.name,
          chunk_index: i,
          total_chunks: chunks.length,
          category: 'knowledge_base',
          ingested_at: new Date().toISOString(),
        },
      });
    }
  }

  console.log(`[RAG Bootstrap] ${allChunks.length} chunks from ${fileDocs.length} files, generating embeddings...`);

  // Generate embeddings
  const texts = allChunks.map(c => c.text);
  const embeddings = await generateEmbeddings(texts, apiKey);

  // Build VectorDocument array
  const vectorDocs = allChunks.map((chunk, i) => ({
    id: chunk.id,
    embedding: embeddings[i],
    textContent: chunk.text,
    metadata: chunk.metadata,
  }));

  // Upsert into vector store
  const vectorStore = storageManager.getVectorStore();
  if (!vectorStore) {
    console.warn('[RAG Bootstrap] No vector store available — skipping');
    return;
  }

  await vectorStore.upsert(COLLECTION_NAME, vectorDocs);

  // Save state
  await stateStore.set(STATE_KEY, {
    contentHash,
    documentCount: fileDocs.length,
    chunkCount: allChunks.length,
    timestamp: Date.now(),
  });

  console.log(`[RAG Bootstrap] Done — ingested ${allChunks.length} chunks from ${fileDocs.length} docs`);
}
