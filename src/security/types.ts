/**
 * @fileoverview Security types for Wunderland
 * @module wunderland/security/types
 */

import { GuardrailAction } from '@framers/agentos/core/guardrails/index';
export { GuardrailAction };
import type { SignedAgentOutput } from '../core/types.js';
export type { IntentChainEntry } from '../core/types.js';

// ============================================================================
// Pre-LLM Classification
// ============================================================================

/**
 * Classification category for pre-LLM analysis.
 */
export type InputClassificationCategory =
  | 'SAFE'
  | 'SUSPICIOUS'
  | 'MALICIOUS'
  | 'REQUIRES_REVIEW';

/**
 * Result of pre-LLM input classification.
 */
export interface InputClassificationResult {
  /** Classification category */
  category: InputClassificationCategory;

  /** Risk score (0.0 - 1.0) */
  riskScore: number;

  /** Patterns detected */
  detectedPatterns: DetectedPattern[];

  /** Whether HITL review is required */
  requiresHITL: boolean;

  /** Recommended authorization tier (if requires review) */
  recommendedTier?: number;

  /** Explanation for classification */
  explanation: string;
}

/**
 * A detected pattern in input analysis.
 */
export interface DetectedPattern {
  /** Pattern name/identifier */
  patternId: string;

  /** Pattern type */
  type: 'injection' | 'jailbreak' | 'sensitive_data' | 'command' | 'custom';

  /** Matched text */
  matchedText: string;

  /** Confidence score (0.0 - 1.0) */
  confidence: number;

  /** Start index in original text */
  startIndex: number;

  /** End index in original text */
  endIndex: number;
}

/**
 * Known injection pattern definition.
 */
export interface InjectionPattern {
  /** Pattern identifier */
  id: string;

  /** Pattern name */
  name: string;

  /** Regular expression pattern */
  regex: RegExp;

  /** Base risk score for this pattern */
  baseRiskScore: number;

  /** Pattern description */
  description: string;
}

// ============================================================================
// Dual-LLM Audit
// ============================================================================

/**
 * Audit result from dual-LLM verification.
 */
export interface AuditResult {
  /** Whether the output passed audit */
  passed: boolean;

  /** Severity of any issues found */
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';

  /** Flags raised during audit */
  flags: AuditFlag[];

  /** Explanation from auditor model */
  explanation: string;

  /** Confidence in the audit result */
  confidence: number;

  /** Model used for audit */
  auditorModel: string;

  /** Time taken for audit (ms) */
  auditTimeMs: number;
}

/**
 * A flag raised during audit.
 */
export interface AuditFlag {
  /** Flag identifier */
  flagId: string;

  /** Flag type */
  type: 'intent_mismatch' | 'safety_concern' | 'policy_violation' | 'hallucination' | 'data_leak' | 'custom';

  /** Description of the issue */
  description: string;

  /** Severity */
  severity: 'low' | 'medium' | 'high' | 'critical';

  /** Relevant text that triggered the flag */
  relevantText?: string;
}

/**
 * Configuration for the dual-LLM auditor.
 */
export interface DualLLMAuditorConfig {
  /** Auditor model provider */
  auditorProviderId: string;

  /** Auditor model ID */
  auditorModelId: string;

  /** Maximum tokens for audit response */
  maxAuditTokens: number;

  /** Temperature for audit (should be low for consistency) */
  auditTemperature: number;

  /** Whether to evaluate streaming chunks */
  evaluateStreamingChunks: boolean;

  /** Maximum evaluations per stream */
  maxStreamingEvaluations?: number;

  /** Audit prompt template */
  auditPromptTemplate?: string;
}

// ============================================================================
// Output Signing
// ============================================================================

/**
 * Configuration for output signing.
 */
export interface OutputSigningConfig {
  /** Algorithm for signing */
  algorithm: 'sha256' | 'sha384' | 'sha512';

  /** Environment variable containing the secret key */
  secretKeyEnvVar: string;

  /** Whether to include full intent chain */
  includeIntentChain: boolean;

  /** Maximum intent chain entries to include */
  maxIntentChainEntries?: number;
}

/**
 * Signing context for output verification.
 */
export interface SigningContext {
  /** Seed ID */
  seedId: string;

