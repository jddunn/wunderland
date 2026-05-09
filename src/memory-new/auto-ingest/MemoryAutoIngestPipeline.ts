// @ts-nocheck
/**
 * @fileoverview Personality-adaptive memory extraction from conversations.
 * @module wunderland/storage/MemoryAutoIngestPipeline
 *
 * After each assistant turn, extracts candidate facts via a cheap LLM call,
 * scores importance using personality-derived thresholds, and ingests accepted
 * facts into the per-agent vector store.
 */

import type { IVectorStore } from '@framers/agentos';
import type {
  IMemoryAutoIngestPipeline,
  AutoIngestResult,
  ExtractedFact,
  ResolvedAgentStorageConfig,
} from './types.js';
import type { PersonalityMemoryConfig, FactCategory } from './PersonalityMemoryConfig.js';
import { v4 as uuidv4 } from 'uuid';

const COLLECTION_NAME = 'auto_memories';

/**
 * LLM caller function type — injected to avoid hard dependency on specific LLM client.
 */
export type LlmCaller = (systemPrompt: string, userPrompt: string) => Promise<string>;

export interface MemoryAutoIngestPipelineConfig {
  vectorStore: IVectorStore;
  personalityConfig: PersonalityMemoryConfig;
  storageConfig: ResolvedAgentStorageConfig;
  /**
   * Function that calls a cheap/fast LLM for fact extraction.
   * Should use SmallModelResolver or equivalent.
   */
  llmCaller: LlmCaller;
  /**
   * Optional embedding function. If not provided, facts are stored
   * with textContent only (the vector store handles embedding).
   */
  embedFn?: (text: string) => Promise<number[]>;
  /** Agent ID for metadata tagging. */
  agentId: string;
  /**
   * Optional CognitiveMemoryManager. When present, facts route through
   * encode() instead of vectorStore.upsert() for cognitive mechanism support
   * (reconsolidation, schema encoding, source confidence tracking, etc.).
   */
  cognitiveMemoryManager?: {
    encode(
      input: string,
      mood: { valence: number; arousal: number; dominance: number },
      gmiMood: string,
      options?: {
        type?: string;
        scope?: string;
        scopeId?: string;
        sourceType?: string;
        contentSentiment?: number;
        tags?: string[];
        entities?: string[];
      },
    ): Promise<any>;
  };
  /** Mood provider for cognitive encoding. */
  moodProvider?: () => { valence: number; arousal: number; dominance: number };
}

/** Maps auto-ingest fact categories to MemoryTrace types and source types. */
const CATEGORY_TYPE_MAP: Record<string, { type: string; sourceType: string }> = {
  user_preference: { type: 'semantic', sourceType: 'user_statement' },
  knowledge: { type: 'semantic', sourceType: 'agent_inference' },
  episodic: { type: 'episodic', sourceType: 'observation' },
  goal: { type: 'episodic', sourceType: 'user_statement' },
  correction: { type: 'semantic', sourceType: 'user_statement' },
};

const DEFAULT_MOOD = { valence: 0, arousal: 0, dominance: 0 };

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Given a conversation exchange between a user and an assistant, extract important facts worth remembering for future conversations.

For each fact, output a JSON array of objects with these fields:
- "content": the fact in a concise, standalone sentence
- "category": one of "user_preference", "episodic", "goal", "knowledge", "correction"
- "importance": a float 0.0-1.0 (how important is this to remember?)
- "entities": optional array of key entity names mentioned

Rules:
- Only extract facts that would be useful in future conversations
- Prefer concise, specific facts over vague summaries
- "correction" category is for when the user corrects a previous misunderstanding
- "user_preference" for stated likes, dislikes, habits, preferences
- "goal" for stated goals, plans, intentions
- "episodic" for notable events or experiences mentioned
- "knowledge" for factual information shared
- Return an empty array [] if nothing worth remembering
- NEVER store raw profanity, slurs, or insults as user facts. Users may express frustration toward the AI — this is normal human behavior, not a user attribute. Summarize the emotional context instead (e.g., "user was frustrated with response quality" NOT "user called assistant a [slur]")
- Distinguish between statements ABOUT the user vs statements DIRECTED AT the AI. "I'm a software engineer" is a user fact. "You're useless" is feedback about the assistant, not a user attribute
- Do NOT store anything that could be used to characterize or incriminate the user based on their emotional outbursts toward an AI

