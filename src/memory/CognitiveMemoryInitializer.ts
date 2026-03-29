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

import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    SqliteBrain,
  } = await import('@framers/agentos/memory');
  const { InMemoryWorkingMemory } = await import(
    '@framers/agentos/cognitive_substrate/memory/InMemoryWorkingMemory'
  );

  const brainDir = join(tmpdir(), 'wunderland-cognitive-memory');
  await mkdir(brainDir, { recursive: true });
  const brain = await SqliteBrain.open(join(brainDir, `${config.agentId}.sqlite`));
  const knowledgeGraph = new SqliteKnowledgeGraph(brain);
  await knowledgeGraph.initialize();

  // Create embedding manager from LLM config
  const { AIModelProviderManager, EmbeddingManager } = await import('@framers/agentos');
  const providerManager = new AIModelProviderManager();
  await providerManager.initialize({
    providers: [
      {
        providerId: config.llm.providerId,
        enabled: true,
        isDefault: true,
        config: {
          apiKey: config.llm.apiKey,
          ...(config.llm.baseUrl ? { baseURL: config.llm.baseUrl, baseUrl: config.llm.baseUrl } : {}),
        },
      },
    ],
  });

  const embeddingManager = new EmbeddingManager();
  await embeddingManager.initialize(
    {
      defaultModelId: 'default',
      embeddingModels: [
        {
          modelId: 'default',
          providerId: config.llm.providerId,
          dimension: 1536,
          isDefault: true,
        },
      ],
    },
    providerManager,
  );

  // Working memory (lightweight in-memory for cognitive pipeline)
  const workingMemory = new InMemoryWorkingMemory();
  await workingMemory.initialize(config.agentId);

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

  return {
    manager: {
      encode: (...args: any[]) => (manager.encode as any).apply(manager, args),
      retrieve: (...args: any[]) => (manager.retrieve as any).apply(manager, args),
      assembleForPrompt: (...args: any[]) => (manager.assembleForPrompt as any).apply(manager, args),
      ...(typeof (manager as any).observe === 'function'
        ? {
            observe: (...args: any[]) => (manager as any).observe.apply(manager, args),
          }
        : {}),
      shutdown: async () => {
        await manager.shutdown();
        await brain.close();
      },
    },
    moodProvider,
  };
}
