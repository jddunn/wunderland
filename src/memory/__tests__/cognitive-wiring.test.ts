/**
 * @fileoverview Tests for cognitive mechanisms wiring into Wunderland pipeline.
 *
 * Verifies:
 * - Auto-ingest bridge routes facts through CognitiveMemoryManager.encode()
 * - MemorySystem delegates retrieveForTurn + observe through cognitive manager
 * - Backward compatibility when no cognitive manager is present
 *
 * @module wunderland/memory/__tests__/cognitive-wiring.test
 */

import { describe, it, expect, vi } from 'vitest';
import { MemoryAutoIngestPipeline } from '../../storage/MemoryAutoIngestPipeline.js';
import { createMemorySystem } from '../MemorySystemInitializer.js';
import type { PersonalityMemoryConfig } from '../../storage/PersonalityMemoryConfig.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePersonalityConfig(): PersonalityMemoryConfig {
  return {
    importanceThreshold: 0.3,
    maxMemoriesPerTurn: 3,
    enabledCategories: ['user_preference', 'episodic', 'goal', 'knowledge', 'correction'],
    categoryBoosts: {},
    enableSentimentTracking: false,
    deduplicationThreshold: 0.85,
    compactionIntervalTurns: 50,
    retrievalTopK: 10,
  };
}

function makeStorageConfig() {
  return {
    agentId: 'test-agent',
    dbPath: ':memory:',
    backend: 'local' as const,
    autoIngest: { enabled: true, importanceThreshold: 0.3, maxPerTurn: 3 },
  };
}

function makeMockVectorStore() {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    createCollection: vi.fn().mockResolvedValue(undefined),
    collectionExists: vi.fn().mockResolvedValue(true),
    listDocuments: vi.fn().mockResolvedValue({ documents: [] }),
  };
}

// ---------------------------------------------------------------------------
// Auto-Ingest Bridge Tests
// ---------------------------------------------------------------------------

