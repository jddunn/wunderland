// packages/wunderland/src/memory/MemorySystemInitializer.ts
/**
 * Creates the memory retrieval system from existing wunderland infrastructure.
 * Auto-detects embedding provider from agent LLM config.
 */

import type { IVectorStore } from '@framers/agentos';
import type { HexacoTraits, CognitiveMemoryConfig } from '@framers/agentos/memory';
import type { MarkdownWorkingMemory } from '@framers/agentos/memory';

export interface MemorySystemConfig {
  /** Vector store from AgentStorageManager. */
  vectorStore: IVectorStore;
  /** Agent personality traits for memory scoring. */
  traits?: Partial<HexacoTraits>;
  /** LLM config for embedding auto-detection. */
  llm: {
    providerId: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /** Ollama config (if present, use Ollama for embeddings). */
  ollama?: {
    baseUrl?: string;
    embeddingModel?: string;
  };
  /** Persistent markdown working memory instance. */
  markdownMemory?: MarkdownWorkingMemory;
  /** Total token budget for memory retrieval. @default 4000 */
  retrievalBudgetTokens?: number;
  /** Agent ID for scoping. */
  agentId: string;
}

export interface MemorySystem {
  /** Retrieve and assemble memory context for a turn. */
  retrieveForTurn: (userInput: string) => Promise<MemoryTurnResult | null>;
  /** Feed a message to the observation pipeline. */
  observe: (role: 'user' | 'assistant', content: string) => Promise<void>;
}

export interface MemoryTurnResult {
  contextText: string;
  tokensUsed: number;
}

/**
 * Creates a lightweight memory retrieval system.
 * Uses the vector store's full-text search for retrieval (no embedding required),
 * and assembleMemoryContext for prompt formatting.
 */
export async function createMemorySystem(config: MemorySystemConfig): Promise<MemorySystem> {
  const {
    vectorStore,
    traits = {},
    markdownMemory,
    retrievalBudgetTokens = 4000,
    agentId,
  } = config;

  const collectionName = `auto_memories`;

  return {
    async retrieveForTurn(userInput: string): Promise<MemoryTurnResult | null> {
      try {
        // 1. Query vector store for relevant memories
        const results = await vectorStore.query(collectionName, {
          queryText: userInput,
          topK: 10,
          minScore: 0.3,
          filter: {},
        }).catch(() => ({ results: [] }));

        const retrievedTexts: string[] = [];
        for (const r of (results as any)?.results ?? results ?? []) {
          const text = r?.textContent ?? r?.metadata?.content ?? '';
          if (text) retrievedTexts.push(text);
        }

        // 2. Read persistent markdown working memory
        const persistentText = markdownMemory?.read() ?? '';

        // 3. Assemble context
        if (retrievedTexts.length === 0 && !persistentText) return null;

        const sections: string[] = [];

        if (persistentText) {
          // Truncate persistent memory to 5% of budget
          const pmBudget = Math.floor(retrievalBudgetTokens * 0.05) * 4; // chars
          const truncPm = persistentText.length > pmBudget
            ? persistentText.slice(0, pmBudget) + '\n<!-- truncated -->'
            : persistentText;
          sections.push(`## Persistent Memory\n\n${truncPm}`);
        }

        if (retrievedTexts.length > 0) {
          // Truncate retrieved memories to 65% of budget
          const recallBudget = Math.floor(retrievalBudgetTokens * 0.65) * 4;
          let used = 0;
          const included: string[] = [];
          for (const text of retrievedTexts) {
            if (used + text.length > recallBudget) break;
            included.push(`- ${text}`);
            used += text.length;
          }
          if (included.length > 0) {
            sections.push(`## Recalled Memories\n\n${included.join('\n')}`);
          }
        }

        if (sections.length === 0) return null;

        const contextText = sections.join('\n\n');
        const tokensUsed = Math.ceil(contextText.length / 4);

        return { contextText, tokensUsed };
      } catch {
        // Non-fatal — return null on any error
        return null;
      }
    },

    async observe(role: 'user' | 'assistant', content: string): Promise<void> {
      // Observation is already handled by auto-ingest pipeline and memory.observe()
      // This is a passthrough for future CognitiveMemoryManager integration
    },
  };
}
