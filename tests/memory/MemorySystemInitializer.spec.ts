// @ts-nocheck
// packages/wunderland/tests/memory/MemorySystemInitializer.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { createMemorySystem } from '../../src/memory-new/initialization/MemorySystemInitializer.js';
import type { MemorySystemConfig } from '../../src/memory-new/initialization/MemorySystemInitializer.js';

/** Minimal mock vector store. */
function makeMockVectorStore(results: any[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ results }),
    upsert: vi.fn(),
    delete: vi.fn(),
  } as any;
}

/** Minimal mock GraphRAG engine. */
function makeMockGraphRAG(overrides?: Partial<Awaited<ReturnType<any>>>) {
  return {
    localSearch: vi.fn().mockResolvedValue({
      entities: [{ name: 'Test', description: 'A test entity', relevanceScore: 0.8 }],
      relationships: [],
      contextText: '',
      ...overrides,
    }),
  };
}

/** Minimal mock markdown working memory. */
function makeMockMarkdown(content: string = '') {
  return { read: vi.fn().mockReturnValue(content), write: vi.fn() } as any;
}

/** Build a default MemorySystemConfig with overrides. */
function makeConfig(overrides: Partial<MemorySystemConfig> = {}): MemorySystemConfig {
  return {
    vectorStore: makeMockVectorStore(),
    llm: { providerId: 'openai' },
    agentId: 'test-agent',
    ...overrides,
  };
}

describe('createMemorySystem', () => {
  it('returns object with retrieveForTurn and observe methods', async () => {
    const system = await createMemorySystem(makeConfig());
    expect(system).toHaveProperty('retrieveForTurn');
    expect(system).toHaveProperty('observe');
    expect(typeof system.retrieveForTurn).toBe('function');
    expect(typeof system.observe).toBe('function');
  });

  it('retrieveForTurn returns null when vector store is empty', async () => {
    const system = await createMemorySystem(makeConfig());
    const result = await system.retrieveForTurn('hello');
    expect(result).toBeNull();
  });

  it('retrieveForTurn returns context when vector store has results', async () => {
    const vectorStore = makeMockVectorStore([
      { textContent: 'User prefers dark mode' },
      { textContent: 'User works at Acme Corp' },
    ]);
    const system = await createMemorySystem(makeConfig({ vectorStore }));
    const result = await system.retrieveForTurn('tell me about the user');

    expect(result).not.toBeNull();
    expect(result!.contextText).toContain('## Recalled Memories');
    expect(result!.contextText).toContain('User prefers dark mode');
    expect(result!.contextText).toContain('User works at Acme Corp');
    expect(result!.tokensUsed).toBeGreaterThan(0);
  });

  it('retrieveForTurn includes persistent markdown memory when read() returns content', async () => {
    const markdownMemory = makeMockMarkdown('# Notes\n- User likes dark mode');
    const system = await createMemorySystem(makeConfig({ markdownMemory }));
    const result = await system.retrieveForTurn('preferences');

    expect(result).not.toBeNull();
    expect(result!.contextText).toContain('## Persistent Memory');
    expect(result!.contextText).toContain('User likes dark mode');
  });

  it('retrieveForTurn includes GraphRAG context when localSearch returns entities', async () => {
    const graphRAG = makeMockGraphRAG();
    const system = await createMemorySystem(makeConfig({ graphRAG }));
    const result = await system.retrieveForTurn('what is Test?');

    expect(result).not.toBeNull();
    expect(result!.contextText).toContain('## Knowledge Graph Context');
    expect(result!.contextText).toContain('Test');
    expect(result!.contextText).toContain('A test entity');
    expect(graphRAG.localSearch).toHaveBeenCalledWith('what is Test?', { topK: 5 });
  });

  it('retrieveForTurn handles vector store errors gracefully (returns null)', async () => {
    const vectorStore = {
      query: vi.fn().mockRejectedValue(new Error('connection lost')),
    } as any;
    const system = await createMemorySystem(makeConfig({ vectorStore }));
    const result = await system.retrieveForTurn('anything');

    // The outer try/catch should return null on error
    expect(result).toBeNull();
  });

  it('retrieveForTurn respects token budget limits', async () => {
    // Create a very large memory entry
    const longText = 'A'.repeat(50_000);
    const vectorStore = makeMockVectorStore([{ textContent: longText }]);
    const budget = 100; // Very small budget: 100 tokens
    const system = await createMemorySystem(
      makeConfig({ vectorStore, retrievalBudgetTokens: budget }),
    );
    const result = await system.retrieveForTurn('something');

    if (result) {
      // The recalled section budget is 55% of 100 tokens = 55 tokens = 220 chars
      // The text should be truncated — full text is 50K chars
      expect(result.contextText.length).toBeLessThan(longText.length);
      expect(result.tokensUsed).toBeLessThanOrEqual(budget);
    }
  });

  it('observe is callable without error', async () => {
    const system = await createMemorySystem(makeConfig());
    await expect(system.observe('user', 'hello')).resolves.toBeUndefined();
    await expect(system.observe('assistant', 'hi there')).resolves.toBeUndefined();
  });
});
