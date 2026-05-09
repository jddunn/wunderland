// @ts-nocheck
/**
 * @fileoverview Shared types for per-agent storage subsystem.
 * @module wunderland/storage/types
 */

import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { IVectorStore, IGraphRAGEngine } from '@framers/agentos';

/**
 * Key-value state store for per-agent persistent state.
 */
export interface IAgentStateStore {
  initialize(): Promise<void>;
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(prefix?: string): Promise<Array<{ key: string; value: unknown; updatedAt: number }>>;
  clear(): Promise<void>;
}

/**
 * Simplified memory adapter for per-agent conversation storage.
 */
export interface IAgentMemoryAdapter {
  initialize(): Promise<void>;
  storeConversationTurn(
    conversationId: string,
    turn: AgentConversationTurn,
  ): Promise<string>;
  retrieveConversationTurns(
    conversationId: string,
    options?: { limit?: number; beforeTimestamp?: number },
  ): Promise<AgentConversationTurn[]>;
  listConversations(
    limit?: number,
    offset?: number,
  ): Promise<AgentConversationSummary[]>;
  setConversationPersona(conversationId: string, persona: string | null): Promise<void>;
  getConversationPersona(conversationId: string): Promise<string | null>;
  deleteConversation?(conversationId: string): Promise<void>;
  disconnect(): Promise<void>;
}

export interface AgentConversationTurn {
  storageId?: string;
  conversationId?: string;
  agentId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  timestamp: number;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  toolCalls?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
  summary?: string;
}

export interface AgentConversationSummary {
  conversationId: string;
  lastActivity: number;
  agentId?: string;
  summary?: string;
  turnCount?: number;
  persona?: string | null;
}

/**
 * Auto-ingest pipeline processes conversation turns and extracts
 * memories into the vector store.
 */
export interface IMemoryAutoIngestPipeline {
  initialize(): Promise<void>;
  processConversationTurn(
    conversationId: string,
    userMessage: string,
    assistantMessage: string,
  ): Promise<AutoIngestResult>;
}

export interface AutoIngestResult {
  factsExtracted: number;
  factsStored: number;
  factsSkipped: number;
}

export interface ExtractedFact {
  content: string;
  category: 'user_preference' | 'episodic' | 'goal' | 'knowledge' | 'correction';
  importance: number;
  entities?: string[];
}

/**
 * Per-agent storage configuration resolved at runtime.
 */
export interface ResolvedAgentStorageConfig {
  seedId: string;
  backend: 'local' | 'cloud';
  dbPath: string;
  connectionString?: string;
  autoIngest: {
    enabled: boolean;
    importanceThreshold: number;
    maxPerTurn: number;
  };
}

/**
 * Unified orchestrator for all per-agent storage subsystems.
 */
export interface IAgentStorageManager {
  readonly seedId: string;
  readonly adapter: StorageAdapter;

  initialize(): Promise<void>;
  getMemoryAdapter(): IAgentMemoryAdapter;
  getVectorStore(): IVectorStore;
  getGraphRAGEngine(): IGraphRAGEngine | Promise<IGraphRAGEngine>;
  getStateStore(): IAgentStateStore;
  getAutoIngestPipeline(): IMemoryAutoIngestPipeline;
  shutdown(): Promise<void>;
}
