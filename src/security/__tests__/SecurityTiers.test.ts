/**
 * @fileoverview Tests for SecurityTiers — named security tier presets
 * @module wunderland/security/__tests__/SecurityTiers.test
 */

import { describe, it, expect } from 'vitest';
import {
  SECURITY_TIERS,
  isValidSecurityTier,
  getSecurityTier,
  createPipelineFromTier,
  type SecurityTierName,
} from '../SecurityTiers.js';
import { WunderlandSecurityPipeline } from '../WunderlandSecurityPipeline.js';
import { ToolRiskTier } from '../../core/types.js';

// ── Tier name validation ────────────────────────────────────────────────────

describe('isValidSecurityTier', () => {
  const VALID_NAMES: SecurityTierName[] = [
    'dangerous',
    'permissive',
    'balanced',
    'strict',
    'paranoid',
  ];

  it('should return true for all 5 valid tier names', () => {
    for (const name of VALID_NAMES) {
      expect(isValidSecurityTier(name)).toBe(true);
    }
  });

  it('should return false for invalid tier names', () => {
    expect(isValidSecurityTier('foo')).toBe(false);
    expect(isValidSecurityTier('')).toBe(false);
    expect(isValidSecurityTier('BALANCED')).toBe(false);
    expect(isValidSecurityTier('Paranoid')).toBe(false);
  });

  it('should have exactly 5 tier entries in the registry', () => {
    expect(Object.keys(SECURITY_TIERS)).toHaveLength(5);
  });
});

// ── Pipeline config flags per tier ──────────────────────────────────────────

describe('SECURITY_TIERS pipeline config flags', () => {
  it('dangerous: all pipeline layers OFF', () => {
    const tier = SECURITY_TIERS.dangerous;
    expect(tier.pipelineConfig.enablePreLLM).toBe(false);
    expect(tier.pipelineConfig.enableDualLLMAudit).toBe(false);
    expect(tier.pipelineConfig.enableOutputSigning).toBe(false);
  });

  it('permissive: only Pre-LLM ON', () => {
    const tier = SECURITY_TIERS.permissive;
    expect(tier.pipelineConfig.enablePreLLM).toBe(true);
    expect(tier.pipelineConfig.enableDualLLMAudit).toBe(false);
    expect(tier.pipelineConfig.enableOutputSigning).toBe(false);
  });

  it('balanced: Pre-LLM + Output Signing ON, Dual-LLM OFF', () => {
    const tier = SECURITY_TIERS.balanced;
    expect(tier.pipelineConfig.enablePreLLM).toBe(true);
    expect(tier.pipelineConfig.enableDualLLMAudit).toBe(false);
    expect(tier.pipelineConfig.enableOutputSigning).toBe(true);
  });

  it('strict: all pipeline layers ON', () => {
    const tier = SECURITY_TIERS.strict;
    expect(tier.pipelineConfig.enablePreLLM).toBe(true);
    expect(tier.pipelineConfig.enableDualLLMAudit).toBe(true);
    expect(tier.pipelineConfig.enableOutputSigning).toBe(true);
  });

  it('paranoid: all pipeline layers ON', () => {
    const tier = SECURITY_TIERS.paranoid;
    expect(tier.pipelineConfig.enablePreLLM).toBe(true);
    expect(tier.pipelineConfig.enableDualLLMAudit).toBe(true);
    expect(tier.pipelineConfig.enableOutputSigning).toBe(true);
  });
});

// ── getSecurityTier ─────────────────────────────────────────────────────────

describe('getSecurityTier', () => {
  it('should return correct config for each tier name', () => {
    const names: SecurityTierName[] = ['dangerous', 'permissive', 'balanced', 'strict', 'paranoid'];
    for (const name of names) {
      const tier = getSecurityTier(name);
      expect(tier.name).toBe(name);
      expect(tier.displayName).toBeTruthy();
      expect(tier.description).toBeTruthy();
    }
  });

  it('should throw for invalid tier name', () => {
    expect(() => getSecurityTier('nonexistent' as SecurityTierName)).toThrow(
      /Unknown security tier/
    );
  });
});

// ── createPipelineFromTier ──────────────────────────────────────────────────

