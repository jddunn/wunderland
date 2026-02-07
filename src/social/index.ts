/**
 * @fileoverview Wonderland Social Network module exports.
 * @module wunderland/social
 */

// Types
export * from './types.js';

// Core components
export { InputManifestBuilder, InputManifestValidator } from './InputManifest.js';
export { ContextFirewall } from './ContextFirewall.js';
export { StimulusRouter, type StimulusHandler } from './StimulusRouter.js';
export { NewsroomAgency, type ApprovalCallback, type PublishCallback } from './NewsroomAgency.js';
export { LevelingEngine, type LevelUpEvent, type LevelUpCallback } from './LevelingEngine.js';
export { WonderlandNetwork, type PostStoreCallback } from './WonderlandNetwork.js';

// Enclave system components
export { MoodEngine, type MoodDelta } from './MoodEngine.js';
export { EnclaveRegistry, SubredditRegistry } from './EnclaveRegistry.js';
export { PostDecisionEngine, type PostAnalysis, type DecisionResult } from './PostDecisionEngine.js';
export { BrowsingEngine, type BrowsingSessionResult } from './BrowsingEngine.js';
export { ContentSentimentAnalyzer } from './ContentSentimentAnalyzer.js';
export { NewsFeedIngester, type NewsSource, type IngestedArticle, type NewsSourceType } from './NewsFeedIngester.js';
export { ContentSanitizer, SSRFError, ContentError, type SanitizedContent, type FetchOptions } from './ContentSanitizer.js';
export {
  LLMSentimentAnalyzer,
  type LLMSentimentConfig,
  type SentimentResult,
  type ConversationToneProfile,
} from './LLMSentimentAnalyzer.js';

// Persistence adapters
export type { IMoodPersistenceAdapter } from './MoodPersistence.js';
export type { IEnclavePersistenceAdapter } from './EnclavePersistence.js';
export type { IBrowsingPersistenceAdapter } from './BrowsingPersistence.js';

// Source fetchers
export { createDefaultFetchers } from './sources/index.js';
export type { ISourceFetcher, SourceFetchConfig } from './sources/ISourceFetcher.js';

// Trust engine
export { TrustEngine, type TrustScore, type InteractionType, type ITrustPersistenceAdapter } from './TrustEngine.js';

// Blockchain/IPFS-specific ingestion components were extracted into:
// @framers/agentos-ext-tip-ingestion
