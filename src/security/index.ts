/**
 * @fileoverview Security module exports for Wunderland
 * @module wunderland/security
 */

// Types
export * from './types.js';

// Pre-LLM Classifier (Layer 1)
export {
  PreLLMClassifier,
  type PreLLMClassifierConfig,
} from './PreLLMClassifier.js';

// Dual-LLM Auditor (Layer 2)
export { DualLLMAuditor } from './DualLLMAuditor.js';

// Signed Output Verifier (Layer 3)
export {
  SignedOutputVerifier,
  IntentChainTracker,
} from './SignedOutputVerifier.js';

// Unified Pipeline
export {
  WunderlandSecurityPipeline,
  createProductionSecurityPipeline,
  createDevelopmentSecurityPipeline,
} from './WunderlandSecurityPipeline.js';

// Named Security Tiers (Phase 6)
export {
  type SecurityTierName,
  type SecurityTierConfig,
  SECURITY_TIERS,
  getSecurityTier,
  createPipelineFromTier,
  isValidSecurityTier,
} from './SecurityTiers.js';

// Safe Guardrails
export { SafeGuardrails, type SafeGuardrailsConfig } from './SafeGuardrails.js';

// Folder Permissions
export { type FolderPermissionConfig, validateFolderConfig } from './FolderPermissions.js';
