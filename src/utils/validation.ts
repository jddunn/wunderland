/**
 * @fileoverview Validation utilities for agent configuration
 * @module wunderland/utils/validation
 *
 * Provides validation functions for:
 * - Preset names
 * - Security tiers
 * - Tool access profiles
 * - Extension names
 * - Permission sets
 */

import { SECURITY_TIERS, type SecurityTierName } from '../security/SecurityTiers.js';
import type { PermissionSetName } from '../security/SecurityTiers.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Valid preset IDs (must match preset directory names)
 */
export const VALID_PRESETS = [
  'research-assistant',
  'customer-support',
  'creative-writer',
  'code-reviewer',
  'data-analyst',
  'security-auditor',
  'devops-assistant',
  'personal-assistant',
] as const;

/**
 * Valid tool access profile names
 */
export const VALID_TOOL_ACCESS_PROFILES = [
  'social-citizen',
  'social-observer',
  'social-creative',
  'assistant',
  'unrestricted',
] as const;

/**
 * Valid permission set names
 */
export const VALID_PERMISSION_SETS: ReadonlyArray<PermissionSetName> = [
  'unrestricted',
  'autonomous',
  'supervised',
  'read-only',
  'minimal',
] as const;

/**
 * Valid execution modes
 */
export const VALID_EXECUTION_MODES = ['autonomous', 'human-all', 'human-dangerous'] as const;

/**
 * Valid HITL turn-approval modes
 */
export const VALID_TURN_APPROVAL_MODES = ['off', 'after-each-round', 'after-each-turn'] as const;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a string is a valid preset ID.
 *
 * @param preset - String to validate
 * @returns True if preset is valid
 *
 * @example
 * ```typescript
 * if (!validatePreset('research-assistant')) {
 *   throw new Error('Invalid preset');
 * }
 * ```
 */
export function validatePreset(preset: string): preset is (typeof VALID_PRESETS)[number] {
  return VALID_PRESETS.includes(preset as any);
}

/**
 * Check if a string is a valid security tier.
 *
 * @param tier - String to validate
 * @returns True if tier is valid
 *
 * @example
 * ```typescript
 * if (!validateSecurityTier('balanced')) {
 *   throw new Error('Invalid security tier');
 * }
 * ```
 */
export function validateSecurityTier(tier: string): tier is SecurityTierName {
  return tier in SECURITY_TIERS;
}

/**
 * Check if a string is a valid tool access profile.
 *
 * @param profile - String to validate
 * @returns True if profile is valid
 *
 * @example
 * ```typescript
 * if (!validateToolAccessProfile('assistant')) {
 *   throw new Error('Invalid tool access profile');
 * }
 * ```
 */
export function validateToolAccessProfile(
  profile: string,
): profile is (typeof VALID_TOOL_ACCESS_PROFILES)[number] {
  return VALID_TOOL_ACCESS_PROFILES.includes(profile as any);
}

/**
 * Check if a string is a valid permission set.
 *
 * @param permissionSet - String to validate
 * @returns True if permission set is valid
 *
 * @example
 * ```typescript
 * if (!validatePermissionSet('autonomous')) {
 *   throw new Error('Invalid permission set');
 * }
 * ```
 */
export function validatePermissionSet(permissionSet: string): permissionSet is PermissionSetName {
  return VALID_PERMISSION_SETS.includes(permissionSet as any);
}

/**
 * Check if a string is a valid execution mode.
 *
 * @param mode - String to validate
 * @returns True if execution mode is valid
 *
 * @example
 * ```typescript
 * if (!validateExecutionMode('human-dangerous')) {
 *   throw new Error('Invalid execution mode');
 * }
 * ```
 */
export function validateExecutionMode(
  mode: string,
): mode is (typeof VALID_EXECUTION_MODES)[number] {
  return VALID_EXECUTION_MODES.includes(mode as any);
}

/**
 * Check if a string is a valid HITL turn-approval mode.
 */
export function validateTurnApprovalMode(
  mode: string,
): mode is (typeof VALID_TURN_APPROVAL_MODES)[number] {
  return VALID_TURN_APPROVAL_MODES.includes(mode as any);
}

/**
 * Validate extension name format.
 * Extension names should be lowercase kebab-case.
 *
 * @param name - Extension name to validate
 * @returns True if name format is valid
 *
 * @example
 * ```typescript
 * if (!validateExtensionName('web-search')) {
 *   throw new Error('Invalid extension name format');
 * }
 * ```
 */
export function validateExtensionName(name: string): boolean {
  if (!name || typeof name !== 'string') {
    return false;
  }

  // Must be lowercase kebab-case (letters, numbers, hyphens only)
  // Must start with a letter (reject "123-start-with-number")
  const kebabCasePattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
  return kebabCasePattern.test(name);
}

