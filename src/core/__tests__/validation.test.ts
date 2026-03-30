/**
 * @fileoverview Unit tests for validation utilities
 * @module wunderland/utils/__tests__/validation
 */

import { describe, it, expect } from 'vitest';
import {
  validatePreset,
  validateSecurityTier,
  validateToolAccessProfile,
  validatePermissionSet,
  validateExecutionMode,
  validateTurnApprovalMode,
  validateExtensionName,
  validateSkillName,
  validateHexacoTraits,
  validateAgentConfig,
} from '../validation.js';

describe('Validation Utilities', () => {
  describe('validatePreset', () => {
    it('should validate correct preset names', () => {
      expect(validatePreset('research-assistant')).toBe(true);
      expect(validatePreset('customer-support')).toBe(true);
      expect(validatePreset('creative-writer')).toBe(true);
      expect(validatePreset('code-reviewer')).toBe(true);
      expect(validatePreset('data-analyst')).toBe(true);
      expect(validatePreset('security-auditor')).toBe(true);
      expect(validatePreset('devops-assistant')).toBe(true);
      expect(validatePreset('personal-assistant')).toBe(true);
    });

    it('should reject invalid preset names', () => {
      expect(validatePreset('invalid-preset')).toBe(false);
      expect(validatePreset('RESEARCH-ASSISTANT')).toBe(false);
      expect(validatePreset('')).toBe(false);
      expect(validatePreset('research_assistant')).toBe(false);
    });
  });

  describe('validateSecurityTier', () => {
    it('should validate correct security tier names', () => {
      expect(validateSecurityTier('dangerous')).toBe(true);
      expect(validateSecurityTier('permissive')).toBe(true);
      expect(validateSecurityTier('balanced')).toBe(true);
      expect(validateSecurityTier('strict')).toBe(true);
      expect(validateSecurityTier('paranoid')).toBe(true);
    });

    it('should reject invalid security tier names', () => {
      expect(validateSecurityTier('invalid')).toBe(false);
      expect(validateSecurityTier('BALANCED')).toBe(false);
      expect(validateSecurityTier('')).toBe(false);
    });
  });

  describe('validateToolAccessProfile', () => {
    it('should validate correct tool access profile names', () => {
      expect(validateToolAccessProfile('social-citizen')).toBe(true);
      expect(validateToolAccessProfile('social-observer')).toBe(true);
      expect(validateToolAccessProfile('social-creative')).toBe(true);
      expect(validateToolAccessProfile('assistant')).toBe(true);
      expect(validateToolAccessProfile('unrestricted')).toBe(true);
    });

    it('should reject invalid tool access profile names', () => {
      expect(validateToolAccessProfile('invalid-profile')).toBe(false);
      expect(validateToolAccessProfile('ASSISTANT')).toBe(false);
      expect(validateToolAccessProfile('')).toBe(false);
    });
  });

  describe('validatePermissionSet', () => {
    it('should validate correct permission set names', () => {
      expect(validatePermissionSet('unrestricted')).toBe(true);
      expect(validatePermissionSet('autonomous')).toBe(true);
      expect(validatePermissionSet('supervised')).toBe(true);
      expect(validatePermissionSet('read-only')).toBe(true);
      expect(validatePermissionSet('minimal')).toBe(true);
    });

    it('should reject invalid permission set names', () => {
      expect(validatePermissionSet('invalid')).toBe(false);
      expect(validatePermissionSet('SUPERVISED')).toBe(false);
      expect(validatePermissionSet('')).toBe(false);
    });
  });

  describe('validateExecutionMode', () => {
    it('should validate correct execution mode names', () => {
      expect(validateExecutionMode('autonomous')).toBe(true);
      expect(validateExecutionMode('human-all')).toBe(true);
      expect(validateExecutionMode('human-dangerous')).toBe(true);
    });

    it('should reject invalid execution mode names', () => {
      expect(validateExecutionMode('invalid')).toBe(false);
      expect(validateExecutionMode('AUTONOMOUS')).toBe(false);
      expect(validateExecutionMode('')).toBe(false);
    });
  });

  describe('validateTurnApprovalMode', () => {
    it('should validate correct turn approval modes', () => {
      expect(validateTurnApprovalMode('off')).toBe(true);
      expect(validateTurnApprovalMode('after-each-round')).toBe(true);
      expect(validateTurnApprovalMode('after-each-turn')).toBe(true);
    });

    it('should reject invalid turn approval modes', () => {
      expect(validateTurnApprovalMode('invalid')).toBe(false);
      expect(validateTurnApprovalMode('OFF')).toBe(false);
      expect(validateTurnApprovalMode('')).toBe(false);
    });
  });

  describe('validateExtensionName', () => {
    it('should validate correct kebab-case extension names', () => {
      expect(validateExtensionName('web-search')).toBe(true);
      expect(validateExtensionName('web-browser')).toBe(true);
      expect(validateExtensionName('voice-synthesis')).toBe(true);
      expect(validateExtensionName('multi-word-extension-name')).toBe(true);
    });

    it('should reject invalid extension names', () => {
      expect(validateExtensionName('WebSearch')).toBe(false);
      expect(validateExtensionName('web_search')).toBe(false);
      expect(validateExtensionName('web search')).toBe(false);
      expect(validateExtensionName('')).toBe(false);
      expect(validateExtensionName('123-start-with-number')).toBe(false);
      expect(validateExtensionName('-starts-with-dash')).toBe(false);
      expect(validateExtensionName('ends-with-dash-')).toBe(false);
    });
  });

  describe('validateSkillName', () => {
    it('should validate correct kebab-case skill names', () => {
      expect(validateSkillName('web-search')).toBe(true);
      expect(validateSkillName('github')).toBe(true);
      expect(validateSkillName('coding-agent')).toBe(true);
      expect(validateSkillName('apple-notes')).toBe(true);
    });

    it('should reject invalid skill names', () => {
      expect(validateSkillName('WebSearch')).toBe(false);
      expect(validateSkillName('web_search')).toBe(false);
      expect(validateSkillName('')).toBe(false);
    });
  });

  describe('validateHexacoTraits', () => {
    it('should validate correct HEXACO traits', () => {
      expect(
        validateHexacoTraits({
          honesty: 0.8,
          emotionality: 0.6,
          extraversion: 0.75,
          agreeableness: 0.85,
          conscientiousness: 0.9,
          openness: 0.7,
        })
      ).toBe(true);
    });

    it('should validate boundary values (0 and 1)', () => {
      expect(
        validateHexacoTraits({
          honesty: 0,
          emotionality: 1,
          extraversion: 0.5,
          agreeableness: 0.5,
          conscientiousness: 0.5,
          openness: 0.5,
        })
      ).toBe(true);
    });

    it('should reject out-of-range values', () => {
      expect(
        validateHexacoTraits({
          honesty: 1.5, // > 1
          emotionality: 0.6,
          extraversion: 0.75,
          agreeableness: 0.85,
          conscientiousness: 0.9,
          openness: 0.7,
        })
      ).toBe(false);

      expect(
        validateHexacoTraits({
          honesty: 0.8,
          emotionality: -0.1, // < 0
          extraversion: 0.75,
          agreeableness: 0.85,
          conscientiousness: 0.9,
          openness: 0.7,
        })
      ).toBe(false);
    });

    it('should reject missing required traits', () => {
      expect(
        validateHexacoTraits({
          honesty: 0.8,
          emotionality: 0.6,
          // missing other traits
        } as any)
      ).toBe(false);
    });

    it('should reject non-number values', () => {
      expect(
        validateHexacoTraits({
          honesty: '0.8' as any,
          emotionality: 0.6,
          extraversion: 0.75,
          agreeableness: 0.85,
          conscientiousness: 0.9,
          openness: 0.7,
        })
      ).toBe(false);
    });
  });

  describe('validateAgentConfig', () => {
    it('should validate a complete valid config', () => {
      const config = {
        seedId: 'seed_test_agent',
        displayName: 'Test Agent',
        bio: 'A test agent',
        systemPrompt: 'You are a test agent',
        personality: {
          honesty: 0.8,
          emotionality: 0.6,
          extraversion: 0.75,
          agreeableness: 0.85,
          conscientiousness: 0.9,
          openness: 0.7,
        },
        preset: 'research-assistant',
        skills: ['web-search', 'summarize'],
        extensions: {
          tools: ['web-search', 'web-browser'],
          voice: [],
          productivity: [],
        },
        channels: ['telegram', 'webchat'],
        securityTier: 'balanced',
        toolAccessProfile: 'assistant',
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should collect multiple validation errors', () => {
      const config = {
        seedId: 'seed_test_agent',
        displayName: 'Test Agent',
        preset: 'invalid-preset',
        personality: {
          honesty: 1.5, // Out of range
          emotionality: 0.6,
          extraversion: 0.75,
          agreeableness: 0.85,
          conscientiousness: 0.9,
          openness: 0.7,
        },
        securityTier: 'invalid-tier',
        toolAccessProfile: 'invalid-profile',
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('preset'))).toBe(true);
      expect(result.errors.some((e) => e.includes('personality'))).toBe(true);
      expect(result.errors.some((e) => e.includes('securityTier'))).toBe(true);
    });

    it('should validate extension names', () => {
      const config = {
        seedId: 'seed_test_agent',
        displayName: 'Test Agent',
        extensions: {
          tools: ['web-search', 'InvalidName', 'valid-name'],
          voice: [],
          productivity: [],
        },
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('InvalidName'))).toBe(true);
    });

    it('should validate skill names', () => {
      const config = {
        seedId: 'seed_test_agent',
        displayName: 'Test Agent',
        skills: ['web-search', 'InvalidSkill', 'valid-skill'],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('InvalidSkill'))).toBe(true);
    });

    it('should allow minimal valid config', () => {
      const config = {
        seedId: 'seed_minimal',
        displayName: 'Minimal Agent',
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should validate permission set', () => {
      const config = {
        seedId: 'seed_test_agent',
        displayName: 'Test Agent',
        permissionSet: 'invalid-permission',
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('permissionSet'))).toBe(true);
    });

    it('should validate execution mode', () => {
      const config = {
        seedId: 'seed_test_agent',
        displayName: 'Test Agent',
        executionMode: 'invalid-mode',
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('executionMode'))).toBe(true);
    });

    it('should validate hitl.turnApprovalMode', () => {
      const config = {
        seedId: 'seed_test_agent',
        displayName: 'Test Agent',
        hitl: { turnApprovalMode: 'invalid' },
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('hitl.turnApprovalMode'))).toBe(true);
    });
  });
});
