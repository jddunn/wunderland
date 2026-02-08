/**
 * @fileoverview HTTP client for the Wunderland backend RAG API.
 * Wraps /api/agentos/rag/* endpoints with typed methods.
 * @module wunderland/rag/rag-client
 */

export interface RAGClientConfig {
  baseUrl: string;
  authToken?: string;
  timeout?: number;
}

export interface RAGIngestInput {
  content: string;
  collectionId?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

export interface RAGIngestResult {
  success: boolean;
  documentId: string;
  chunksCreated: number;
  collectionId: string;
}

export interface RAGQueryInput {
  query: string;
  collectionIds?: string[];
  topK?: number;
  preset?: 'fast' | 'balanced' | 'accurate';
  metadataFilter?: Record<string, unknown>;
}

export interface RAGQueryResult {
  success: boolean;
  query: string;
  chunks: Array<{
    chunkId: string;
    documentId: string;
    content: string;
    score: number;
    metadata?: Record<string, unknown>;
  }>;
  totalResults: number;
  processingTimeMs: number;
}

export interface RAGCollection {
  collectionId: string;
  displayName: string;
  documentCount: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RAGDocument {
  documentId: string;
  collectionId: string;
  category: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RAGStats {
  totalDocuments: number;
  totalChunks: number;
  totalCollections: number;
  vectorStoreProvider: string;
  embeddingProvider: string;
}

export interface RAGHealth {
  available: boolean;
  adapterKind: string;
  vectorStoreReady: boolean;
  embeddingReady: boolean;
}

export interface MediaIngestInput {
  collectionId?: string;
  metadata?: Record<string, unknown>;
}

export interface MediaIngestResult {
  success: boolean;
  assetId: string;
  documentId: string;
  chunksCreated: number;
  modality: 'image' | 'audio';
}

export interface MediaQueryInput {
  query: string;
  modalities?: ('image' | 'audio')[];
  topK?: number;
  collectionIds?: string[];
}

export interface MediaQueryResult {
  success: boolean;
  query: string;
  assets: Array<{
    asset: MediaAsset;
    bestChunk: { content: string; score: number };
  }>;
  totalResults: number;
  processingTimeMs: number;
}

export interface MediaAsset {
  assetId: string;
  collectionId: string;
  modality: 'image' | 'audio';
  mimeType: string;
  originalFilename?: string;
  contentHashHex?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface GraphSearchInput {
  query: string;
  maxResults?: number;
}

export interface GraphSearchResult {
  success: boolean;
  query: string;
  results: Array<{ content: string; score: number; metadata?: Record<string, unknown> }>;
  processingTimeMs: number;
}

export class WunderlandRAGClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;

  constructor(config: RAGClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '') + '/api/agentos/rag';
    this.headers = { 'Content-Type': 'application/json' };
    if (config.authToken) {
      this.headers['Authorization'] = `Bearer ${config.authToken}`;
    }
    this.timeout = config.timeout ?? 30_000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: this.headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`RAG API ${method} ${path} failed (${res.status}): ${text}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // -- Text RAG -------------------------------------------------------------

  async ingest(input: RAGIngestInput): Promise<RAGIngestResult> {
    return this.request('POST', '/ingest', input);
  }

  async query(input: RAGQueryInput): Promise<RAGQueryResult> {
    return this.request('POST', '/query', input);
  }

  async listDocuments(options?: { collectionId?: string; limit?: number; offset?: number }): Promise<{ documents: RAGDocument[]; total: number }> {
    const params = new URLSearchParams();
    if (options?.collectionId) params.set('collectionId', options.collectionId);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const qs = params.toString();
    return this.request('GET', `/documents${qs ? `?${qs}` : ''}`);
  }

  async deleteDocument(documentId: string): Promise<{ success: boolean }> {
    return this.request('DELETE', `/documents/${encodeURIComponent(documentId)}`);
  }

  // -- Collections ----------------------------------------------------------

  async createCollection(collectionId: string, displayName?: string): Promise<RAGCollection> {
    return this.request('POST', '/collections', { collectionId, displayName });
  }

  async listCollections(): Promise<{ collections: RAGCollection[] }> {
    return this.request('GET', '/collections');
  }

  async deleteCollection(collectionId: string): Promise<{ success: boolean }> {
    return this.request('DELETE', `/collections/${encodeURIComponent(collectionId)}`);
  }

  // -- Multimodal -----------------------------------------------------------

  async ingestImage(filePath: string, input?: MediaIngestInput): Promise<MediaIngestResult> {
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(filePath);
    const filename = filePath.split('/').pop() ?? 'image';
    const formData = new FormData();
    formData.append('file', new Blob([data]), filename);
    if (input?.collectionId) formData.append('collectionId', input.collectionId);
    if (input?.metadata) formData.append('metadata', JSON.stringify(input.metadata));

    const url = `${this.baseUrl}/multimodal/images/ingest`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 2);
    try {
      const headers: Record<string, string> = {};
      if (this.headers['Authorization']) headers['Authorization'] = this.headers['Authorization'];
      const res = await fetch(url, { method: 'POST', headers, body: formData, signal: controller.signal });
      if (!res.ok) throw new Error(`RAG image ingest failed (${res.status})`);
      return (await res.json()) as MediaIngestResult;
    } finally {
      clearTimeout(timer);
    }
  }

  async ingestAudio(filePath: string, input?: MediaIngestInput): Promise<MediaIngestResult> {
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(filePath);
    const filename = filePath.split('/').pop() ?? 'audio';
    const formData = new FormData();
    formData.append('file', new Blob([data]), filename);
    if (input?.collectionId) formData.append('collectionId', input.collectionId);
    if (input?.metadata) formData.append('metadata', JSON.stringify(input.metadata));

    const url = `${this.baseUrl}/multimodal/audio/ingest`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 2);
    try {
      const headers: Record<string, string> = {};
      if (this.headers['Authorization']) headers['Authorization'] = this.headers['Authorization'];
      const res = await fetch(url, { method: 'POST', headers, body: formData, signal: controller.signal });
      if (!res.ok) throw new Error(`RAG audio ingest failed (${res.status})`);
      return (await res.json()) as MediaIngestResult;
    } finally {
      clearTimeout(timer);
    }
  }

  async queryMedia(input: MediaQueryInput): Promise<MediaQueryResult> {
    return this.request('POST', '/multimodal/query', input);
  }

  async getAsset(assetId: string): Promise<MediaAsset> {
    return this.request('GET', `/multimodal/assets/${encodeURIComponent(assetId)}`);
  }

  async deleteAsset(assetId: string): Promise<{ success: boolean }> {
    return this.request('DELETE', `/multimodal/assets/${encodeURIComponent(assetId)}`);
  }

  // -- GraphRAG -------------------------------------------------------------

  async graphLocalSearch(query: string, options?: { maxResults?: number }): Promise<GraphSearchResult> {
    return this.request('POST', '/graphrag/local-search', { query, ...options });
  }

  async graphGlobalSearch(query: string, options?: { maxResults?: number }): Promise<GraphSearchResult> {
    return this.request('POST', '/graphrag/global-search', { query, ...options });
  }

  async graphStats(): Promise<Record<string, unknown>> {
    return this.request('GET', '/graphrag/stats');
  }

  // -- Admin ----------------------------------------------------------------

  async stats(agentId?: string): Promise<RAGStats> {
    const qs = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    return this.request('GET', `/stats${qs}`);
  }

  async health(): Promise<RAGHealth> {
    return this.request('GET', '/health');
  }
}