Output ONLY valid JSON array, no markdown or explanation.`;

export class MemoryAutoIngestPipeline implements IMemoryAutoIngestPipeline {
  private readonly config: MemoryAutoIngestPipelineConfig;
  private readonly personalityConfig: PersonalityMemoryConfig;
  private _initialized = false;

  constructor(config: MemoryAutoIngestPipelineConfig) {
    this.config = config;
    this.personalityConfig = config.personalityConfig;
  }

  async initialize(): Promise<void> {
    if (this._initialized) return;

    // Ensure the auto_memories collection exists
    if (this.config.vectorStore.createCollection) {
      const exists = await this.config.vectorStore.collectionExists?.(COLLECTION_NAME);
      if (!exists) {
        await this.config.vectorStore.createCollection(COLLECTION_NAME, 1536);
      }
    }

    this._initialized = true;
  }

  async processConversationTurn(
    conversationId: string,
    userMessage: string,
    assistantMessage: string,
  ): Promise<AutoIngestResult> {
    const result: AutoIngestResult = { factsExtracted: 0, factsStored: 0, factsSkipped: 0 };

    if (!this.config.storageConfig.autoIngest.enabled) {
      return result;
    }

    // Extract facts via cheap LLM call
    let facts: ExtractedFact[];
    try {
      facts = await this.extractFacts(userMessage, assistantMessage);
    } catch {
      // LLM call failed — skip silently (non-critical path)
      return result;
    }

    result.factsExtracted = facts.length;

    // Filter by personality-derived config
    const enabledCategories = new Set(this.personalityConfig.enabledCategories);
    const maxPerTurn = Math.min(
      this.personalityConfig.maxMemoriesPerTurn,
      this.config.storageConfig.autoIngest.maxPerTurn,
    );

    const accepted: ExtractedFact[] = [];
    for (const fact of facts) {
      if (accepted.length >= maxPerTurn) break;

      // Category filter
      if (!enabledCategories.has(fact.category as FactCategory)) {
        result.factsSkipped++;
        continue;
      }

      // Apply personality category boost
      const boost = this.personalityConfig.categoryBoosts[fact.category as FactCategory] ?? 0;
      const adjustedImportance = Math.min(1, fact.importance + boost);

      // Importance threshold (use the lower of personality-derived and config override)
      const threshold = Math.min(
        this.personalityConfig.importanceThreshold,
        this.config.storageConfig.autoIngest.importanceThreshold,
      );

      if (adjustedImportance < threshold) {
        result.factsSkipped++;
        continue;
      }

      fact.importance = adjustedImportance;
      accepted.push(fact);
    }

    // Ingest accepted facts
    if (accepted.length > 0) {
      if (this.config.cognitiveMemoryManager) {
        // Bridge: route through CognitiveMemoryManager.encode() for mechanism support
        const mood = this.config.moodProvider?.() ?? DEFAULT_MOOD;
        for (const fact of accepted) {
          try {
            const mapping = CATEGORY_TYPE_MAP[fact.category] ?? CATEGORY_TYPE_MAP.episodic;
            await this.config.cognitiveMemoryManager.encode(
              fact.content,
              mood,
              'NEUTRAL',
              {
                type: mapping.type,
                sourceType: mapping.sourceType,
                entities: fact.entities,
                contentSentiment: fact.importance,
                tags: [fact.category, 'auto_ingest'],
              },
            );
            result.factsStored++;
          } catch {
            result.factsSkipped++;
          }
        }
      } else {
        // Direct vector store path (original behavior)
        try {
          const documents = accepted.map((fact) => ({
            id: uuidv4(),
            embedding: [] as number[],
            textContent: fact.content,
            metadata: {
              category: fact.category,
              importance: fact.importance,
              entities: fact.entities?.join(',') ?? '',
              conversationId,
              agentId: this.config.agentId,
              timestamp: Date.now(),
              source: 'auto_ingest',
            },
          }));

          if (this.config.embedFn) {
            for (const doc of documents) {
              doc.embedding = await this.config.embedFn(doc.textContent!);
            }
          }

          await this.config.vectorStore.upsert(COLLECTION_NAME, documents);
          result.factsStored = accepted.length;
        } catch {
          result.factsSkipped += accepted.length;
        }
      }
    }

    return result;
  }

  private async extractFacts(
    userMessage: string,
    assistantMessage: string,
  ): Promise<ExtractedFact[]> {
    const userPrompt = `User: ${userMessage}\n\nAssistant: ${assistantMessage}`;
    const response = await this.config.llmCaller(EXTRACTION_SYSTEM_PROMPT, userPrompt);

    // Parse JSON response
    const trimmed = response.trim();
    // Handle markdown code blocks
    const jsonStr = trimmed.startsWith('[')
      ? trimmed
      : (trimmed.match(/\[[\s\S]*\]/)?.[0] ?? '[]');

    try {
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter(
          (f: any) =>
            typeof f.content === 'string' &&
            typeof f.category === 'string' &&
            typeof f.importance === 'number',
        )
        .map((f: any) => ({
          content: f.content,
          category: f.category,
          importance: f.importance,
          entities: Array.isArray(f.entities) ? f.entities : undefined,
        }));
    } catch {
      return [];
    }
  }
}
