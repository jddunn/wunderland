/**
 * @fileoverview RAG (Retrieval Augmented Generation) module for Wunderland.
 * Re-exports core RAG primitives from AgentOS and provides a high-level HTTP client
 * for interacting with the backend RAG API.
 * @module wunderland/rag
 */

// Re-export core RAG types and implementations from AgentOS
export type {
  RagDocumentInput,
  RagIngestionOptions,
  RagIngestionResult,
  RagRetrievalOptions,
  RagRetrievalResult,
  RagRetrievedChunk,
  RagMemoryCategory,
  IRetrievalAugmentor,
  IVectorStore,
  IEmbeddingManager,
  IGraphRAGEngine,
  GraphRAGConfig,
  GraphEntity,
  GraphRelationship,
  SqlVectorStoreConfig,
  QdrantVectorStoreConfig,
} from '@framers/agentos';

export {
  RetrievalAugmentor,
  VectorStoreManager,
  EmbeddingManager,
  InMemoryVectorStore,
  SqlVectorStore,
  QdrantVectorStore,
  GraphRAGEngine,
} from '@framers/agentos';

// RAG Audit Trail
export type {
  RAGAuditTrail,
  RAGOperationEntry,
  RAGSourceAttribution,
  RAGAuditCollectorOptions,
} from '@framers/agentos';
export { RAGAuditCollector, RAGOperationHandle } from '@framers/agentos';
export { RAGAuditPersistence } from './RAGAuditPersistence.js';

// Wunderland RAG HTTP client
export { WunderlandRAGClient } from './rag-client.js';
export type {
  RAGClientConfig,
  RAGIngestInput,
  RAGIngestResult,
  RAGQueryInput,
  RAGQueryResult,
  RAGCollection,
  RAGDocument,
  RAGStats,
  RAGHealth,
  MediaIngestInput,
  MediaIngestResult,
  MediaQueryInput,
  MediaQueryByImageInput,
  MediaQueryByAudioInput,
  MediaQueryResult,
  MediaAsset,
  GraphSearchInput,
  GraphSearchResult,
  RAGAuditTrailData,
} from './rag-client.js';