  /** User ID */
  userId?: string;

  /** Session ID */
  sessionId?: string;

  /** Request ID */
  requestId?: string;
}

// ============================================================================
// Security Pipeline
// ============================================================================

/**
 * Overall security evaluation result.
 */
export interface SecurityEvaluationResult {
  /** Guardrail action to take */
  action: GuardrailAction;

  /** Pre-LLM classification result */
  classification?: InputClassificationResult;

  /** Dual-LLM audit result */
  auditResult?: AuditResult;

  /** Signed output (if signing enabled) */
  signedOutput?: SignedAgentOutput;

  /** Combined reason for action */
  reason?: string;

  /** Reason code for programmatic handling */
  reasonCode?: string;

  /** Modified text (if sanitization applied) */
  modifiedText?: string;

  /** Metadata for logging/observability */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for the full security pipeline.
 */
export interface SecurityPipelineConfig {
  /** Enable pre-LLM classification */
  enablePreLLM: boolean;

  /** Enable dual-LLM audit */
  enableDualLLMAudit: boolean;

  /** Enable output signing */
  enableOutputSigning: boolean;

  /** Pre-LLM classifier config */
  classifierConfig?: {
    customPatterns?: InjectionPattern[];
    riskThreshold?: number;
  };

  /** Dual-LLM auditor config */
  auditorConfig?: Partial<DualLLMAuditorConfig>;

  /** Output signing config */
  signingConfig?: Partial<OutputSigningConfig>;
}

// ============================================================================
// Default Patterns
// ============================================================================

/**
 * Default injection patterns to detect.
 */
export const DEFAULT_INJECTION_PATTERNS: InjectionPattern[] = [
  {
    id: 'ignore_instructions',
    name: 'Ignore Instructions',
    regex: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
    baseRiskScore: 0.9,
    description: 'Attempts to make the model ignore its system prompt',
  },
  {
    id: 'new_instructions',
    name: 'New Instructions Override',
    regex: /new\s+instructions?[:\s]|forget\s+(everything|all|your\s+instructions)/i,
    baseRiskScore: 0.85,
    description: 'Attempts to replace the system prompt with new instructions',
  },
  {
    id: 'roleplay_jailbreak',
    name: 'Roleplay Jailbreak',
    regex: /pretend\s+(you\s+are|to\s+be)\s+(an?\s+)?((evil|unhinged|unrestricted|jailbroken)\s+)?(AI|assistant|chatbot)/i,
    baseRiskScore: 0.8,
    description: 'Attempts to use roleplay to bypass restrictions',
  },
  {
    id: 'dan_jailbreak',
    name: 'DAN-style Jailbreak',
    regex: /\bDAN\b|do\s+anything\s+now|jailbreak(en|ed)?/i,
    baseRiskScore: 0.9,
    description: 'Common jailbreak prompts like DAN (Do Anything Now)',
  },
  {
    id: 'system_prompt_extract',
    name: 'System Prompt Extraction',
    regex: /what\s+(is|are)\s+your\s+(system\s+)?prompts?|show\s+(me\s+)?your\s+(system\s+)?prompts?|repeat\s+(the\s+)?(system\s+)?prompt/i,
    baseRiskScore: 0.7,
    description: 'Attempts to extract the system prompt',
  },
  {
    id: 'base64_injection',
    name: 'Base64 Encoded Injection',
    regex: /base64[:\s]+[A-Za-z0-9+/=]{20,}|decode\s+(this|the\s+following)\s+base64/i,
    baseRiskScore: 0.75,
    description: 'Potentially obfuscated commands in base64',
  },
  {
    id: 'command_injection',
    name: 'Command Injection',
    regex: /\$\([^)]+\)|`[^`]+`|\|\s*sh\b|\|\s*bash\b|;\s*(rm|cat|curl|wget)\s/i,
    baseRiskScore: 0.95,
    description: 'Shell command injection attempts',
  },
  {
    id: 'sql_injection',
    name: 'SQL Injection',
    regex: /'\s*(OR|AND)\s+'?1'?\s*=\s*'?1|UNION\s+SELECT|DROP\s+TABLE|--\s*$/im,
    baseRiskScore: 0.9,
    description: 'SQL injection patterns',
  },
];