describe('createPipelineFromTier', () => {
  const mockInvoker = async (prompt: string) => 'ok';

  it('should return a WunderlandSecurityPipeline for each tier', () => {
    const names: SecurityTierName[] = ['dangerous', 'permissive', 'balanced', 'strict', 'paranoid'];
    for (const name of names) {
      const pipeline = createPipelineFromTier(name, mockInvoker);
      expect(pipeline).toBeInstanceOf(WunderlandSecurityPipeline);
    }
  });

  it('should create a pipeline without an invoker for tiers that do not need it', () => {
    // dangerous, permissive, and balanced do not enable dual-LLM audit
    const pipeline = createPipelineFromTier('balanced');
    expect(pipeline).toBeInstanceOf(WunderlandSecurityPipeline);
  });
});

// ── Risk thresholds descend ─────────────────────────────────────────────────

describe('Risk threshold ordering', () => {
  it('thresholds should descend: dangerous > permissive > balanced > strict > paranoid', () => {
    const dangerous = SECURITY_TIERS.dangerous.riskThreshold;
    const permissive = SECURITY_TIERS.permissive.riskThreshold;
    const balanced = SECURITY_TIERS.balanced.riskThreshold;
    const strict = SECURITY_TIERS.strict.riskThreshold;
    const paranoid = SECURITY_TIERS.paranoid.riskThreshold;

    expect(dangerous).toBe(1.0);
    expect(permissive).toBe(0.9);
    expect(balanced).toBe(0.7);
    expect(strict).toBe(0.5);
    expect(paranoid).toBe(0.3);

    expect(dangerous).toBeGreaterThan(permissive);
    expect(permissive).toBeGreaterThan(balanced);
    expect(balanced).toBeGreaterThan(strict);
    expect(strict).toBeGreaterThan(paranoid);
  });
});

// ── Permission flags ────────────────────────────────────────────────────────

describe('Permission flags per tier', () => {
  it('dangerous: all permissions allowed', () => {
    const tier = SECURITY_TIERS.dangerous;
    expect(tier.allowCliExecution).toBe(true);
    expect(tier.allowFileWrites).toBe(true);
    expect(tier.allowExternalApis).toBe(true);
  });

  it('permissive: all permissions allowed', () => {
    const tier = SECURITY_TIERS.permissive;
    expect(tier.allowCliExecution).toBe(true);
    expect(tier.allowFileWrites).toBe(true);
    expect(tier.allowExternalApis).toBe(true);
  });

  it('balanced: CLI and external APIs allowed, file writes disallowed', () => {
    const tier = SECURITY_TIERS.balanced;
    expect(tier.allowCliExecution).toBe(true);
    expect(tier.allowFileWrites).toBe(false);
    expect(tier.allowExternalApis).toBe(true);
  });

  it('strict: all permissions denied', () => {
    const tier = SECURITY_TIERS.strict;
    expect(tier.allowCliExecution).toBe(false);
    expect(tier.allowFileWrites).toBe(false);
    expect(tier.allowExternalApis).toBe(false);
  });

  it('paranoid: all permissions denied', () => {
    const tier = SECURITY_TIERS.paranoid;
    expect(tier.allowCliExecution).toBe(false);
    expect(tier.allowFileWrites).toBe(false);
    expect(tier.allowExternalApis).toBe(false);
  });
});

// ── Tool risk tiers ─────────────────────────────────────────────────────────

describe('Default tool risk tiers', () => {
  it('dangerous: TIER_1_AUTONOMOUS', () => {
    expect(SECURITY_TIERS.dangerous.defaultToolRiskTier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
  });

  it('permissive: TIER_1_AUTONOMOUS', () => {
    expect(SECURITY_TIERS.permissive.defaultToolRiskTier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
  });

  it('balanced: TIER_2_ASYNC_REVIEW', () => {
    expect(SECURITY_TIERS.balanced.defaultToolRiskTier).toBe(ToolRiskTier.TIER_2_ASYNC_REVIEW);
  });

  it('strict: TIER_2_ASYNC_REVIEW', () => {
    expect(SECURITY_TIERS.strict.defaultToolRiskTier).toBe(ToolRiskTier.TIER_2_ASYNC_REVIEW);
  });

  it('paranoid: TIER_3_SYNC_HITL', () => {
    expect(SECURITY_TIERS.paranoid.defaultToolRiskTier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
  });
});

// ── Immutability ────────────────────────────────────────────────────────────

describe('Tier immutability', () => {
  it('SECURITY_TIERS registry is frozen', () => {
    expect(Object.isFrozen(SECURITY_TIERS)).toBe(true);
  });

  it('individual tier configs are frozen', () => {
    const names: SecurityTierName[] = ['dangerous', 'permissive', 'balanced', 'strict', 'paranoid'];
    for (const name of names) {
      expect(Object.isFrozen(SECURITY_TIERS[name])).toBe(true);
    }
  });
});
