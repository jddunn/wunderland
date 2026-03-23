// packages/wunderland/tests/memory/TurnMemoryRetriever.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { injectMemoryContext, removeMemoryContext } from '../../src/memory/TurnMemoryRetriever.js';
import type { MemorySystem } from '../../src/memory/MemorySystemInitializer.js';

function mockMemorySystem(result: { contextText: string; tokensUsed: number } | null): MemorySystem {
  return {
    retrieveForTurn: vi.fn().mockResolvedValue(result),
    observe: vi.fn().mockResolvedValue(undefined),
  };
}

describe('injectMemoryContext', () => {
  it('injects memory context after system prompt', async () => {
    const messages = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'hello' },
    ];
    const mem = mockMemorySystem({ contextText: '## Recalled\n- fact 1', tokensUsed: 10 });

    const tokens = await injectMemoryContext(messages as any, mem, 'hello');

    expect(tokens).toBe(10);
    expect(messages.length).toBe(3);
    expect(messages[1].content).toContain('Recalled');
    expect(messages[1].role).toBe('system');
  });

  it('removes previous memory context on re-injection', async () => {
    const messages = [
      { role: 'system', content: 'You are helpful' },
      { role: 'system', content: 'old memory', __wunderland_memory_context__: true },
      { role: 'user', content: 'hello' },
    ];
    const mem = mockMemorySystem({ contextText: '## New', tokensUsed: 5 });

    await injectMemoryContext(messages as any, mem, 'hello');

    expect(messages.length).toBe(3);
    expect(messages[1].content).toBe('## New');
  });

  it('returns 0 and does not inject when no memories found', async () => {
    const messages = [
      { role: 'system', content: 'You are helpful' },
    ];
    const mem = mockMemorySystem(null);

    const tokens = await injectMemoryContext(messages as any, mem, 'hello');

    expect(tokens).toBe(0);
    expect(messages.length).toBe(1);
  });

  it('handles retrieval errors gracefully', async () => {
    const messages = [{ role: 'system', content: 'sys' }];
    const mem: MemorySystem = {
      retrieveForTurn: vi.fn().mockRejectedValue(new Error('fail')),
      observe: vi.fn(),
    };

    const tokens = await injectMemoryContext(messages as any, mem, 'hello');
    expect(tokens).toBe(0);
  });
});

describe('removeMemoryContext', () => {
  it('removes tagged messages', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'system', content: 'mem', __wunderland_memory_context__: true },
      { role: 'user', content: 'hi' },
    ];
    removeMemoryContext(messages as any);
    expect(messages.length).toBe(2);
  });
});
