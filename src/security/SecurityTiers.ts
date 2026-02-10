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
import type { FolderPermissionConfig } from './FolderPermissions.js';
import { createDefaultFolderConfig } from './FolderPermissions.js';

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

/**
 * Permission set names for declarative permission management.
 */
export type PermissionSetName = 'unrestricted' | 'autonomous' | 'supervised' | 'read-only' | 'minimal';

/**
 * Granular permission structure for filesystem, network, system, and data access.
 */
export interface GranularPermissions {
  filesystem: {
    read: boolean;
    write: boolean;
    delete: boolean;
    execute: boolean;
  };
  network: {
    httpRequests: boolean;
    socketConnections: boolean;
    externalApis: boolean;
  };
  system: {
    cliExecution: boolean;
    processManagement: boolean;
    environmentAccess: boolean;
  };
  data: {
    memoryRead: boolean;
    memoryWrite: boolean;
    credentialAccess: boolean;
  };
}

/**
 * Enhanced security tier configuration with granular permissions.
 * Extends the base SecurityTierConfig with additional permission controls.
 */
export interface EnhancedSecurityTierConfig extends SecurityTierConfig {
  /** Whether seeds may read from the filesystem (separate from write) */
  allowFileRead: boolean;

  /** Whether seeds may operate in full autonomous mode */
  allowFullAutonomous: boolean;

  /** Named permission set for declarative permission management */
  permissionSet: PermissionSetName;

  /** Granular permissions broken down by category */
  permissions: GranularPermissions;

  /** Default folder-level permissions for this security tier */
  defaultFolderPermissions?: FolderPermissionConfig;
}

// ============================================================================
// Permission Set Definitions
// ============================================================================

/**
 * Declarative permission sets that define granular access controls.
 * Each set represents a common security posture for different use cases.
 */
export const PERMISSION_SETS: Readonly<Record<PermissionSetName, GranularPermissions>> = Object.freeze({
  /**
   * Unrestricted — All permissions enabled.
   * Use for: Admin/testing environments, full-trust scenarios.
   */
  unrestricted: Object.freeze<GranularPermissions>({
    filesystem: {
      read: true,
      write: true,
      delete: true,
      execute: true,
    },
    network: {
      httpRequests: true,
      socketConnections: true,
      externalApis: true,
    },
    system: {
      cliExecution: true,
      processManagement: true,
      environmentAccess: true,
    },
    data: {
      memoryRead: true,
      memoryWrite: true,
      credentialAccess: true,
    },
  }),

  /**
   * Autonomous — Read/write files, HTTP requests, CLI execution, memory access.
   * Use for: Production autonomous bots with broad capabilities.
   */
  autonomous: Object.freeze<GranularPermissions>({
    filesystem: {
      read: true,
      write: true,
      delete: false,
      execute: false,
    },
    network: {
      httpRequests: true,
      socketConnections: true,
      externalApis: true,
    },
    system: {
      cliExecution: true,
      processManagement: false,
      environmentAccess: false,
    },
    data: {
      memoryRead: true,
      memoryWrite: true,
      credentialAccess: false,
    },
  }),

  /**
   * Supervised — Read files only, HTTP requests, NO CLI, memory read/write.
   * Use for: Production supervised bots that need review before destructive actions.
   */
  supervised: Object.freeze<GranularPermissions>({
    filesystem: {
      read: true,
      write: false,
      delete: false,
      execute: false,
    },
    network: {
      httpRequests: true,
      socketConnections: true,
      externalApis: true,
    },
    system: {
      cliExecution: false,
      processManagement: false,
      environmentAccess: false,
    },
    data: {
      memoryRead: true,
      memoryWrite: true,
      credentialAccess: false,
    },
  }),

  /**
   * Read-only — Read files/memory only, HTTP requests, NO writes.
   * Use for: Research/analysis bots that don't modify state.
   */
  'read-only': Object.freeze<GranularPermissions>({
    filesystem: {
      read: true,
      write: false,
      delete: false,
      execute: false,
    },
    network: {
      httpRequests: true,
      socketConnections: false,
      externalApis: false,
    },
    system: {
      cliExecution: false,
      processManagement: false,
      environmentAccess: false,
    },
    data: {
      memoryRead: true,
      memoryWrite: false,
      credentialAccess: false,
    },
  }),

  /**
   * Minimal — NO filesystem, HTTP requests only, memory read only.
   * Use for: Web-only bots with minimal privileges.
   */
  minimal: Object.freeze<GranularPermissions>({
    filesystem: {
      read: false,
      write: false,
      delete: false,
      execute: false,
    },
    network: {
      httpRequests: true,
      socketConnections: false,
      externalApis: false,
    },
    system: {
      cliExecution: false,
      processManagement: false,
      environmentAccess: false,
    },
    data: {
      memoryRead: true,
      memoryWrite: false,
      credentialAccess: false,
    },
  }),
});

// ============================================================================
// Tier Definitions
// ============================================================================

/**
 * Registry of all named security tiers.
 *
 * Each tier is a frozen object so consumers cannot accidentally mutate the
 * shared definitions at runtime.
 */
