// @ts-nocheck
/**
 * @fileoverview Tests for hyde-integration — HyDE config resolution and
 * query wrapper for Wunderland's local memory retrieval.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the @framers/agentos/rag module ────────────────────────────────

const { mockRetrieve, MockHydeRetriever, mockResolveHydeConfig } = vi.hoisted(() => {
  const mockRetrieve = vi.fn();
  const MockHydeRetriever = vi.fn().mockImplementation(() => ({
    retrieve: mockRetrieve,
    enabled: true,
  }));

  const mockResolveHydeConfig = vi.fn().mockImplementation((partial: any) => ({
    enabled: false,
    initialThreshold: 0.7,
    minThreshold: 0.3,
    thresholdStep: 0.1,
    adaptiveThreshold: true,
    maxHypothesisTokens: 200,
    hypothesisSystemPrompt: 'test prompt',
    fullAnswerGranularity: true,
    ...partial,
  }));

  return { mockRetrieve, MockHydeRetriever, mockResolveHydeConfig };
});

vi.mock('@framers/agentos/rag', () => ({
  HydeRetriever: MockHydeRetriever,
  resolveHydeConfig: mockResolveHydeConfig,
}));

vi.mock('@framers/agentos', () => ({}));
vi.mock('../api/types.js', () => ({}));

// ── Import SUT after mocks ──────────────────────────────────────────────

import {
  resolveHydeFromAgentConfig,
  createHydeQueryWrapper,
} from '../memory/rag/hyde-integration.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function createMockEmbeddingManager(embedding: number[] = [0.1, 0.2, 0.3]) {
  return {
    initialize: vi.fn(),
    generateEmbeddings: vi.fn().mockResolvedValue({
      embeddings: [embedding],
      modelId: 'test-model',
      providerId: 'test-provider',
      usage: { totalTokens: 10 },
    }),
    getEmbeddingModelInfo: vi.fn(),
    getEmbeddingDimension: vi.fn().mockResolvedValue(3),
    checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  };
}

function createMockVectorStore(docs: any[] = []) {
  return {
    initialize: vi.fn(),
    upsert: vi.fn(),
    query: vi.fn().mockResolvedValue({ documents: docs }),
    delete: vi.fn(),
    checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
    shutdown: vi.fn(),
  };
}

const mockLlmCaller = vi.fn().mockResolvedValue('hypothetical answer');

// ── Tests ───────────────────────────────────────────────────────────────

describe('resolveHydeFromAgentConfig', () => {
  it('returns enabled=true by default when ragConfig has no hyde section', () => {
    const config = resolveHydeFromAgentConfig({});
    expect(config.enabled).toBe(true);
    expect(config.initialThreshold).toBe(0.7);
    expect(config.minThreshold).toBe(0.3);
    expect(config.thresholdStep).toBe(0.1);
    expect(config.adaptiveThreshold).toBe(true);
  });

  it('returns enabled=true by default when ragConfig is undefined', () => {
    const config = resolveHydeFromAgentConfig(undefined);
    expect(config.enabled).toBe(true);
  });

  it('returns enabled=false when explicitly disabled', () => {
    const config = resolveHydeFromAgentConfig({
      hyde: { enabled: false },
    } as any);
    expect(config.enabled).toBe(false);
  });

  it('respects custom threshold values from rag config', () => {
    const config = resolveHydeFromAgentConfig({
      hyde: {
        initialThreshold: 0.8,
        minThreshold: 0.4,
        thresholdStep: 0.05,
      },
    } as any);
    expect(config.initialThreshold).toBe(0.8);
    expect(config.minThreshold).toBe(0.4);
    expect(config.thresholdStep).toBe(0.05);
  });

  it('passes through advanced hypothesis controls from rag config', () => {
    const config = resolveHydeFromAgentConfig({
      hyde: {
        maxHypothesisTokens: 256,
        hypothesisSystemPrompt: 'Custom HyDE prompt',
        fullAnswerGranularity: false,
      },
    } as any);

    expect(config.maxHypothesisTokens).toBe(256);
    expect(config.hypothesisSystemPrompt).toBe('Custom HyDE prompt');
    expect(config.fullAnswerGranularity).toBe(false);
  });
});

describe('createHydeQueryWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('when HyDE is disabled', () => {
    it('returns passthrough query (standard embedding) and null retriever', async () => {
      // resolveHydeConfig mock returns enabled: false by default
      mockResolveHydeConfig.mockReturnValueOnce({
        enabled: false,
        initialThreshold: 0.7,
        minThreshold: 0.3,
        thresholdStep: 0.1,
        adaptiveThreshold: true,
      });

      const embeddingManager = createMockEmbeddingManager();
      const vectorStore = createMockVectorStore([
        {
          id: 'doc-1',
          embedding: [0.1],
          textContent: 'Standard result',
          similarityScore: 0.85,
          metadata: { source: 'test' },
        },
      ]);

      const wrapper = createHydeQueryWrapper({
        vectorStore: vectorStore as any,
        embeddingManager: embeddingManager as any,
        llmCaller: mockLlmCaller,
        collectionName: 'test-collection',
        hydeConfig: { enabled: false },
      });

      expect(wrapper.retriever).toBeNull();

      const result = await wrapper.query('test query', 5);
      expect(result.hydeUsed).toBe(false);
      expect(result.hypothesis).toBeUndefined();
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content).toBe('Standard result');
      expect(result.chunks[0].score).toBe(0.85);

      // Should use direct embedding, not HyDE
      expect(embeddingManager.generateEmbeddings).toHaveBeenCalledWith({
        texts: ['test query'],
      });
      expect(vectorStore.query).toHaveBeenCalledWith(
        'test-collection',
        [0.1, 0.2, 0.3],
        expect.objectContaining({ topK: 5, includeTextContent: true }),
      );
    });

    it('returns empty chunks when embedding fails', async () => {
      mockResolveHydeConfig.mockReturnValueOnce({
        enabled: false,
        initialThreshold: 0.7,
        minThreshold: 0.3,
        thresholdStep: 0.1,
        adaptiveThreshold: true,
      });

      const embeddingManager = createMockEmbeddingManager();
      (embeddingManager.generateEmbeddings as ReturnType<typeof vi.fn>).mockResolvedValue({
        embeddings: [[]],
        modelId: 'test',
        providerId: 'test',
        usage: { totalTokens: 0 },
      });
      const vectorStore = createMockVectorStore();

      const wrapper = createHydeQueryWrapper({
        vectorStore: vectorStore as any,
        embeddingManager: embeddingManager as any,
        llmCaller: mockLlmCaller,
        collectionName: 'test-collection',
        hydeConfig: { enabled: false },
      });

      const result = await wrapper.query('test');
      expect(result.chunks).toEqual([]);
      expect(result.hydeUsed).toBe(false);
    });
  });

  describe('when HyDE is enabled', () => {
    it('uses HydeRetriever and returns hydeUsed=true', async () => {
      mockResolveHydeConfig.mockReturnValueOnce({
        enabled: true,
        initialThreshold: 0.7,
        minThreshold: 0.3,
        thresholdStep: 0.1,
        adaptiveThreshold: true,
      });

      mockRetrieve.mockResolvedValueOnce({
        hypothesis: 'Generated hypothesis',
        hypothesisEmbedding: [0.1, 0.2],
        queryResult: {
          documents: [
            {
              id: 'hyde-doc-1',
              embedding: [0.1],
              textContent: 'HyDE retrieved content',
              similarityScore: 0.92,
              metadata: { tag: 'important' },
            },
          ],
        },
        effectiveThreshold: 0.6,
        thresholdSteps: 1,
        hypothesisLatencyMs: 100,
        retrievalLatencyMs: 50,
      });

      const embeddingManager = createMockEmbeddingManager();
      const vectorStore = createMockVectorStore();

      const wrapper = createHydeQueryWrapper({
        vectorStore: vectorStore as any,
        embeddingManager: embeddingManager as any,
        llmCaller: mockLlmCaller,
        collectionName: 'test-collection',
        hydeConfig: { enabled: true },
      });

      expect(wrapper.retriever).not.toBeNull();

      const result = await wrapper.query('complex query', 3);
      expect(result.hydeUsed).toBe(true);
      expect(result.hypothesis).toBe('Generated hypothesis');
      expect(result.effectiveThreshold).toBe(0.6);
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].content).toBe('HyDE retrieved content');
      expect(result.chunks[0].score).toBe(0.92);

      // HydeRetriever.retrieve should have been called
      expect(mockRetrieve).toHaveBeenCalledWith({
        query: 'complex query',
        vectorStore: expect.anything(),
        collectionName: 'test-collection',
        queryOptions: expect.objectContaining({ topK: 3, includeTextContent: true }),
      });
    });

    it('constructs HydeRetriever with resolved config', () => {
      mockResolveHydeConfig.mockReturnValueOnce({
        enabled: true,
        initialThreshold: 0.8,
        minThreshold: 0.4,
        thresholdStep: 0.05,
        adaptiveThreshold: true,
      });

      const embeddingManager = createMockEmbeddingManager();
      const vectorStore = createMockVectorStore();

      createHydeQueryWrapper({
        vectorStore: vectorStore as any,
        embeddingManager: embeddingManager as any,
        llmCaller: mockLlmCaller,
        collectionName: 'my-collection',
        hydeConfig: { enabled: true, initialThreshold: 0.8 },
      });

      expect(MockHydeRetriever).toHaveBeenCalledWith({
        config: expect.objectContaining({ enabled: true }),
        llmCaller: mockLlmCaller,
        embeddingManager: embeddingManager,
      });
    });

    it('defaults topK to 5 when not provided', async () => {
      mockResolveHydeConfig.mockReturnValueOnce({
        enabled: true,
        initialThreshold: 0.7,
        minThreshold: 0.3,
        thresholdStep: 0.1,
        adaptiveThreshold: true,
      });

      mockRetrieve.mockResolvedValueOnce({
        hypothesis: 'test',
        hypothesisEmbedding: [0.1],
        queryResult: { documents: [] },
        effectiveThreshold: 0.3,
        thresholdSteps: 4,
        hypothesisLatencyMs: 50,
        retrievalLatencyMs: 30,
      });

      const wrapper = createHydeQueryWrapper({
        vectorStore: createMockVectorStore() as any,
        embeddingManager: createMockEmbeddingManager() as any,
        llmCaller: mockLlmCaller,
        collectionName: 'test',
        hydeConfig: { enabled: true },
      });

      await wrapper.query('test');

      expect(mockRetrieve).toHaveBeenCalledWith(
        expect.objectContaining({
          queryOptions: expect.objectContaining({ topK: 5 }),
        }),
      );
    });
  });
});
