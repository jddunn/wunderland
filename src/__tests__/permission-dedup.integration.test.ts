/**
 * @fileoverview Integration tests for deduplicated permission gates.
 * Verifies that OVERDRIVE config correctly routes navigation tools to Tier 1
 * (no prompt), financial tools to Tier 3 (HITL prompt), and side-effect tools
 * without a category override to Tier 2 (async review, no prompt).
 *
 * @module wunderland/__tests__/permission-dedup.integration.test
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { StepUpAuthorizationManager } from '../security/StepUpAuthorizationManager.js';
import {
    ToolRiskTier,
    OVERDRIVE_STEP_UP_AUTH_CONFIG,
} from '../core/types.js';
import type {
    AuthorizableTool,
    ToolCallRequest,
    HITLApprovalRequest,
    HITLApprovalDecision,
} from '../security/authorization-types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const createTool = (overrides: Partial<AuthorizableTool> = {}): AuthorizableTool => ({
    id: 'test_tool',
    displayName: 'Test Tool',
    description: 'A test tool',
    category: 'other',
    hasSideEffects: false,
    ...overrides,
});

const createRequest = (
    tool: AuthorizableTool,
    args: Record<string, unknown> = {},
    contextOverrides: Record<string, unknown> = {}
): ToolCallRequest => ({
    tool,
    args,
    context: { userId: 'user-1', sessionId: 'session-1', ...contextOverrides },
    timestamp: new Date(),
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('permission-dedup integration (OVERDRIVE config)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('navigation tool (change_directory) does NOT trigger askPermission', async () => {
        const askPermission = vi.fn<[HITLApprovalRequest], Promise<HITLApprovalDecision>>().mockResolvedValue({
            actionId: 'action-1',
            approved: true,
            decidedBy: 'admin',
            decidedAt: new Date(),
        });

        const manager = new StepUpAuthorizationManager(
            OVERDRIVE_STEP_UP_AUTH_CONFIG,
            askPermission
        );

        const tool = createTool({ id: 'change_directory', hasSideEffects: true });
        const result = await manager.authorize(createRequest(tool));

        expect(result.authorized).toBe(true);
        expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
        expect(askPermission).not.toHaveBeenCalled();
    });

    it('financial tool DOES trigger askPermission (Tier 3)', async () => {
        const askPermission = vi.fn<[HITLApprovalRequest], Promise<HITLApprovalDecision>>().mockResolvedValue({
            actionId: 'action-1',
            approved: true,
            decidedBy: 'admin',
            decidedAt: new Date(),
        });

        const manager = new StepUpAuthorizationManager(
            OVERDRIVE_STEP_UP_AUTH_CONFIG,
            askPermission
        );

        const tool = createTool({
            id: 'transfer_funds',
            hasSideEffects: true,
            category: 'financial',
        });
        const result = await manager.authorize(createRequest(tool));

        expect(result.tier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
        expect(askPermission).toHaveBeenCalled();
        expect(result.authorized).toBe(true);
    });

    it('side-effect tool without category override uses Tier 2 (no prompt)', async () => {
        const askPermission = vi.fn<[HITLApprovalRequest], Promise<HITLApprovalDecision>>().mockResolvedValue({
            actionId: 'action-1',
            approved: true,
            decidedBy: 'admin',
            decidedAt: new Date(),
        });

        const manager = new StepUpAuthorizationManager(
            OVERDRIVE_STEP_UP_AUTH_CONFIG,
            askPermission
        );

        const tool = createTool({
            id: 'browser_click',
            hasSideEffects: true,
            category: 'research', // not in categoryTierOverrides
        });
        const result = await manager.authorize(createRequest(tool));

        // Tier 2 = async review, executes immediately, no HITL prompt
        expect(result.tier).toBe(ToolRiskTier.TIER_2_ASYNC_REVIEW);
        expect(result.authorized).toBe(true);
        expect(askPermission).not.toHaveBeenCalled();
    });

    it('sessionAcceptAll (autoApproveAll) bypasses all prompts', async () => {
        let hitlCalled = false;
        const askPermission = vi.fn<[HITLApprovalRequest], Promise<HITLApprovalDecision>>().mockImplementation(
            async () => {
                hitlCalled = true;
                return {
                    actionId: 'action-1',
                    approved: true,
                    decidedBy: 'admin',
                    decidedAt: new Date(),
                };
            }
        );

        // Start with OVERDRIVE config augmented with autoApproveAll
        const manager = new StepUpAuthorizationManager(
            { ...OVERDRIVE_STEP_UP_AUTH_CONFIG, autoApproveAll: true },
            askPermission
        );

        // Financial tool would normally be Tier 3 with HITL
        const financialTool = createTool({
            id: 'transfer_funds',
            hasSideEffects: true,
            category: 'financial',
        });

        // System tool would also normally be Tier 3
        const systemTool = createTool({
            id: 'rm_rf',
            hasSideEffects: true,
            category: 'system',
        });

        const result1 = await manager.authorize(createRequest(financialTool));
        const result2 = await manager.authorize(createRequest(systemTool));

        expect(result1.authorized).toBe(true);
        expect(result1.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
        expect(result2.authorized).toBe(true);
        expect(result2.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
        expect(hitlCalled).toBe(false);
        expect(askPermission).not.toHaveBeenCalled();
    });
});
