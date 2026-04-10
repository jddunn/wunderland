// @ts-nocheck
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cmdRag from './rag.js';

vi.mock('../config/env-manager.js', () => ({
  loadDotEnvIntoProcessUpward: vi.fn().mockResolvedValue(undefined),
}));

describe('wunderland rag multimodal CLI', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'wunderland-rag-cli-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('posts query-image requests with the expected multipart fields', async () => {
    const filePath = path.join(tempDir, 'query.png');
    await writeFile(filePath, Buffer.from([1, 2, 3, 4]));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        query: '[Image] red square',
        assets: [],
        totalResults: 0,
        processingTimeMs: 1,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cmdRag(
      ['query-image', filePath],
      {
        format: 'json',
        modality: 'image',
        collection: 'media_images',
        'top-k': '7',
        text: '[Image] red square',
        'retrieval-mode': 'hybrid',
        'include-metadata': true,
      },
      {}
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:3001/api/agentos/rag/multimodal/images/query');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = init.body as FormData;
    expect(body.get('modalities')).toBe('image');
    expect(body.get('collectionIds')).toBe('media_images');
    expect(body.get('topK')).toBe('7');
    expect(body.get('textRepresentation')).toBe('[Image] red square');
    expect(body.get('retrievalMode')).toBe('hybrid');
    expect(body.get('includeMetadata')).toBe('true');
    expect(body.get('image')).toBeInstanceOf(File);
    expect((body.get('image') as File).type).toBe('image/png');
    expect(logSpy).toHaveBeenCalled();
  });

  it('posts query-audio requests with the expected multipart fields', async () => {
    const filePath = path.join(tempDir, 'query.webm');
    await writeFile(filePath, Buffer.from([9, 8, 7, 6]));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        query: '[Audio] hello world',
        assets: [],
        totalResults: 0,
        processingTimeMs: 1,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cmdRag(
      ['query-audio', filePath],
      {
        format: 'json',
        modality: 'audio',
        collection: 'media_audio',
        'top-k': '4',
        text: '[Audio] hello world',
        'retrieval-mode': 'native',
        'include-metadata': true,
        'user-id': 'user_99',
      },
      {}
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:3001/api/agentos/rag/multimodal/audio/query');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = init.body as FormData;
    expect(body.get('modalities')).toBe('audio');
    expect(body.get('collectionIds')).toBe('media_audio');
    expect(body.get('topK')).toBe('4');
    expect(body.get('textRepresentation')).toBe('[Audio] hello world');
    expect(body.get('retrievalMode')).toBe('native');
    expect(body.get('includeMetadata')).toBe('true');
    expect(body.get('userId')).toBe('user_99');
    expect(body.get('audio')).toBeInstanceOf(File);
    expect((body.get('audio') as File).type).toBe('audio/webm');
    expect(logSpy).toHaveBeenCalled();
  });

  it('posts ingest-document requests with the expected multipart fields', async () => {
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
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cmdRag(['ingest-document', filePath], { format: 'json' }, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:3001/api/agentos/rag/multimodal/documents/ingest'
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = init.body as FormData;
    expect(body.get('document')).toBeInstanceOf(File);
    expect((body.get('document') as File).type).toBe('text/plain');
    expect(logSpy).toHaveBeenCalled();
  });
});
