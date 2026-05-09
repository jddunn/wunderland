// @ts-nocheck
/**
 * @fileoverview E2E tests for --overdrive flag and accept-all permission flow
 * @module wunderland/__tests__/cli-overdrive.e2e
 *
 * Tests CLI --overdrive flag parsing and the resulting authorization behavior:
 * - parseArgs recognizes --overdrive as a boolean flag
 * - Overdrive config auto-approves navigation tools without HITL
 * - Financial/system tools still require HITL on balanced tier
 * - Dangerous/permissive tiers auto-approve everything
 * - Strict/paranoid tiers default to Tier 3 HITL
 * - change_directory classified as Tier 1 even with hasSideEffects=true
 */

import { describe, it, expect, vi } from 'vitest';
import { parseArgs } from '../cli/parse-args.js';
import {
  OVERDRIVE_STEP_UP_AUTH_CONFIG,
  FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG,
  DEFAULT_STEP_UP_AUTH_CONFIG,
  createStepUpAuthConfigFromTier,
  ToolRiskTier,
} from '../types/core-types.js';
import { StepUpAuthorizationManager } from '../security/StepUpAuthorizationManager.js';
import type {
  AuthorizableTool,
  ToolCallRequest,
  HITLApprovalRequest,
  HITLApprovalDecision,
} from '../security/authorization-types.js';

/** Helper: create a minimal AuthorizableTool. */
const createTool = (overrides: Partial<AuthorizableTool> = {}): AuthorizableTool => ({
  id: 'test_tool',
  displayName: 'Test Tool',
  description: 'A test tool',
  category: 'other',
  hasSideEffects: false,
  ...overrides,
});

/** Helper: create a ToolCallRequest from a tool + optional args/context. */
const createRequest = (
  tool: AuthorizableTool,
  args: Record<string, unknown> = {},
  contextOverrides: Record<string, unknown> = {},
): ToolCallRequest => ({
  tool,
  args,
  context: { userId: 'test', sessionId: 'test', ...contextOverrides },
  timestamp: new Date(),
});

