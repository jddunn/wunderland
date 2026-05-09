// @ts-nocheck
import { describe, it, expect, vi, afterEach } from 'vitest';

import { AgentMemory } from '@framers/agentos';
import type { ICognitiveMemoryManager } from '@framers/agentos/memory';

import { createWunderlandChatRuntime } from '../channels/api-new/chat-runtime.js';

function createManagerStub(): ICognitiveMemoryManager {
  return {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    encode: vi.fn(),
    retrieve: vi.fn(),
    assembleForPrompt: vi.fn(),
    getMemoryHealth: vi.fn(),
  } as unknown as ICognitiveMemoryManager;
}

describe('createWunderlandChatRuntime memory seam', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('wraps a raw cognitive memory manager into AgentMemory', async () => {
    const manager = createManagerStub();

    const runtime = await createWunderlandChatRuntime({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      memory: manager,
      autoApproveToolCalls: true,
      agentConfig: {
        lazyTools: true,
        extensions: { tools: [], voice: [], productivity: [] },
        discovery: { enabled: false },
      } as any,
    });

    expect(runtime.memory).toBeDefined();
    expect(runtime.memory).toBeInstanceOf(AgentMemory);
    expect(runtime.memory?.raw).toBe(manager);
  });

  it('preserves an existing AgentMemory instance', async () => {
    const memory = AgentMemory.wrap(createManagerStub());

    const runtime = await createWunderlandChatRuntime({
      llm: { providerId: 'openai', apiKey: 'test-key', model: 'gpt-test' },
      memory,
      autoApproveToolCalls: true,
      agentConfig: {
        lazyTools: true,
        extensions: { tools: [], voice: [], productivity: [] },
        discovery: { enabled: false },
      } as any,
    });

    expect(runtime.memory).toBe(memory);
  });
});
