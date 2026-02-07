/**
 * @fileoverview Named Security Tiers for Wunderland (Phase 6)
 * @module wunderland/security/SecurityTiers
 *
 * Provides five named security tiers that bundle pipeline configuration,
 * tool-risk defaults, and permission flags into ergonomic presets.
 *
 * Usage:
 * ```typescript
 * import { createPipelineFromTier, SECURITY_TIERS } from 'wunderland';
 *
 * // Quick pipeline creation
 * const pipeline = createPipelineFromTier('balanced', myAuditorInvoker);
 *
 * // Inspect tier details
 * const tier = SECURITY_TIERS.strict;
 * console.log(tier.description);
 * ```
 */

import { WunderlandSecurityPipeline } from './WunderlandSecurityPipeline.js';
import type { SecurityPipelineConfig } from './types.js';
import { ToolRiskTier } from '../core/types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Named security tier identifiers, ordered from least restrictive to most.
 *
 * - `dangerous`  — All protections disabled. For testing/benchmarking only.
 * - `permissive` — Lightweight input screening; ideal for trusted dev environments.
 * - `balanced`   — Recommended default. Input screening + output signing.
 * - `strict`     — All layers enabled. External actions gated behind review.
 * - `paranoid`   — Maximum security. Every non-trivial action requires HITL approval.
 */
export type SecurityTierName =
  | 'dangerous'
  | 'permissive'
  | 'balanced'
  | 'strict'
  | 'paranoid';

/**
 * Full configuration for a named security tier.
 */
export interface SecurityTierConfig {
  /** Tier identifier */
  name: SecurityTierName;

  /** Human-readable label for display in UIs */
  displayName: string;

  /** One-sentence description of the tier's posture */
  description: string;

  /** Pipeline layer toggles and sub-configs */
  pipelineConfig: SecurityPipelineConfig;

  /** Default tool risk tier applied to unclassified tools */
  defaultToolRiskTier: ToolRiskTier;

  /** Whether seeds in this tier may execute CLI commands */
  allowCliExecution: boolean;

  /** Whether seeds in this tier may write to the filesystem */
  allowFileWrites: boolean;

  /** Whether seeds in this tier may call external APIs */
  allowExternalApis: boolean;

  /**
   * Risk-score threshold (0.0 – 1.0) at which inputs are flagged/blocked.
   * Lower values are more aggressive (flag more inputs).
   */
  riskThreshold: number;
}

// ============================================================================
// Tier Definitions
// ============================================================================

/**
 * Registry of all named security tiers.
 *
 * Each tier is a frozen object so consumers cannot accidentally mutate the
 * shared definitions at runtime.
 */
export const SECURITY_TIERS: Readonly<Record<SecurityTierName, SecurityTierConfig>> = Object.freeze({
  // --------------------------------------------------------------------------
  // Dangerous — all protections OFF
  // --------------------------------------------------------------------------
  dangerous: Object.freeze<SecurityTierConfig>({
    name: 'dangerous',
    displayName: 'Dangerous',
    description: 'All security layers disabled. Use only for isolated testing and benchmarking.',
    pipelineConfig: {
      enablePreLLM: false,
      enableDualLLMAudit: false,
      enableOutputSigning: false,
    },
    defaultToolRiskTier: ToolRiskTier.TIER_1_AUTONOMOUS,
    allowCliExecution: true,
    allowFileWrites: true,
    allowExternalApis: true,
    riskThreshold: 1.0,
  }),

  // --------------------------------------------------------------------------
  // Permissive — lightweight input screening
  // --------------------------------------------------------------------------
  permissive: Object.freeze<SecurityTierConfig>({
    name: 'permissive',
    displayName: 'Permissive',
    description: 'Pre-LLM input classification only. Good for trusted development environments.',
    pipelineConfig: {
      enablePreLLM: true,
      enableDualLLMAudit: false,
      enableOutputSigning: false,
      classifierConfig: {
        riskThreshold: 0.9,
      },
    },
    defaultToolRiskTier: ToolRiskTier.TIER_1_AUTONOMOUS,
    allowCliExecution: true,
    allowFileWrites: true,
    allowExternalApis: true,
    riskThreshold: 0.9,
  }),

  // --------------------------------------------------------------------------
  // Balanced — recommended default
  // --------------------------------------------------------------------------
  balanced: Object.freeze<SecurityTierConfig>({
    name: 'balanced',
    displayName: 'Balanced',
    description: 'Pre-LLM classification and output signing enabled. Recommended for production.',
    pipelineConfig: {
      enablePreLLM: true,
      enableDualLLMAudit: false,
      enableOutputSigning: true,
      classifierConfig: {
        riskThreshold: 0.7,
      },
    },
    defaultToolRiskTier: ToolRiskTier.TIER_2_ASYNC_REVIEW,
    allowCliExecution: true,
    allowFileWrites: false,
    allowExternalApis: true,
    riskThreshold: 0.7,
  }),

  // --------------------------------------------------------------------------
  // Strict — all layers ON, external actions gated
  // --------------------------------------------------------------------------
  strict: Object.freeze<SecurityTierConfig>({
    name: 'strict',
    displayName: 'Strict',
    description: 'All security layers enabled. External actions require review before execution.',
    pipelineConfig: {
      enablePreLLM: true,
      enableDualLLMAudit: true,
      enableOutputSigning: true,
      classifierConfig: {
        riskThreshold: 0.5,
      },
      auditorConfig: {
        evaluateStreamingChunks: true,
        maxStreamingEvaluations: 50,
        auditTemperature: 0.0,
      },
    },
    defaultToolRiskTier: ToolRiskTier.TIER_2_ASYNC_REVIEW,
    allowCliExecution: false,
    allowFileWrites: false,
    allowExternalApis: false,
    riskThreshold: 0.5,
  }),

  // --------------------------------------------------------------------------
  // Paranoid — maximum security, everything requires HITL
  // --------------------------------------------------------------------------
  paranoid: Object.freeze<SecurityTierConfig>({
    name: 'paranoid',
    displayName: 'Paranoid',
    description: 'Maximum security posture. All non-trivial actions require human-in-the-loop approval.',
    pipelineConfig: {
      enablePreLLM: true,
      enableDualLLMAudit: true,
      enableOutputSigning: true,
      classifierConfig: {
        riskThreshold: 0.3,
      },
      auditorConfig: {
        evaluateStreamingChunks: true,
        maxStreamingEvaluations: 100,
        auditTemperature: 0.0,
      },
    },
    defaultToolRiskTier: ToolRiskTier.TIER_3_SYNC_HITL,
    allowCliExecution: false,
    allowFileWrites: false,
    allowExternalApis: false,
    riskThreshold: 0.3,
  }),
});

