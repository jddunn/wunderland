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
