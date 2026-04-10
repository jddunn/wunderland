// @ts-nocheck
/**
 * @fileoverview Per-agent storage orchestrator.
 * @module wunderland/storage/AgentStorageManager
 *
 * Creates one SQLite file per agent at `~/.wunderland/agents/{seedId}/agent.db`.
 * All subsystems (memory, vectors, GraphRAG, state) share one StorageAdapter.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';
import { SqlVectorStore } from '@framers/agentos';
import type { IVectorStore, IGraphRAGEngine } from '@framers/agentos';
import { AgentMemoryAdapter } from './AgentMemoryAdapter.js';
import { AgentStateStore } from './AgentStateStore.js';
import type {
  IAgentStorageManager,
  IAgentMemoryAdapter,
  IAgentStateStore,
  IMemoryAutoIngestPipeline,
  ResolvedAgentStorageConfig,
} from './types.js';

export class AgentStorageManager implements IAgentStorageManager {
  readonly seedId: string;
  private _adapter: StorageAdapter | null = null;
  private _memoryAdapter: AgentMemoryAdapter | null = null;
  private _vectorStore: IVectorStore | null = null;
  private _graphRAGEngine: IGraphRAGEngine | null = null;
  private _stateStore: AgentStateStore | null = null;
  private _autoIngestPipeline: IMemoryAutoIngestPipeline | null = null;
  private _initialized = false;
  private readonly config: ResolvedAgentStorageConfig;

  constructor(config: ResolvedAgentStorageConfig) {
    this.seedId = config.seedId;
    this.config = config;
  }

  get adapter(): StorageAdapter {
    if (!this._adapter) throw new Error('AgentStorageManager not initialized. Call initialize() first.');
    return this._adapter;
  }

  async initialize(): Promise<void> {
    if (this._initialized) return;

    if (this.config.backend === 'local') {
      // Ensure directory exists
      const dir = this.config.dbPath.replace(/\/[^/]+$/, '');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      this._adapter = await resolveStorageAdapter({
        filePath: this.config.dbPath,
        priority: ['better-sqlite3', 'sqljs'],
      });
      await this._adapter.open({ filePath: this.config.dbPath });
    } else {
      // Cloud backend (Postgres/Supabase)
      this._adapter = await resolveStorageAdapter({
        postgres: {
          connectionString: this.config.connectionString
            || process.env['DATABASE_URL'],
        },
        priority: ['postgres'],
      });
      await this._adapter.open({
        connectionString: this.config.connectionString
          || process.env['DATABASE_URL'],
      });
    }

    // Enable WAL mode for SQLite (better concurrent reads)
    if (this._adapter.capabilities.has('wal')) {
      await this._adapter.exec('PRAGMA journal_mode=WAL;').catch(() => {});
    }

    // Initialize subsystems
    this._memoryAdapter = new AgentMemoryAdapter(this._adapter, this.seedId);
    await this._memoryAdapter.initialize();

    this._stateStore = new AgentStateStore(this._adapter);
    await this._stateStore.initialize();

    // SqlVectorStore — pass pre-initialized adapter
    const vectorStore = new SqlVectorStore();
    await vectorStore.initialize({
      id: 'agent-vector-store',
      type: 'sql',
      adapter: this._adapter,
      tablePrefix: 'rag_',
      defaultEmbeddingDimension: 1536,
      enableFullTextSearch: true,
    } as any);
    this._vectorStore = vectorStore;

    // GraphRAGEngine — lazy-load to avoid bundling graphology when unused
    // Initialized on first access via getGraphRAGEngine()

    this._initialized = true;
  }

  getMemoryAdapter(): IAgentMemoryAdapter {
    if (!this._memoryAdapter) throw new Error('Storage not initialized');
    return this._memoryAdapter;
  }

  getVectorStore(): IVectorStore {
    if (!this._vectorStore) throw new Error('Storage not initialized');
    return this._vectorStore;
  }

  async getGraphRAGEngine(): Promise<IGraphRAGEngine> {
    if (this._graphRAGEngine) return this._graphRAGEngine;
    if (!this._adapter) throw new Error('Storage not initialized');

    // Lazy-load GraphRAGEngine
    const { GraphRAGEngine } = await import('@framers/agentos');
    const engine = new GraphRAGEngine({
      vectorStore: this._vectorStore ?? undefined,
      persistenceAdapter: this._adapter as any, // StorageAdapter satisfies PersistenceAdapter
    });
    await engine.initialize({
      tablePrefix: 'graphrag_',
      entityExtractionModel: 'auto',
      communityDetection: { algorithm: 'louvain' },
    } as any);
    this._graphRAGEngine = engine;
    return engine;
  }

  getStateStore(): IAgentStateStore {
    if (!this._stateStore) throw new Error('Storage not initialized');
    return this._stateStore;
  }

  getAutoIngestPipeline(): IMemoryAutoIngestPipeline {
    if (!this._autoIngestPipeline) throw new Error('Auto-ingest pipeline not set. Call setAutoIngestPipeline() first.');
    return this._autoIngestPipeline;
  }

  /**
   * Set the auto-ingest pipeline (created externally with personality config).
   */
  setAutoIngestPipeline(pipeline: IMemoryAutoIngestPipeline): void {
    this._autoIngestPipeline = pipeline;
  }

  async shutdown(): Promise<void> {
    if (this._graphRAGEngine) {
      await this._graphRAGEngine.shutdown().catch(() => {});
    }
    if (this._vectorStore) {
      await this._vectorStore.shutdown().catch(() => {});
    }
    if (this._adapter) {
      await this._adapter.close().catch(() => {});
    }
    this._initialized = false;
  }
}

/**
 * Resolve per-agent storage configuration from WunderlandAgentConfig.
 */
export function resolveAgentStorageConfig(
  seedId: string,
  storageConfig?: {
    backend?: 'local' | 'cloud';
    dbPath?: string;
    connectionString?: string;
    autoIngest?: {
      enabled?: boolean;
      importanceThreshold?: number;
      maxPerTurn?: number;
    };
  },
): ResolvedAgentStorageConfig {
  const backend = storageConfig?.backend ?? 'local';
  const defaultDbPath = join(
    homedir(),
    '.wunderland',
    'agents',
    seedId,
    'agent.db',
  );

  return {
    seedId,
    backend,
    dbPath: storageConfig?.dbPath ?? defaultDbPath,
    connectionString: storageConfig?.connectionString,
    autoIngest: {
      enabled: storageConfig?.autoIngest?.enabled ?? true,
      importanceThreshold: storageConfig?.autoIngest?.importanceThreshold ?? 0.4,
      maxPerTurn: storageConfig?.autoIngest?.maxPerTurn ?? 3,
    },
  };
}