describe('CLI --overdrive flag (E2E)', { timeout: 15_000 }, () => {
  describe('parseArgs', () => {
    it('should parse --overdrive as a boolean flag', () => {
      const { flags } = parseArgs(['chat', '--overdrive']);
      expect(flags['overdrive']).toBe(true);
    });

    it('should not set overdrive when flag is absent', () => {
      const { flags } = parseArgs(['chat']);
      expect(flags['overdrive']).toBeUndefined();
    });

    it('should parse --overdrive alongside other flags', () => {
      const { flags } = parseArgs(['chat', '--overdrive', '--no-skills', '--model', 'gpt-4o']);
      expect(flags['overdrive']).toBe(true);
      expect(flags['no-skills']).toBe(true);
      expect(flags['model']).toBe('gpt-4o');
    });

    it('should keep positional args intact when --overdrive is present', () => {
      const { positional, flags } = parseArgs(['chat', 'my-agent', '--overdrive']);
      expect(positional).toEqual(['chat', 'my-agent']);
      expect(flags['overdrive']).toBe(true);
    });

    it('should parse --overdrive together with --auto-approve-tools', () => {
      const { flags } = parseArgs(['chat', '--overdrive', '--auto-approve-tools']);
      expect(flags['overdrive']).toBe(true);
      expect(flags['auto-approve-tools']).toBe(true);
    });
  });

  describe('overdrive authorization behavior', () => {
    it('should auto-approve navigation tools without HITL on balanced tier', async () => {
      const config = createStepUpAuthConfigFromTier('balanced');
      const hitlCallback = vi.fn();
      const manager = new StepUpAuthorizationManager(config, hitlCallback);

      const navigationTools = ['change_directory', 'list_directory', 'file_read', 'web_search'];

      for (const toolId of navigationTools) {
        const result = await manager.authorize(
          createRequest(
            createTool({ id: toolId, displayName: toolId, hasSideEffects: true }),
            { path: '/home/user/test' },
          ),
        );
        expect(result.authorized).toBe(true);
        expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
      }
      expect(hitlCallback).not.toHaveBeenCalled();
    });

    it('should still require HITL for financial tools on balanced tier', async () => {
      const config = createStepUpAuthConfigFromTier('balanced');
      const hitlCallback = vi.fn<[HITLApprovalRequest], Promise<HITLApprovalDecision>>().mockResolvedValue({
        actionId: 'test',
        approved: true,
        decidedBy: 'user',
        decidedAt: new Date(),
      });
      const manager = new StepUpAuthorizationManager(config, hitlCallback);

      const result = await manager.authorize(
        createRequest(
          createTool({
            id: 'transfer_funds',
            displayName: 'Transfer',
            category: 'financial',
            hasSideEffects: true,
          }),
          { amount: 100 },
        ),
      );
      expect(result.tier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
      expect(hitlCallback).toHaveBeenCalled();
    });

    it('should auto-approve everything on dangerous tier', async () => {
      const config = createStepUpAuthConfigFromTier('dangerous');
      const manager = new StepUpAuthorizationManager(config);

      const result = await manager.authorize(
        createRequest(
          createTool({
            id: 'shell_execute',
            displayName: 'Shell',
            category: 'system',
            hasSideEffects: true,
          }),
          { command: 'rm -rf /' },
        ),
      );
      expect(result.authorized).toBe(true);
      expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
    });

    it('should auto-approve everything on permissive tier', async () => {
      const config = createStepUpAuthConfigFromTier('permissive');
      const manager = new StepUpAuthorizationManager(config);

      const result = await manager.authorize(
        createRequest(
          createTool({
            id: 'shell_execute',
            displayName: 'Shell',
            category: 'system',
            hasSideEffects: true,
          }),
          { command: 'rm -rf /' },
        ),
      );
      expect(result.authorized).toBe(true);
      expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
    });

    it('should use TIER_3 defaults on strict tier', () => {
      const config = createStepUpAuthConfigFromTier('strict');
      expect(config.defaultTier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
    });

    it('should use TIER_3 defaults on paranoid tier', () => {
      const config = createStepUpAuthConfigFromTier('paranoid');
      expect(config.defaultTier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
    });

    it('should classify data_modification as Tier 2 on balanced (overdrive) tier', async () => {
      const config = createStepUpAuthConfigFromTier('balanced');
      const manager = new StepUpAuthorizationManager(config);

      const result = await manager.authorize(
        createRequest(
          createTool({
            id: 'write_file',
            displayName: 'Write File',
            category: 'data_modification',
            hasSideEffects: true,
          }),
          { path: '/tmp/out.txt', content: 'hello' },
        ),
      );
      expect(result.tier).toBe(ToolRiskTier.TIER_2_ASYNC_REVIEW);
      expect(result.authorized).toBe(true);
    });

    it('should not invoke HITL callback on dangerous/permissive tier', async () => {
      for (const tierName of ['dangerous', 'permissive']) {
        const hitlCallback = vi.fn();
        const config = createStepUpAuthConfigFromTier(tierName);
        const manager = new StepUpAuthorizationManager(config, hitlCallback);

        await manager.authorize(
          createRequest(
            createTool({
              id: 'transfer_funds',
              displayName: 'Transfer',
              category: 'financial',
              hasSideEffects: true,
            }),
            { amount: 99999 },
          ),
        );
        expect(hitlCallback).not.toHaveBeenCalled();
      }
    });
  });

  describe('change_directory zero-prompt scenario', () => {
    it('should classify change_directory as TIER_1 even with hasSideEffects=true', () => {
      const config = createStepUpAuthConfigFromTier('balanced');
      const manager = new StepUpAuthorizationManager(config);

      const tier = manager.getRiskTier(
        createRequest(
          createTool({
            id: 'change_directory',
            displayName: 'CD',
            category: 'system',
            hasSideEffects: true,
          }),
          { path: '~/Documents' },
        ),
      );
      expect(tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
    });

    it('should classify discover_capabilities as TIER_1 even with hasSideEffects=true', () => {
      const config = createStepUpAuthConfigFromTier('balanced');
      const manager = new StepUpAuthorizationManager(config);

      const tier = manager.getRiskTier(
        createRequest(
          createTool({
            id: 'discover_capabilities',
            displayName: 'Discover',
            hasSideEffects: true,
          }),
          { query: 'email tools' },
        ),
      );
      expect(tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
    });

    it('should NOT classify shell_execute as TIER_1', () => {
      const config = createStepUpAuthConfigFromTier('balanced');
      const manager = new StepUpAuthorizationManager(config);

      const tier = manager.getRiskTier(
        createRequest(
          createTool({
            id: 'shell_execute',
            displayName: 'Shell',
            hasSideEffects: true,
          }),
          { command: 'echo hello' },
        ),
      );
      expect(tier).not.toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
    });
  });

  describe('config object identity', () => {
    it('balanced tier returns OVERDRIVE_STEP_UP_AUTH_CONFIG', () => {
      const config = createStepUpAuthConfigFromTier('balanced');
      expect(config).toBe(OVERDRIVE_STEP_UP_AUTH_CONFIG);
    });

    it('dangerous tier returns FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG', () => {
      const config = createStepUpAuthConfigFromTier('dangerous');
      expect(config).toBe(FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG);
    });

    it('strict tier returns DEFAULT_STEP_UP_AUTH_CONFIG', () => {
      const config = createStepUpAuthConfigFromTier('strict');
      expect(config).toBe(DEFAULT_STEP_UP_AUTH_CONFIG);
    });

    it('unknown tier falls back to OVERDRIVE config', () => {
      const config = createStepUpAuthConfigFromTier('nonexistent');
      expect(config).toBe(OVERDRIVE_STEP_UP_AUTH_CONFIG);
    });
  });
});
