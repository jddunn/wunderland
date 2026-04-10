// @ts-nocheck
/**
 * @fileoverview Tests for unified retriever wiring into the agent runtime.
 *
 * Verifies that {@link buildUnifiedRetrieverFromConfig} correctly interprets
 * the `rag.*` config fields and constructs the appropriate retrieval sources.
 *
 * Uses vitest mocks to isolate the builder from actual vector stores, LLM
 * calls, and embedding managers. All external package dependencies are mocked
 * to avoid requiring a build of @framers/agentos.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist mocks ──────────────────────────────────────────────────────────

const {
  MockBM25Index,
  MockHybridSearcher,
  MockRaptorTree,
  MockHydeRetriever,
  MockUnifiedRetriever,
} = vi.hoisted(() => {
  const MockBM25Index = vi.fn().mockImplementation(() => ({
    addDocuments: vi.fn(),
    addDocument: vi.fn(),
    search: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({ documentCount: 0, termCount: 0, avgDocLength: 0 }),
  }));

  const MockHybridSearcher = vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue([]),
  }));

  const MockRaptorTree = vi.fn().mockImplementation(() => ({
    build: vi.fn().mockResolvedValue({ totalLayers: 0, nodesPerLayer: {}, totalNodes: 0, totalClusters: 0, buildTimeMs: 0 }),
    search: vi.fn().mockResolvedValue([]),
  }));

  const MockHydeRetriever = vi.fn().mockImplementation(() => ({
    retrieve: vi.fn().mockResolvedValue({ queryResult: { documents: [] }, hypotheses: [] }),
    enabled: true,
  }));

  const MockUnifiedRetriever = vi.fn().mockImplementation(() => ({
    retrieve: vi.fn().mockResolvedValue({
      chunks: [],
      plan: { strategy: 'simple', sources: {} },
      sourceDiagnostics: {},
      durationMs: 0,
      memoryCacheHit: false,
    }),
  }));

  return {
    MockBM25Index,
    MockHybridSearcher,
    MockRaptorTree,
    MockHydeRetriever,
    MockUnifiedRetriever,
  };
});

// Mock all external package dependencies BEFORE importing the SUT.
// The @framers/agentos package may not have a built dist/ in test environments,
// so we mock both the root and subpath imports.
vi.mock('@framers/agentos', () => ({}));
vi.mock('@framers/agentos/rag', () => ({
  BM25Index: MockBM25Index,
  HybridSearcher: MockHybridSearcher,
  RaptorTree: MockRaptorTree,
  HydeRetriever: MockHydeRetriever,
  UnifiedRetriever: MockUnifiedRetriever,
}));
vi.mock('@framers/agentos/query-router', () => ({
  QueryRouter: vi.fn(),
}));

vi.mock('../runtime/rag-state-persistence.js', () => ({
  loadBM25State: vi.fn().mockResolvedValue(null),
  saveBM25State: vi.fn().mockResolvedValue(true),
  loadRaptorState: vi.fn().mockResolvedValue(null),
  saveRaptorState: vi.fn().mockResolvedValue(true),
  computeCorpusHash: vi.fn().mockReturnValue('mock-hash'),
}));

vi.mock('../api/types.js', () => ({}));
vi.mock('../memory/index.js', () => ({}));

// ── Import SUT after mocks ────────────────────────────────────────────

import {
  buildUnifiedRetrieverFromConfig,
  formatUnifiedRetrievalLog,
} from '../runtime/unified-retriever-builder.js';

// ── Helpers ──────────────────────────────────────────────────────────────

interface MockRagConfig {
  hybrid?: { enabled?: boolean; denseWeight?: number; sparseWeight?: number };
  raptor?: { enabled?: boolean; maxDepth?: number; clusterSize?: number };
  hyde?: {
    enabled?: boolean;
    hypothesisCount?: number;
    initialThreshold?: number;
    minThreshold?: number;
    thresholdStep?: number;
    adaptiveThreshold?: boolean;
    maxHypothesisTokens?: number;
    hypothesisSystemPrompt?: string;
    fullAnswerGranularity?: boolean;
  };
  memoryIntegration?: { enabled?: boolean; feedbackLoop?: boolean; memoryTypes?: string[] };
  chunking?: { strategy?: 'fixed' | 'semantic'; targetSize?: number; overlap?: number };
}

function createMockVectorStore() {
  return {
    query: vi.fn().mockResolvedValue({ documents: [] }),
    upsert: vi.fn().mockResolvedValue({ ids: [] }),
    listDocuments: vi.fn().mockResolvedValue({ documents: [] }),
  };
}

function createMockEmbeddingManager() {
  return {
    generateEmbeddings: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    initialize: vi.fn(),
  };
}

function createMockMemorySystem() {
  return {
    retrieveForTurn: vi.fn().mockResolvedValue(null),
    observe: vi.fn(),
  };
}

const silentLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('buildUnifiedRetrieverFromConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null retriever when no ragConfig is provided', async () => {
    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: undefined,
      logger: silentLogger,
    });

    expect(result.retriever).toBeNull();
    expect(result.activeSources.hybrid).toBe(false);
    expect(result.activeSources.raptor).toBe(false);
    expect(result.activeSources.hyde).toBe(false);
    expect(result.activeSources.memory).toBe(false);
  });

  it('returns null retriever when ragConfig is null', async () => {
    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: null,
      logger: silentLogger,
    });

    expect(result.retriever).toBeNull();
  });

  it('creates hybrid searcher when hybrid.enabled and dependencies available', async () => {
    const ragConfig: MockRagConfig = {
      hybrid: { enabled: true, denseWeight: 0.6, sparseWeight: 0.4 },
    };

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      vectorStore: createMockVectorStore() as any,
      embeddingManager: createMockEmbeddingManager() as any,
      logger: silentLogger,
    });

    expect(result.retriever).not.toBeNull();
    expect(result.activeSources.hybrid).toBe(true);
    expect(MockBM25Index).toHaveBeenCalled();
    expect(MockHybridSearcher).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ denseWeight: 0.6, sparseWeight: 0.4 }),
    );
  });

  it('skips hybrid searcher when vectorStore is missing', async () => {
    const ragConfig: MockRagConfig = {
      hybrid: { enabled: true },
    };

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      embeddingManager: createMockEmbeddingManager() as any,
      logger: silentLogger,
    });

    expect(result.activeSources.hybrid).toBe(false);
    expect(MockHybridSearcher).not.toHaveBeenCalled();
  });

  it('skips hybrid searcher when explicitly disabled', async () => {
    const ragConfig: MockRagConfig = {
      hybrid: { enabled: false },
    };

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      vectorStore: createMockVectorStore() as any,
      embeddingManager: createMockEmbeddingManager() as any,
      logger: silentLogger,
    });

    expect(result.activeSources.hybrid).toBe(false);
    expect(MockHybridSearcher).not.toHaveBeenCalled();
  });

  it('creates RAPTOR tree when raptor.enabled and dependencies available', async () => {
    const ragConfig: MockRagConfig = {
      raptor: { enabled: true, maxDepth: 3, clusterSize: 6 },
    };

    const mockLlmCaller = vi.fn().mockResolvedValue('summary');

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      vectorStore: createMockVectorStore() as any,
      embeddingManager: createMockEmbeddingManager() as any,
      llmCaller: mockLlmCaller,
      logger: silentLogger,
    });

    expect(result.retriever).not.toBeNull();
    expect(result.activeSources.raptor).toBe(true);
    expect(MockRaptorTree).toHaveBeenCalledWith(
      expect.objectContaining({
        maxDepth: 3,
        clusterSize: 6,
      }),
    );
  });

  it('skips RAPTOR when llmCaller is missing', async () => {
    const ragConfig: MockRagConfig = {
      raptor: { enabled: true },
    };

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      vectorStore: createMockVectorStore() as any,
      embeddingManager: createMockEmbeddingManager() as any,
      // no llmCaller
      logger: silentLogger,
    });

    expect(result.activeSources.raptor).toBe(false);
  });

  it('creates HyDE retriever when hyde.enabled and dependencies available', async () => {
    const ragConfig: MockRagConfig = {
      hyde: { enabled: true, hypothesisCount: 5 },
    };

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      embeddingManager: createMockEmbeddingManager() as any,
      llmCaller: vi.fn().mockResolvedValue('hypothesis'),
      logger: silentLogger,
    });

    expect(result.retriever).not.toBeNull();
    expect(result.activeSources.hyde).toBe(true);
    expect(result.hydeHypothesisCount).toBe(5);
    expect(MockHydeRetriever).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ hypothesisCount: 5 }),
      }),
    );
  });

  it('skips HyDE when embeddingManager is missing', async () => {
    const ragConfig: MockRagConfig = {
      hyde: { enabled: true },
    };

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      llmCaller: vi.fn(),
      logger: silentLogger,
    });

    expect(result.activeSources.hyde).toBe(false);
  });

  it('wires memory integration when enabled and memorySystem provided', async () => {
    const ragConfig: MockRagConfig = {
      memoryIntegration: { enabled: true, feedbackLoop: true },
    };

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      memorySystem: createMockMemorySystem() as any,
      vectorStore: createMockVectorStore() as any,
      logger: silentLogger,
    });

    expect(result.activeSources.memory).toBe(true);
  });

  it('skips memory integration when memorySystem is null', async () => {
    const ragConfig: MockRagConfig = {
      memoryIntegration: { enabled: true },
    };

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      memorySystem: null,
      logger: silentLogger,
    });

    expect(result.activeSources.memory).toBe(false);
  });

  it('wires all sources together in a single UnifiedRetriever', async () => {
    const ragConfig: MockRagConfig = {
      hybrid: { enabled: true },
      raptor: { enabled: true },
      hyde: { enabled: true, hypothesisCount: 3 },
      memoryIntegration: { enabled: true },
      chunking: { strategy: 'semantic' },
    };

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      vectorStore: createMockVectorStore() as any,
      embeddingManager: createMockEmbeddingManager() as any,
      memorySystem: createMockMemorySystem() as any,
      llmCaller: vi.fn().mockResolvedValue('response'),
      logger: silentLogger,
    });

    expect(result.retriever).not.toBeNull();
    expect(result.activeSources.hybrid).toBe(true);
    expect(result.activeSources.raptor).toBe(true);
    expect(result.activeSources.hyde).toBe(true);
    expect(result.activeSources.memory).toBe(true);
    expect(result.activeSources.semanticChunking).toBe(true);
    expect(result.bm25Index).toBeDefined();
    expect(result.raptorTree).toBeDefined();
    expect(result.hydeHypothesisCount).toBe(3);
    expect(MockUnifiedRetriever).toHaveBeenCalledTimes(1);
  });

  it('preserves legacy behaviour with empty ragConfig and no deps', async () => {
    const ragConfig: MockRagConfig = {};

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      logger: silentLogger,
    });

    // With empty config and no deps, no sources can be created
    expect(result.retriever).toBeNull();
  });

  it('uses default weights when hybrid config has no weight overrides', async () => {
    const ragConfig: MockRagConfig = {
      hybrid: { enabled: true },
    };

    await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      vectorStore: createMockVectorStore() as any,
      embeddingManager: createMockEmbeddingManager() as any,
      logger: silentLogger,
    });

    expect(MockHybridSearcher).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ denseWeight: 0.7, sparseWeight: 0.3 }),
    );
  });

  it('exposes bm25Index on result when hybrid is active', async () => {
    const ragConfig: MockRagConfig = {
      hybrid: { enabled: true },
    };

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      vectorStore: createMockVectorStore() as any,
      embeddingManager: createMockEmbeddingManager() as any,
      logger: silentLogger,
    });

    expect(result.bm25Index).toBeDefined();
  });

  it('exposes raptorTree on result when raptor is active', async () => {
    const ragConfig: MockRagConfig = {
      raptor: { enabled: true },
    };

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      vectorStore: createMockVectorStore() as any,
      embeddingManager: createMockEmbeddingManager() as any,
      llmCaller: vi.fn().mockResolvedValue('summary'),
      logger: silentLogger,
    });

    expect(result.raptorTree).toBeDefined();
  });

  it('detects semantic chunking from chunking.strategy', async () => {
    const ragConfig: MockRagConfig = {
      hybrid: { enabled: true },
      chunking: { strategy: 'semantic' },
    };

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      vectorStore: createMockVectorStore() as any,
      embeddingManager: createMockEmbeddingManager() as any,
      logger: silentLogger,
    });

    expect(result.activeSources.semanticChunking).toBe(true);
  });

  it('does not flag semantic chunking for fixed strategy', async () => {
    const ragConfig: MockRagConfig = {
      chunking: { strategy: 'fixed' },
    };

    const result = await buildUnifiedRetrieverFromConfig({
      ragConfig: ragConfig as any,
      logger: silentLogger,
    });

    expect(result.activeSources.semanticChunking).toBe(false);
  });
});

describe('formatUnifiedRetrievalLog', () => {
  it('formats all-on result correctly', () => {
    const log = formatUnifiedRetrievalLog({
      retriever: {} as any,
      activeSources: {
        hybrid: true,
        raptor: true,
        hyde: true,
        memory: true,
        semanticChunking: true,
      },
      hydeHypothesisCount: 3,
    });

    expect(log).toContain('hybrid=on');
    expect(log).toContain('raptor=on');
    expect(log).toContain('hyde=3x');
    expect(log).toContain('semantic-chunking');
    expect(log).toContain('memory=on');
  });

  it('formats all-off result correctly', () => {
    const log = formatUnifiedRetrievalLog({
      retriever: null,
      activeSources: {
        hybrid: false,
        raptor: false,
        hyde: false,
        memory: false,
        semanticChunking: false,
      },
    });

    expect(log).toContain('hybrid=off');
    expect(log).toContain('raptor=off');
    expect(log).toContain('hyde=off');
    expect(log).toContain('memory=off');
    expect(log).not.toContain('semantic-chunking');
  });

  it('includes [RAG] prefix', () => {
    const log = formatUnifiedRetrievalLog({
      retriever: null,
      activeSources: {
        hybrid: false,
        raptor: false,
        hyde: false,
        memory: false,
        semanticChunking: false,
      },
    });

    expect(log).toMatch(/^\[RAG\]/);
  });
});
