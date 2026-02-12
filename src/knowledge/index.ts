/**
 * @fileoverview Knowledge graph module for Wunderland.
 * Re-exports knowledge graph primitives from AgentOS.
 * @module wunderland/knowledge
 */

export type {
  EntityId,
  RelationId,
  KnowledgeEntity,
  EntityType,
  KnowledgeSource,
  KnowledgeRelation,
  RelationType,
  EpisodicMemory,
  KnowledgeQueryOptions,
  TraversalOptions,
  TraversalResult,
  SemanticSearchOptions,
  SemanticSearchResult,
  KnowledgeGraphStats,
  IKnowledgeGraph,
} from '@framers/agentos';

export { KnowledgeGraph } from '@framers/agentos';
