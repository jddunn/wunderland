import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClientQuery, MockRagClient } = vi.hoisted(() => {
  const mockClientQuery = vi.fn().mockResolvedValue({
    success: true,
    query: 'test',
    chunks: [
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        content: 'Stored memory result',
        score: 0.92,
        metadata: { source: 'knowledge-base' },
      },
    ],
    totalResults: 1,
    processingTimeMs: 2,
  });

  const MockRagClient = vi.fn().mockImplementation(() => ({
    query: mockClientQuery,
  }));

  return { mockClientQuery, MockRagClient };
});

vi.mock('../rag/rag-client.js', () => ({
  WunderlandRAGClient: MockRagClient,
}));

import { createConfiguredRagTools } from '../rag/runtime-tools.js';

describe('createConfiguredRagTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards default HyDE settings to the HTTP-backed memory_read tool', async () => {
    const tools = createConfiguredRagTools({
      seedId: 'seed-1',
      rag: {
        enabled: true,
        backendUrl: 'http://localhost:3001',
      },
    });

    const memoryRead = tools.find((tool) => tool.name === 'memory_read');
    expect(memoryRead).toBeTruthy();

    const result = await memoryRead!.execute({ query: 'remember our architecture notes' }, {} as any);
    expect(result.success).toBe(true);
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'remember our architecture notes',
        hyde: expect.objectContaining({
          enabled: true,
          initialThreshold: 0.7,
          minThreshold: 0.3,
          adaptiveThreshold: true,
        }),
      }),
    );
  });

  it('forwards explicit HyDE settings to the HTTP-backed rag_query tool', async () => {
    mockClientQuery.mockResolvedValueOnce({
      success: true,
      query: 'find deployment runbooks',
      hydeUsed: true,
      chunks: [
        {
          chunkId: 'chunk-2',
          documentId: 'doc-2',
          content: 'Runbook result',
          score: 0.88,
          metadata: { source: 'ops' },
        },
      ],
      totalResults: 1,
      processingTimeMs: 3,
    });

    const tools = createConfiguredRagTools({
      seedId: 'seed-2',
      rag: {
        enabled: true,
        backendUrl: 'http://localhost:3001',
        hyde: {
          enabled: false,
          initialThreshold: 0.85,
        },
      },
    });

    const ragQuery = tools.find((tool) => tool.name === 'rag_query');
    expect(ragQuery).toBeTruthy();

    const result = await ragQuery!.execute({ query: 'find deployment runbooks' }, {} as any);
    expect(result.success).toBe(true);
    expect(JSON.parse(String(result.output))).toEqual(
      expect.objectContaining({
        query: 'find deployment runbooks',
        hydeUsed: true,
        totalResults: 1,
      }),
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'find deployment runbooks',
        hyde: expect.objectContaining({
          enabled: false,
          initialThreshold: 0.85,
        }),
      }),
    );
  });
});