export const SECURITY_TIERS: Readonly<Record<SecurityTierName, EnhancedSecurityTierConfig>> = Object.freeze({
  // --------------------------------------------------------------------------
  // Dangerous — all protections OFF
  // --------------------------------------------------------------------------
  dangerous: Object.freeze<EnhancedSecurityTierConfig>({
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
    allowFileRead: true,
    allowExternalApis: true,
    allowFullAutonomous: true,
    permissionSet: 'unrestricted',
    permissions: PERMISSION_SETS.unrestricted,
    riskThreshold: 1.0,
    defaultFolderPermissions: createDefaultFolderConfig('dangerous'),
  }),

  // --------------------------------------------------------------------------
  // Permissive — lightweight input screening
  // --------------------------------------------------------------------------
  permissive: Object.freeze<EnhancedSecurityTierConfig>({
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
    allowFileRead: true,
    allowExternalApis: true,
    allowFullAutonomous: true,
    permissionSet: 'autonomous',
    permissions: PERMISSION_SETS.autonomous,
    riskThreshold: 0.9,
    defaultFolderPermissions: createDefaultFolderConfig('permissive'),
  }),

  // --------------------------------------------------------------------------
  // Balanced — recommended default
  // --------------------------------------------------------------------------
  balanced: Object.freeze<EnhancedSecurityTierConfig>({
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
    allowFileRead: true,
    allowExternalApis: true,
    allowFullAutonomous: false,
    permissionSet: 'supervised',
    permissions: PERMISSION_SETS.supervised,
    riskThreshold: 0.7,
    defaultFolderPermissions: createDefaultFolderConfig('balanced'),
  }),

  // --------------------------------------------------------------------------
  // Strict — all layers ON, external actions gated
  // --------------------------------------------------------------------------
  strict: Object.freeze<EnhancedSecurityTierConfig>({
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
    allowFileRead: true,
    allowExternalApis: false,
    allowFullAutonomous: false,
    permissionSet: 'read-only',
    permissions: PERMISSION_SETS['read-only'],
    riskThreshold: 0.5,
    defaultFolderPermissions: createDefaultFolderConfig('strict'),
  }),

  // --------------------------------------------------------------------------
  // Paranoid — maximum security, everything requires HITL
  // --------------------------------------------------------------------------
  paranoid: Object.freeze<EnhancedSecurityTierConfig>({
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
    allowFileRead: true,
    allowExternalApis: false,
    allowFullAutonomous: false,
    permissionSet: 'minimal',
    permissions: PERMISSION_SETS.minimal,
    riskThreshold: 0.3,
    defaultFolderPermissions: createDefaultFolderConfig('paranoid'),
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

/**
 * Migrates a legacy {@link SecurityTierConfig} to the enhanced permission model.
 *
 * This helper auto-converts old boolean permission flags to the new granular
 * permission structure, enabling backward compatibility with existing configs.
 *
 * @param oldConfig - Legacy security tier configuration.
 * @returns Enhanced configuration with granular permissions.
 *
 * @example
 * ```typescript
 * const legacyConfig = SECURITY_TIERS.balanced; // Old format
 * const enhanced = migrateToEnhancedPermissions(legacyConfig);
 * console.log(enhanced.allowFileRead); // true
 * console.log(enhanced.permissionSet); // "supervised"
 * ```
 */
export function migrateToEnhancedPermissions(
  oldConfig: SecurityTierConfig,
): EnhancedSecurityTierConfig {
  // Infer allowFileRead: true if allowFileWrites is true OR tier is permissive
  const allowFileRead =
    oldConfig.allowFileWrites ||
    oldConfig.defaultToolRiskTier <= ToolRiskTier.TIER_2_ASYNC_REVIEW;

  // Infer allowFullAutonomous: true if tier is TIER_1_AUTONOMOUS
  const allowFullAutonomous =
    oldConfig.defaultToolRiskTier === ToolRiskTier.TIER_1_AUTONOMOUS;

  // Infer permission set from tier characteristics
  let permissionSet: PermissionSetName;
  if (
    oldConfig.allowCliExecution &&
    oldConfig.allowFileWrites &&
    oldConfig.allowExternalApis &&
    allowFullAutonomous
  ) {
    permissionSet = 'unrestricted';
  } else if (
    oldConfig.allowCliExecution &&
    oldConfig.allowFileWrites &&
    oldConfig.allowExternalApis
  ) {
    permissionSet = 'autonomous';
  } else if (allowFileRead && oldConfig.allowExternalApis && !oldConfig.allowFileWrites) {
    permissionSet = 'supervised';
  } else if (allowFileRead && !oldConfig.allowExternalApis && !oldConfig.allowFileWrites) {
    permissionSet = 'read-only';
  } else {
    permissionSet = 'minimal';
  }

  // Build granular permissions from inferred set
  const permissions = PERMISSION_SETS[permissionSet];

  return {
    ...oldConfig,
    allowFileRead,
    allowFullAutonomous,
    permissionSet,
    permissions,
  };
}

/**
 * Type guard to check if a config is already enhanced.
 *
 * @param config - Security tier configuration to check.
 * @returns True if config has enhanced permissions fields.
 */
export function isEnhancedSecurityTierConfig(
  config: SecurityTierConfig,
): config is EnhancedSecurityTierConfig {
  return (
    'allowFileRead' in config &&
    'allowFullAutonomous' in config &&
    'permissionSet' in config &&
    'permissions' in config
  );
}
