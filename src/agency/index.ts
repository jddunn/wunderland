/**
 * @fileoverview Agency (multi-agent collectives) module for Wunderland.
 * Re-exports agency primitives from AgentOS.
 * @module wunderland/agency
 */

export type {
  AgencySeatState,
  AgencySeatHistoryEntry,
  AgencyMemoryConfig,
  AgencyMemoryRetentionPolicy,
  AgencySession,
  AgencyUpsertArgs,
  AgencySeatRegistrationArgs,
  AgencyMemoryOperationResult,
  AgencyMemoryQueryOptions,
  AgencyMemoryIngestInput,
  AgencyMemoryChunk,
  AgencyMemoryQueryResult,
  AgencyMemoryStats,
  IAgentCommunicationBus,
  AgentMessage,
  AgentMessageType,
  AgentRequest,
  AgentResponse,
  HandoffContext,
  HandoffResult,
} from '@framers/agentos';

export {
  AgencyRegistry,
  AgencyMemoryManager,
  AgentCommunicationBus,
} from '@framers/agentos';