/**
 * Validate skill name format.
 * Skill names should be lowercase kebab-case.
 *
 * @param name - Skill name to validate
 * @returns True if name format is valid
 *
 * @example
 * ```typescript
 * if (!validateSkillName('web-search')) {
 *   throw new Error('Invalid skill name format');
 * }
 * ```
 */
export function validateSkillName(name: string): boolean {
  if (!name || typeof name !== 'string') {
    return false;
  }

  // Must be lowercase kebab-case (letters, numbers, hyphens only)
  const kebabCasePattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
  return kebabCasePattern.test(name);
}

/**
 * Validate HEXACO personality traits.
 * Each trait must be a number between 0 and 1.
 *
 * @param traits - HEXACO traits object
 * @returns True if all traits are valid
 *
 * @example
 * ```typescript
 * const traits = { honesty: 0.9, emotionality: 0.3, ... };
 * if (!validateHexacoTraits(traits)) {
 *   throw new Error('Invalid HEXACO traits');
 * }
 * ```
 */
export function validateHexacoTraits(traits: {
  honesty: number;
  emotionality: number;
  extraversion: number;
  agreeableness: number;
  conscientiousness: number;
  openness: number;
}): boolean {
  const traitNames = [
    'honesty',
    'emotionality',
    'extraversion',
    'agreeableness',
    'conscientiousness',
    'openness',
  ];

  for (const name of traitNames) {
    const value = traits[name as keyof typeof traits];
    if (typeof value !== 'number' || value < 0 || value > 1) {
      return false;
    }
  }

  return true;
}

/**
 * Validate a full agent configuration object.
 * Checks all required fields and validates their formats.
 *
 * @param config - Agent configuration to validate
 * @returns Validation result with error messages
 *
 * @example
 * ```typescript
 * const result = validateAgentConfig(config);
 * if (!result.valid) {
 *   console.error('Validation errors:', result.errors);
 * }
 * ```
 */
export function validateAgentConfig(config: any): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Required fields
  if (!config.seedId || typeof config.seedId !== 'string') {
    errors.push('seedId is required (string)');
  }

  if (!config.displayName || typeof config.displayName !== 'string') {
    errors.push('displayName is required (string)');
  }

  // Validate personality traits if provided
  if (config.personality) {
    if (!validateHexacoTraits(config.personality)) {
      errors.push('personality traits must be numbers between 0 and 1');
    }
  }

  // Validate preset if provided
  const preset = (config.preset ?? config.presetId) as unknown;
  if (typeof preset === 'string' && preset && !validatePreset(preset)) {
    errors.push(`Invalid preset: ${preset}`);
  }

  // Validate security tier if provided
  const securityTier = (config.securityTier ?? config.security?.tier) as unknown;
  if (typeof securityTier === 'string' && securityTier && !validateSecurityTier(securityTier)) {
    errors.push(`Invalid securityTier: ${securityTier}`);
  }

  // Validate permission set if provided
  if (config.permissionSet && !validatePermissionSet(config.permissionSet)) {
    errors.push(`Invalid permissionSet: ${config.permissionSet}`);
  }

  // Validate tool access profile if provided
  if (config.toolAccessProfile && !validateToolAccessProfile(config.toolAccessProfile)) {
    errors.push(`Invalid toolAccessProfile: ${config.toolAccessProfile}`);
  }

  // Validate execution mode if provided
  if (config.executionMode && !validateExecutionMode(config.executionMode)) {
    errors.push(`Invalid executionMode: ${config.executionMode}`);
  }

  // Validate HITL config if provided
  if (config.hitl && typeof config.hitl === 'object' && !Array.isArray(config.hitl)) {
    if (typeof config.hitl.secret !== 'undefined' && typeof config.hitl.secret !== 'string') {
      errors.push('Invalid hitl.secret: must be a string');
    }
    if (config.hitl.turnApprovalMode && !validateTurnApprovalMode(config.hitl.turnApprovalMode)) {
      errors.push(`Invalid hitl.turnApprovalMode: ${config.hitl.turnApprovalMode}`);
    }
  }

  // Validate extension names if provided
  const extensions = config.extensions ?? config.suggestedExtensions;
  if (extensions) {
    if (extensions.tools) {
      for (const tool of extensions.tools) {
        if (!validateExtensionName(tool)) {
          errors.push(`Invalid tool extension name: ${tool}`);
        }
      }
    }
    if (extensions.voice) {
      for (const voice of extensions.voice) {
        if (!validateExtensionName(voice)) {
          errors.push(`Invalid voice extension name: ${voice}`);
        }
      }
    }
    if (extensions.productivity) {
      for (const prod of extensions.productivity) {
        if (!validateExtensionName(prod)) {
          errors.push(`Invalid productivity extension name: ${prod}`);
        }
      }
    }
  }

  // Validate skill names if provided
  if (config.skills) {
    for (const skill of config.skills) {
      if (!validateSkillName(skill)) {
        errors.push(`Invalid skill name: ${skill}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
