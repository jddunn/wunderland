/**
 * @fileoverview Provenance & audit trail module for Wunderland.
 * Re-exports provenance primitives from AgentOS.
 * Extends the existing SignedOutputVerifier in security/.
 * @module wunderland/provenance
 */

export type {
  StoragePolicyMode,
  StoragePolicyConfig,
  ProvenanceConfig,
  AgentKeySource,
  AnchorTarget,
  AutonomyConfig,
  ProvenanceSystemConfig,
  ProvenanceEventType,
  SignedEvent,
  AnchorRecord,
  RevisionRecord,
  TombstoneRecord,
  AgentKeyRecord,
  VerificationResult,
  VerificationError,
  VerificationBundle,
  ProofLevel,
  AnchorProviderResult,
  AnchorProvider,
} from '@framers/agentos';

export {
  AgentKeyManager,
  HashChain,
  MerkleTree,
  SignedEventLedger,
  createProvenanceHooks,
  RevisionManager,
  TombstoneManager,
  AutonomyGuard,
  ChainVerifier,
  ConversationVerifier,
  BundleExporter,
  AnchorManager,
  NoneProvider,
  CompositeAnchorProvider,
  createAnchorProvider,
  registerAnchorProviderFactory,
  ProvenanceViolationError,
} from '@framers/agentos';
