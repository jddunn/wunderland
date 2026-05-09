// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WunderlandRAGClient } from './rag-client.js';

describe('WunderlandRAGClient', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'wunderland-rag-client-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('maps hybrid_search to a hybrid-capable backend query shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        query: 'red square',
        chunks: [],
        totalResults: 0,
        processingTimeMs: 1,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new WunderlandRAGClient({ baseUrl: 'http://localhost:3001' });
    await client.query({
      query: 'red square',
      strategy: 'hybrid_search',
      preset: 'fast',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');

    const body = JSON.parse(String(init.body));
    expect(body.strategy).toBeUndefined();
    expect(body.preset).toBe('balanced');
    expect(body.query).toBe('red square');
  });

  it('forwards retrievalMode on multipart image queries', async () => {
    const filePath = path.join(tempDir, 'query.png');
    await writeFile(filePath, Buffer.from([1, 2, 3]));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          success: true,
          query: '[Image] red square',
          assets: [],
          totalResults: 0,
          processingTimeMs: 1,
          retrieval: {
            requestedMode: 'hybrid',
            resolvedMode: 'text',
          },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new WunderlandRAGClient({ baseUrl: 'http://localhost:3001' });
    await client.queryByImage({
      filePath,
      textRepresentation: '[Image] red square',
      retrievalMode: 'hybrid',
      modalities: ['image'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = init.body as FormData;
    expect(body.get('retrievalMode')).toBe('hybrid');
    expect(body.get('modalities')).toBe('image');
    expect((body.get('image') as File).type).toBe('image/png');
  });

  it('uploads document assets via the multipart document endpoint', async () => {
    const filePath = path.join(tempDir, 'report.txt');
    await writeFile(filePath, 'Quarterly revenue grew 30 percent.');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        assetId: 'doc_asset_1',
        collectionId: 'media_documents',
        documentId: 'doc_asset_1',
        textRepresentation: '[Document]\nContent:\nQuarterly revenue grew 30 percent.',
        chunksCreated: 1,
        modality: 'document',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new WunderlandRAGClient({ baseUrl: 'http://localhost:3001' });
    await client.ingestDocumentAsset(filePath, {
      collectionId: 'media_documents',
      textRepresentation: '[Document]\nContent:\nQuarterly revenue grew 30 percent.',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:3001/api/agentos/rag/multimodal/documents/ingest'
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = init.body as FormData;
    expect(body.get('collectionId')).toBe('media_documents');
    expect(body.get('textRepresentation')).toBe(
      '[Document]\nContent:\nQuarterly revenue grew 30 percent.'
    );
    expect(body.get('document')).toBeInstanceOf(File);
    expect((body.get('document') as File).type).toBe('text/plain');
  });
});
