// @ts-nocheck
/**
 * @fileoverview Tests for MemoryAutoIngestPipeline.
 * Validates fact extraction, personality-based filtering, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MemoryAutoIngestPipeline,
  type LlmCaller,
  type MemoryAutoIngestPipelineConfig,
} from '../../memory/auto-ingest/MemoryAutoIngestPipeline.js';
import type { PersonalityMemoryConfig } from '../../memory/storage/PersonalityMemoryConfig.js';
import type { ResolvedAgentStorageConfig } from '../../memory/storage/types.js';

/** Minimal in-memory vector store mock. */
function createMockVectorStore() {
  const collections = new Map<string, any[]>();
  return {
    collectionExists: vi.fn(async (name: string) => collections.has(name)),
    createCollection: vi.fn(async (name: string) => {
      collections.set(name, []);
    }),
    upsert: vi.fn(async (collection: string, docs: any[]) => {
      const col = collections.get(collection) ?? [];
      col.push(...docs);
      collections.set(collection, col);
    }),
    query: vi.fn(async () => []),
    delete: vi.fn(async () => {}),
    /** Expose internals for assertions. */
    _collections: collections,
  };
}

function createDefaultPersonalityConfig(
  overrides: Partial<PersonalityMemoryConfig> = {},
): PersonalityMemoryConfig {
  return {
    importanceThreshold: 0.3,
    maxMemoriesPerTurn: 5,
    enabledCategories: ['user_preference', 'episodic', 'goal', 'knowledge', 'correction'],
    categoryBoosts: {},
    enableSentimentTracking: false,
    deduplicationThreshold: 0.85,
    compactionIntervalTurns: 50,
    retrievalTopK: 5,
    ...overrides,
  };
}

function createDefaultStorageConfig(
  overrides: Partial<ResolvedAgentStorageConfig['autoIngest']> = {},
): ResolvedAgentStorageConfig {
  return {
    autoIngest: {
      enabled: true,
      maxPerTurn: 5,
      importanceThreshold: 0.3,
      ...overrides,
    },
  } as ResolvedAgentStorageConfig;
}

describe('MemoryAutoIngestPipeline', () => {
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let llmCaller: LlmCaller;

  beforeEach(() => {
    vectorStore = createMockVectorStore();
    llmCaller = vi.fn();
  });

  function createPipeline(overrides: Partial<MemoryAutoIngestPipelineConfig> = {}) {
    return new MemoryAutoIngestPipeline({
      vectorStore: vectorStore as any,
      personalityConfig: createDefaultPersonalityConfig(),
      storageConfig: createDefaultStorageConfig(),
      llmCaller,
      agentId: 'test-agent',
      ...overrides,
    });
  }

  it('processConversationTurn extracts facts via LLM caller', async () => {
    const facts = [
      { content: 'User likes coffee', category: 'user_preference', importance: 0.8 },
      { content: 'User is building an app', category: 'goal', importance: 0.7 },
    ];
    (llmCaller as any).mockResolvedValue(JSON.stringify(facts));

    const pipeline = createPipeline();
    await pipeline.initialize();
    const result = await pipeline.processConversationTurn('conv-1', 'I love coffee', 'Nice!');

    expect(llmCaller).toHaveBeenCalledOnce();
    expect(result.factsExtracted).toBe(2);
    expect(result.factsStored).toBe(2);
    expect(vectorStore.upsert).toHaveBeenCalledOnce();
  });

  it('facts below personality threshold are filtered out', async () => {
    const facts = [
      { content: 'Important fact', category: 'user_preference', importance: 0.9 },
      { content: 'Trivial fact', category: 'knowledge', importance: 0.1 },
    ];
    (llmCaller as any).mockResolvedValue(JSON.stringify(facts));

    const pipeline = createPipeline({
      personalityConfig: createDefaultPersonalityConfig({ importanceThreshold: 0.5 }),
      storageConfig: createDefaultStorageConfig({ importanceThreshold: 0.5 }),
    });
    await pipeline.initialize();
    const result = await pipeline.processConversationTurn('conv-1', 'hello', 'hi');

    expect(result.factsExtracted).toBe(2);
    expect(result.factsStored).toBe(1);
    expect(result.factsSkipped).toBe(1);
  });

  it('empty conversations return empty results', async () => {
    (llmCaller as any).mockResolvedValue('[]');

    const pipeline = createPipeline();
    await pipeline.initialize();
    const result = await pipeline.processConversationTurn('conv-1', '', '');

    expect(result.factsExtracted).toBe(0);
    expect(result.factsStored).toBe(0);
    expect(result.factsSkipped).toBe(0);
  });

  it('LLM extraction failure returns empty results gracefully', async () => {
    (llmCaller as any).mockRejectedValue(new Error('LLM timeout'));

    const pipeline = createPipeline();
    await pipeline.initialize();
    const result = await pipeline.processConversationTurn('conv-1', 'hello', 'hi');

    expect(result.factsExtracted).toBe(0);
    expect(result.factsStored).toBe(0);
    expect(result.factsSkipped).toBe(0);
  });

  it('correct categories are preserved from LLM output', async () => {
    const facts = [
      { content: 'Prefers dark mode', category: 'user_preference', importance: 0.7 },
      { content: 'Had a meeting today', category: 'episodic', importance: 0.5 },
      { content: 'Wants to learn Rust', category: 'goal', importance: 0.8 },
      { content: 'TypeScript 5.4 released', category: 'knowledge', importance: 0.6 },
      { content: 'Name is actually Alex', category: 'correction', importance: 0.9 },
    ];
    (llmCaller as any).mockResolvedValue(JSON.stringify(facts));

    const pipeline = createPipeline();
    await pipeline.initialize();
    const result = await pipeline.processConversationTurn('conv-1', 'input', 'output');

    expect(result.factsExtracted).toBe(5);
    expect(result.factsStored).toBe(5);

    // Verify categories were preserved in the upsert call metadata
    const upsertCall = vectorStore.upsert.mock.calls[0];
    const docs = upsertCall[1];
    const categories = docs.map((d: any) => d.metadata.category);
    expect(categories).toEqual([
      'user_preference',
      'episodic',
      'goal',
      'knowledge',
      'correction',
    ]);
  });

  it('disabled auto-ingest returns empty results without calling LLM', async () => {
    const pipeline = createPipeline({
      storageConfig: createDefaultStorageConfig({ enabled: false } as any),
    });
    await pipeline.initialize();
    const result = await pipeline.processConversationTurn('conv-1', 'hello', 'hi');

    expect(result.factsExtracted).toBe(0);
    expect(llmCaller).not.toHaveBeenCalled();
  });
});
