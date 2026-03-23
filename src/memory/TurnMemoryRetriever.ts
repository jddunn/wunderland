// packages/wunderland/src/memory/TurnMemoryRetriever.ts
/**
 * Injects memory context into a message array before the LLM turn.
 * Manages insertion and removal of memory context messages.
 */

import type { MemorySystem } from './MemorySystemInitializer.js';

const MEMORY_CONTEXT_TAG = '__wunderland_memory_context__';

export interface MessageLike {
  role: string;
  content: string;
  [key: string]: unknown;
}

/**
 * Retrieves memory context and injects it into the message array.
 * Removes any previous memory context message first.
 * Returns the number of tokens used, or 0 if no context was injected.
 */
export async function injectMemoryContext(
  messages: MessageLike[],
  memorySystem: MemorySystem,
  userInput: string,
): Promise<number> {
  // Remove previous memory context message
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any)[MEMORY_CONTEXT_TAG]) {
      messages.splice(i, 1);
    }
  }

  const result = await memorySystem.retrieveForTurn(userInput);
  if (!result || !result.contextText) return 0;

  // Insert after system prompt (index 1)
  const insertIdx = Math.min(1, messages.length);
  messages.splice(insertIdx, 0, {
    role: 'system',
    content: result.contextText,
    [MEMORY_CONTEXT_TAG]: true,
  });

  return result.tokensUsed;
}

/**
 * Removes memory context messages from a message array.
 */
export function removeMemoryContext(messages: MessageLike[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any)[MEMORY_CONTEXT_TAG]) {
      messages.splice(i, 1);
    }
  }
}