describe('MemoryAutoIngestPipeline cognitive bridge', () => {
  it('calls cognitiveMemoryManager.encode() instead of vectorStore.upsert()', async () => {
    const mockEncode = vi.fn().mockResolvedValue({ id: 'mt_1', content: 'test' });
    const mockManager = { encode: mockEncode };

    const vectorStore = makeMockVectorStore();
    const llmCaller = vi.fn().mockResolvedValue(JSON.stringify([
      { content: 'User likes dark mode', category: 'user_preference', importance: 0.8, entities: ['dark mode'] },
    ]));

    const pipeline = new MemoryAutoIngestPipeline({
      vectorStore: vectorStore as any,
      personalityConfig: makePersonalityConfig(),
      storageConfig: makeStorageConfig() as any,
      llmCaller,
      agentId: 'test-agent',
      cognitiveMemoryManager: mockManager as any,
    });
    await pipeline.initialize();

    const result = await pipeline.processConversationTurn('conv1', 'I prefer dark mode', 'Got it!');

    expect(result.factsStored).toBe(1);
    expect(mockEncode).toHaveBeenCalledOnce();
    expect(vectorStore.upsert).not.toHaveBeenCalled();

    // Verify encode() called with correct type mapping
    const call = mockEncode.mock.calls[0];
    expect(call[0]).toBe('User likes dark mode');
    expect(call[3].type).toBe('semantic'); // user_preference → semantic
    expect(call[3].sourceType).toBe('user_statement');
    expect(call[3].entities).toEqual(['dark mode']);
  });

  it('falls back to vectorStore.upsert() when no manager present', async () => {
    const vectorStore = makeMockVectorStore();
    const llmCaller = vi.fn().mockResolvedValue(JSON.stringify([
      { content: 'User likes dark mode', category: 'user_preference', importance: 0.8 },
    ]));

    const pipeline = new MemoryAutoIngestPipeline({
      vectorStore: vectorStore as any,
      personalityConfig: makePersonalityConfig(),
      storageConfig: makeStorageConfig() as any,
      llmCaller,
      agentId: 'test-agent',
    });
    await pipeline.initialize();

    const result = await pipeline.processConversationTurn('conv1', 'I prefer dark mode', 'Got it!');

    expect(result.factsStored).toBe(1);
    expect(vectorStore.upsert).toHaveBeenCalledOnce();
  });

  it('maps fact categories to correct memory types', async () => {
    const mockEncode = vi.fn().mockResolvedValue({ id: 'mt_1' });
    const mockManager = { encode: mockEncode };

    const llmCaller = vi.fn().mockResolvedValue(JSON.stringify([
      { content: 'fact1', category: 'user_preference', importance: 0.8 },
      { content: 'fact2', category: 'episodic', importance: 0.7 },
      { content: 'fact3', category: 'knowledge', importance: 0.9 },
    ]));

    const pipeline = new MemoryAutoIngestPipeline({
      vectorStore: makeMockVectorStore() as any,
      personalityConfig: makePersonalityConfig(),
      storageConfig: makeStorageConfig() as any,
      llmCaller,
      agentId: 'test-agent',
      cognitiveMemoryManager: mockManager as any,
    });
    await pipeline.initialize();
    await pipeline.processConversationTurn('conv1', 'msg', 'reply');

    expect(mockEncode).toHaveBeenCalledTimes(3);
    expect(mockEncode.mock.calls[0][3].type).toBe('semantic');       // user_preference
    expect(mockEncode.mock.calls[1][3].type).toBe('episodic');       // episodic
    expect(mockEncode.mock.calls[2][3].type).toBe('semantic');       // knowledge
    expect(mockEncode.mock.calls[0][3].sourceType).toBe('user_statement');
    expect(mockEncode.mock.calls[1][3].sourceType).toBe('observation');
    expect(mockEncode.mock.calls[2][3].sourceType).toBe('agent_inference');
  });

  it('handles encode() failure gracefully per-fact', async () => {
    let callCount = 0;
    const mockEncode = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('encode failed');
      return Promise.resolve({ id: 'mt_1' });
    });
    const mockManager = { encode: mockEncode };

    const llmCaller = vi.fn().mockResolvedValue(JSON.stringify([
      { content: 'fact1', category: 'user_preference', importance: 0.8 },
      { content: 'fact2', category: 'episodic', importance: 0.7 },
    ]));

    const pipeline = new MemoryAutoIngestPipeline({
      vectorStore: makeMockVectorStore() as any,
      personalityConfig: makePersonalityConfig(),
      storageConfig: makeStorageConfig() as any,
      llmCaller,
      agentId: 'test-agent',
      cognitiveMemoryManager: mockManager as any,
    });
    await pipeline.initialize();
    const result = await pipeline.processConversationTurn('conv1', 'msg', 'reply');

    expect(result.factsStored).toBe(1);
    expect(result.factsSkipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Memory System Upgrade Tests
// ---------------------------------------------------------------------------

describe('createMemorySystem with cognitiveMemoryManager', () => {
  it('delegates retrieveForTurn to cognitiveMemoryManager.assembleForPrompt', async () => {
    const mockAssemble = vi.fn().mockResolvedValue({
      contextText: '## Relevant Memories\n- remembered something',
      tokensUsed: 50,
      allocation: {},
      includedMemoryIds: ['mt_1'],
    });
    const mockManager = { assembleForPrompt: mockAssemble };

    const system = await createMemorySystem({
      vectorStore: makeMockVectorStore() as any,
      llm: { providerId: 'openai' },
      agentId: 'test',
      cognitiveMemoryManager: mockManager as any,
      moodProvider: () => ({ valence: 0, arousal: 0, dominance: 0 }),
    });

    const result = await system.retrieveForTurn('what do you remember?');
    expect(result).not.toBeNull();
    expect(result!.contextText).toContain('Relevant Memories');
    expect(mockAssemble).toHaveBeenCalledOnce();
  });

  it('delegates observe to cognitiveMemoryManager.observe', async () => {
    const mockObserve = vi.fn().mockResolvedValue([]);
    const mockManager = {
      assembleForPrompt: vi.fn().mockResolvedValue(null),
      observe: mockObserve,
    };

    const system = await createMemorySystem({
      vectorStore: makeMockVectorStore() as any,
      llm: { providerId: 'openai' },
      agentId: 'test',
      cognitiveMemoryManager: mockManager as any,
      moodProvider: () => ({ valence: 0, arousal: 0, dominance: 0 }),
    });

    await system.observe('user', 'hello world');
    expect(mockObserve).toHaveBeenCalledWith(
      'user',
      'hello world',
      { valence: 0, arousal: 0, dominance: 0 },
    );
  });

  it('falls back to vector search when no manager present', async () => {
    const system = await createMemorySystem({
      vectorStore: makeMockVectorStore() as any,
      llm: { providerId: 'openai' },
      agentId: 'test',
    });

    const result = await system.retrieveForTurn('anything');
    expect(result).toBeNull();
  });

  it('observe is no-op when no manager present', async () => {
    const system = await createMemorySystem({
      vectorStore: makeMockVectorStore() as any,
      llm: { providerId: 'openai' },
      agentId: 'test',
    });

    // Should not throw
    await system.observe('user', 'hello');
  });
});
