/**
 * @fileoverview Shared factory for initializing CognitiveMemoryManager
 * in both CLI (chat.ts) and API (chat-runtime.ts) entry points.
 *
 * Only loaded when `cognitiveMechanisms` config is present — dynamic
 * import avoids loading agentos memory modules when unused.
 *
 * Cognitive science foundations:
 * - 8 mechanisms modulated by HEXACO personality traits
 * - See docs/memory/cognitive-mechanisms.md for full reference
 *
 * @module wunderland/memory/CognitiveMemoryInitializer
 */

import type { CognitiveMechanismsConfig } from '@framers/agentos';

/** Input config for cognitive memory initialization. */
export interface CognitiveMemoryInitConfig {
  /** Cognitive mechanisms config from agent.config.json. */
  cognitiveMechanisms: CognitiveMechanismsConfig;
  /** Vector store from AgentStorageManager. */
  vectorStore: import('@framers/agentos').IVectorStore;
  /** Agent HEXACO personality traits. */
  traits: Partial<{
    honesty?: number;
    emotionality?: number;
    extraversion?: number;
    agreeableness?: number;
    conscientiousness?: number;
    openness?: number;
  }>;
  /** Agent seed ID. */
  agentId: string;
  /** LLM provider config for embedding generation. */
  llm: {
    providerId: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /** Mood provider callback (from MoodEngine or default neutral). */
  moodProvider?: () => { valence: number; arousal: number; dominance: number };
}

/** Result of cognitive memory initialization. */
export interface CognitiveMemoryInitResult {
  /** The initialized CognitiveMemoryManager instance. */
  manager: {
    encode: (...args: any[]) => Promise<any>;
    retrieve: (...args: any[]) => Promise<any>;
    assembleForPrompt: (...args: any[]) => Promise<any>;
    observe?: (...args: any[]) => Promise<any>;
    shutdown: () => Promise<void>;
  };
  /** Mood provider (same ref passed in, or a default). */
  moodProvider: () => { valence: number; arousal: number; dominance: number };
}

const DEFAULT_MOOD = { valence: 0, arousal: 0, dominance: 0 };

/**
 * Initialize CognitiveMemoryManager with all dependencies.
 *
 * Uses dynamic imports so the agentos memory modules are only loaded
 * when cognitive mechanisms are actually configured. This keeps the
 * default (no mechanisms) path zero-cost.
 */
export async function initializeCognitiveMemory(
  config: CognitiveMemoryInitConfig,
): Promise<CognitiveMemoryInitResult> {
  // Dynamic imports — only loaded when cognitive mechanisms are requested
  const {
    CognitiveMemoryManager,
    SqliteKnowledgeGraph,
  } = await import('@framers/agentos/memory');

  // Create lightweight knowledge graph (in-memory for now)
  const knowledgeGraph = new SqliteKnowledgeGraph();
  if (typeof (knowledgeGraph as any).initialize === 'function') {
    await (knowledgeGraph as any).initialize();
  }

  // Create embedding manager from LLM config
  const { EmbeddingManager } = await import('@framers/agentos');
  const embeddingManager = new EmbeddingManager();
  try {
    await embeddingManager.initialize(
      { models: [{ modelId: 'default', providerId: config.llm.providerId, dimension: 1536 }] },
    );
  } catch {
    // EmbeddingManager may not need explicit init with some providers
  }

  // Working memory (lightweight in-memory for cognitive pipeline)
  const { InMemoryWorkingMemory } = await import('@framers/agentos');
  const workingMemory = new InMemoryWorkingMemory();

  const moodProvider = config.moodProvider ?? (() => DEFAULT_MOOD);

  // Initialize CognitiveMemoryManager
  const manager = new CognitiveMemoryManager();
  await manager.initialize({
    workingMemory,
    knowledgeGraph,
    vectorStore: config.vectorStore,
    embeddingManager,
    agentId: config.agentId,
    traits: config.traits as any,
    moodProvider: moodProvider as any,
    featureDetectionStrategy: 'keyword',
    cognitiveMechanisms: config.cognitiveMechanisms,
  });

  return { manager: manager as any, moodProvider };
}
