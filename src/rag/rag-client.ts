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
  /** Unix epoch millis (as returned by the backend). */
  createdAt: number;
  /** Unix epoch millis (as returned by the backend). */
  updatedAt: number;
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
  assetId?: string;
  collectionId?: string;
  sourceUrl?: string;
  category?: 'conversation_memory' | 'knowledge_base' | 'user_notes' | 'system' | 'custom';
  tags?: string[];
  metadata?: Record<string, unknown>;
  storePayload?: boolean;
  userId?: string;
  agentId?: string;
  /**
   * Optional precomputed text representation (caption/transcript).
   * When provided, the backend skips captioning/transcription.
   */
  textRepresentation?: string;
}

export interface MediaIngestResult {
  success: boolean;
  assetId: string;
  collectionId: string;
  documentId: string;
  textRepresentation: string;
  chunksCreated: number;
  modality: 'image' | 'audio';
  error?: string;
}

export interface MediaQueryInput {
  query: string;
  modalities?: ('image' | 'audio')[];
  topK?: number;
  collectionIds?: string[];
  includeMetadata?: boolean;
}

export interface MediaQueryResult {
  success: boolean;
  query: string;
  assets: Array<{
    asset: MediaAsset;
    bestChunk: {
      chunkId: string;
      documentId: string;
      content: string;
      score: number;
      metadata?: Record<string, unknown>;
    };
  }>;
  totalResults: number;
  processingTimeMs: number;
  error?: string;
}

export interface MediaAsset {
  assetId: string;
  collectionId: string;
  modality: 'image' | 'audio';
  mimeType: string;
  originalFileName?: string | null;
  sourceUrl?: string | null;
  contentHashHex?: string | null;
  metadata?: Record<string, unknown>;
  /** Unix epoch millis (as returned by the backend). */
  createdAt: number;
  /** Unix epoch millis (as returned by the backend). */
  updatedAt: number;
}

export interface MediaQueryByImageInput {
  /** Query image path on disk. */
  filePath: string;
  /** Optional query source URL for logging/attribution only. */
  sourceUrl?: string;
  /**
   * Optional precomputed text representation of the query image.
   * When provided, the backend skips captioning (no LLM vision call).
   */
  textRepresentation?: string;
  modalities?: ('image' | 'audio')[];
  collectionIds?: string[];
  topK?: number;
  includeMetadata?: boolean;
}

export interface MediaQueryByAudioInput {
  /** Query audio path on disk. */
  filePath: string;
  /**
   * Optional precomputed text representation of the query audio.
   * When provided, the backend skips transcription (no Whisper call).
   */
  textRepresentation?: string;
  modalities?: ('image' | 'audio')[];
  collectionIds?: string[];
  topK?: number;
  includeMetadata?: boolean;
  /**
   * Optional userId for attribution/cost tracking on hosted transcription paths.
   * Ignored when `textRepresentation` is provided.
   */
  userId?: string;
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
    formData.append('image', new Blob([data]), filename);
    if (input?.assetId) formData.append('assetId', input.assetId);
    if (input?.collectionId) formData.append('collectionId', input.collectionId);
    if (input?.sourceUrl) formData.append('sourceUrl', input.sourceUrl);
    if (input?.category) formData.append('category', input.category);
    if (input?.tags?.length) formData.append('tags', input.tags.join(','));
    if (typeof input?.storePayload === 'boolean') {
      formData.append('storePayload', input.storePayload ? 'true' : 'false');
    }
    if (input?.metadata) formData.append('metadata', JSON.stringify(input.metadata));
    if (input?.userId) formData.append('userId', input.userId);
    if (input?.agentId) formData.append('agentId', input.agentId);
    if (input?.textRepresentation) formData.append('textRepresentation', input.textRepresentation);

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
    formData.append('audio', new Blob([data]), filename);
    if (input?.assetId) formData.append('assetId', input.assetId);
    if (input?.collectionId) formData.append('collectionId', input.collectionId);
    if (input?.sourceUrl) formData.append('sourceUrl', input.sourceUrl);
    if (input?.category) formData.append('category', input.category);
    if (input?.tags?.length) formData.append('tags', input.tags.join(','));
    if (typeof input?.storePayload === 'boolean') {
      formData.append('storePayload', input.storePayload ? 'true' : 'false');
    }
    if (input?.metadata) formData.append('metadata', JSON.stringify(input.metadata));
    if (input?.userId) formData.append('userId', input.userId);
    if (input?.agentId) formData.append('agentId', input.agentId);
    if (input?.textRepresentation) formData.append('textRepresentation', input.textRepresentation);

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