// ============================================================================
// Helper Functions
// ============================================================================

/** All valid tier names (derived from the registry keys). */
const VALID_TIER_NAMES = new Set<string>(Object.keys(SECURITY_TIERS));

/**
 * Type-guard that checks whether a string is a valid {@link SecurityTierName}.
 *
 * @param name - The string to validate.
 * @returns `true` if `name` is one of the five recognised tier names.
 *
 * @example
 * ```typescript
 * const input = getUserInput();
 * if (isValidSecurityTier(input)) {
 *   const tier = getSecurityTier(input); // input is narrowed to SecurityTierName
 * }
 * ```
 */
export function isValidSecurityTier(name: string): name is SecurityTierName {
  return VALID_TIER_NAMES.has(name);
}

/**
 * Returns the full {@link SecurityTierConfig} for a given tier name.
 *
 * @param name - A valid security tier name.
 * @returns The frozen tier configuration object.
 * @throws {Error} If `name` is not a recognised tier.
 *
 * @example
 * ```typescript
 * const tier = getSecurityTier('balanced');
 * console.log(tier.displayName); // "Balanced"
 * ```
 */
export function getSecurityTier(name: SecurityTierName): SecurityTierConfig {
  const tier = SECURITY_TIERS[name];
  if (!tier) {
    throw new Error(
      `Unknown security tier "${name}". Valid tiers: ${[...VALID_TIER_NAMES].join(', ')}`
    );
  }
  return tier;
}

/**
 * Creates a fully-configured {@link WunderlandSecurityPipeline} from a named tier.
 *
 * This is the primary convenience entry-point: pass a tier name and an optional
 * auditor invoker function and receive a ready-to-use pipeline instance.
 *
 * @param tier    - The security tier to use for pipeline configuration.
 * @param invoker - Optional LLM invoker function required when the tier enables
 *                  dual-LLM auditing (`strict` and `paranoid`).
 * @returns A new {@link WunderlandSecurityPipeline} configured per the tier.
 *
 * @example
 * ```typescript
 * // Balanced tier — no invoker needed (audit disabled)
 * const balancedPipeline = createPipelineFromTier('balanced');
 *
 * // Strict tier — provide an invoker for dual-LLM audit
 * const strictPipeline = createPipelineFromTier('strict', async (prompt) => {
 *   return await myLLM.invoke(prompt);
 * });
 * ```
 */
export function createPipelineFromTier(
  tier: SecurityTierName,
  invoker?: (prompt: string) => Promise<string>,
): WunderlandSecurityPipeline {
  const config = getSecurityTier(tier);

  // Merge the tier's riskThreshold into classifierConfig if not already set
  const pipelineConfig: Partial<SecurityPipelineConfig> = {
    ...config.pipelineConfig,
    classifierConfig: {
      ...config.pipelineConfig.classifierConfig,
      riskThreshold: config.pipelineConfig.classifierConfig?.riskThreshold ?? config.riskThreshold,
    },
  };

  return new WunderlandSecurityPipeline(pipelineConfig, invoker);
}
