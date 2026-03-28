// packages/wunderland/src/memory/MemorySystemInitializer.ts
/**
 * Creates the memory retrieval system from existing wunderland infrastructure.
 * Queries vector store + optional GraphRAG for per-turn context injection.
 */

import type { IVectorStore } from '@framers/agentos';
import type { HexacoTraits } from '@framers/agentos/memory';
import type { MarkdownWorkingMemory } from '@framers/agentos/memory';

/** GraphRAG engine interface (lazy-loaded, optional). */
interface IGraphRAGLike {
  localSearch(query: string, options?: { topK?: number }): Promise<{
    entities: Array<{ name: string; description: string; relevanceScore: number }>;
    relationships: Array<{ source: string; target: string; description: string }>;
    contextText: string;
  }>;
}

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
  /** GraphRAG engine for entity-based context (optional). */
  graphRAG?: IGraphRAGLike;
  /** Total token budget for memory retrieval. @default 4000 */
  retrievalBudgetTokens?: number;
  /** Agent ID for scoping. */
  agentId: string;
  /** Optional CognitiveMemoryManager for mechanism-enhanced retrieval. */
  cognitiveMemoryManager?: {
    assembleForPrompt(
      query: string,
      tokenBudget: number,
      mood: { valence: number; arousal: number; dominance: number },
    ): Promise<{ contextText: string; tokensUsed: number; includedMemoryIds: string[] } | null>;
    observe?(
      role: 'user' | 'assistant' | 'system' | 'tool',
      content: string,
      mood?: { valence: number; arousal: number; dominance: number },
    ): Promise<any>;
  };
  /** Mood provider for cognitive retrieval. */
  moodProvider?: () => { valence: number; arousal: number; dominance: number };
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
    markdownMemory,
    graphRAG,
    retrievalBudgetTokens = 4000,
  } = config;

  const collectionName = `auto_memories`;
  const cogMgr = config.cognitiveMemoryManager;
  const moodProvider = config.moodProvider ?? (() => ({ valence: 0, arousal: 0, dominance: 0 }));

  return {
    async retrieveForTurn(userInput: string): Promise<MemoryTurnResult | null> {
      // Cognitive path: delegate to CognitiveMemoryManager
      if (cogMgr) {
        try {
          const mood = moodProvider();
          const result = await cogMgr.assembleForPrompt(userInput, retrievalBudgetTokens, mood);
          if (!result?.contextText?.trim()) return null;
          return { contextText: result.contextText, tokensUsed: result.tokensUsed };
        } catch {
          return null;
        }
      }

      // Fallback: existing vector search path
      try {
        // 1. Query vector store for relevant memories (text-based search)
        const retrievedTexts: string[] = [];
        try {
          // Use listDocuments with text filter as fallback for stores without embedding
          const docs = await (vectorStore as any).listDocuments?.(collectionName, {
            filter: { $textSearch: userInput },
            limit: 10,
          }) ?? { documents: [] };
          for (const doc of docs?.documents ?? []) {
            const text = doc?.textContent ?? doc?.metadata?.content ?? '';
            if (text) retrievedTexts.push(text);
          }
        } catch {
          // Vector store query not supported — skip
        }

        // 2. Query GraphRAG for entity-based context (optional)
        let graphContext = '';
        if (graphRAG) {
          try {
            const graphResult = await graphRAG.localSearch(userInput, { topK: 5 });
            if (graphResult.contextText) {
              graphContext = graphResult.contextText;
            } else if (graphResult.entities.length > 0) {
              const entityLines = graphResult.entities
                .slice(0, 5)
                .map(e => `- **${e.name}**: ${e.description}`);
              const relLines = graphResult.relationships
                .slice(0, 5)
                .map(r => `- ${r.source} → ${r.target}: ${r.description}`);
              graphContext = [...entityLines, ...relLines].join('\n');
            }
          } catch {
            // GraphRAG query failed — continue without it
          }
        }

        // 3. Read persistent markdown working memory
        const persistentText = markdownMemory?.read() ?? '';

        // 4. Assemble context
        if (retrievedTexts.length === 0 && !persistentText && !graphContext) return null;

        const sections: string[] = [];

        if (persistentText) {
          const pmBudget = Math.floor(retrievalBudgetTokens * 0.05) * 4;
          const truncPm = persistentText.length > pmBudget
            ? persistentText.slice(0, pmBudget) + '\n<!-- truncated -->'
            : persistentText;
          sections.push(`## Persistent Memory\n\n${truncPm}`);
        }

        if (retrievedTexts.length > 0) {
          const recallBudget = Math.floor(retrievalBudgetTokens * 0.55) * 4;
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

        if (graphContext) {
          const graphBudget = Math.floor(retrievalBudgetTokens * 0.10) * 4;
          const truncGraph = graphContext.length > graphBudget
            ? graphContext.slice(0, graphBudget) + '\n<!-- truncated -->'
            : graphContext;
          sections.push(`## Knowledge Graph Context\n\n${truncGraph}`);
        }

        if (sections.length === 0) return null;

        const contextText = sections.join('\n\n');
        const tokensUsed = Math.ceil(contextText.length / 4);

        return { contextText, tokensUsed };
      } catch {
        return null;
      }
    },

    async observe(role: 'user' | 'assistant', content: string): Promise<void> {
      if (cogMgr?.observe) {
        const mood = moodProvider();
        await cogMgr.observe(role, content, mood);
      }
      // When no cognitive manager, this remains a no-op (auto-ingest handles extraction separately)
    },
  };
}