  async queryByImage(input: MediaQueryByImageInput): Promise<MediaQueryResult> {
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(input.filePath);
    const filename = input.filePath.split('/').pop() ?? 'image';

    const formData = new FormData();
    formData.append('image', new Blob([data]), filename);
    if (input.sourceUrl) formData.append('sourceUrl', input.sourceUrl);
    if (input.textRepresentation) formData.append('textRepresentation', input.textRepresentation);
    if (input.modalities?.length) formData.append('modalities', input.modalities.join(','));
    if (input.collectionIds?.length) formData.append('collectionIds', input.collectionIds.join(','));
    if (typeof input.topK === 'number') formData.append('topK', String(input.topK));
    if (typeof input.includeMetadata === 'boolean') {
      formData.append('includeMetadata', input.includeMetadata ? 'true' : 'false');
    }

    const url = `${this.baseUrl}/multimodal/images/query`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 2);
    try {
      const headers: Record<string, string> = {};
      if (this.headers['Authorization']) headers['Authorization'] = this.headers['Authorization'];
      const res = await fetch(url, { method: 'POST', headers, body: formData, signal: controller.signal });
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new Error(`RAG image query failed (${res.status}): ${text}`.trim());
      return JSON.parse(text) as MediaQueryResult;
    } finally {
      clearTimeout(timer);
    }
  }

  async queryByAudio(input: MediaQueryByAudioInput): Promise<MediaQueryResult> {
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(input.filePath);
    const filename = input.filePath.split('/').pop() ?? 'audio';

    const formData = new FormData();
    formData.append('audio', new Blob([data]), filename);
    if (input.textRepresentation) formData.append('textRepresentation', input.textRepresentation);
    if (input.modalities?.length) formData.append('modalities', input.modalities.join(','));
    if (input.collectionIds?.length) formData.append('collectionIds', input.collectionIds.join(','));
    if (typeof input.topK === 'number') formData.append('topK', String(input.topK));
    if (typeof input.includeMetadata === 'boolean') {
      formData.append('includeMetadata', input.includeMetadata ? 'true' : 'false');
    }
    if (input.userId) formData.append('userId', input.userId);

    const url = `${this.baseUrl}/multimodal/audio/query`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 2);
    try {
      const headers: Record<string, string> = {};
      if (this.headers['Authorization']) headers['Authorization'] = this.headers['Authorization'];
      const res = await fetch(url, { method: 'POST', headers, body: formData, signal: controller.signal });
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new Error(`RAG audio query failed (${res.status}): ${text}`.trim());
      return JSON.parse(text) as MediaQueryResult;
    } finally {
      clearTimeout(timer);
    }
  }

  async queryMedia(input: MediaQueryInput): Promise<MediaQueryResult> {
    return this.request('POST', '/multimodal/query', input);
  }

  async getAsset(assetId: string): Promise<MediaAsset> {
    const resp = await this.request<{ success: boolean; asset: MediaAsset }>(
      'GET',
      `/multimodal/assets/${encodeURIComponent(assetId)}`,
    );
    return resp.asset;
  }

  async deleteAsset(assetId: string): Promise<{ success: boolean; assetId?: string; message?: string }> {
    const resp = await this.request<{ success: boolean; assetId?: string; message?: string }>(
      'DELETE',
      `/multimodal/assets/${encodeURIComponent(assetId)}`,
    );
    return resp;
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
