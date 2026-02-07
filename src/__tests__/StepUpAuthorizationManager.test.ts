/**
 * @fileoverview Tests for StepUpAuthorizationManager
 * @module wunderland/__tests__/StepUpAuthorizationManager.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StepUpAuthorizationManager } from '../authorization/StepUpAuthorizationManager.js';
import type {
    HITLApprovalRequest,
    HITLApprovalDecision,
    ToolCallRequest,
    AuthorizableTool,
    HITLRequestCallback,
} from '../authorization/types.js';
import { ToolRiskTier } from '../core/types.js';

describe('StepUpAuthorizationManager', () => {
    let manager: StepUpAuthorizationManager;
    let hitlCallback: HITLRequestCallback;

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

    beforeEach(() => {
        hitlCallback = vi.fn<[HITLApprovalRequest], Promise<HITLApprovalDecision>>().mockResolvedValue({
            actionId: 'action-1',
            approved: true,
            decidedBy: 'admin',
            decidedAt: new Date(),
        });

        manager = new StepUpAuthorizationManager(
            {
                defaultTier: ToolRiskTier.TIER_1_AUTONOMOUS,
                toolTierOverrides: {
                    'delete_file': ToolRiskTier.TIER_3_SYNC_HITL,
                    'send_email': ToolRiskTier.TIER_2_ASYNC_REVIEW,
                    'read_file': ToolRiskTier.TIER_1_AUTONOMOUS,
                },
            },
            hitlCallback
        );
    });

    describe('authorize', () => {
        it('should auto-authorize tier 1 tools', async () => {
            const request = createRequest(
                createTool({ id: 'read_file' }),
                { path: '/safe/file.txt' }
            );

            const result = await manager.authorize(request);

            expect(result.authorized).toBe(true);
            expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
            expect(hitlCallback).not.toHaveBeenCalled();
        });

        it('should escalate communication tools due to irreversible action trigger', async () => {
            const request = createRequest(
                createTool({ id: 'send_email', category: 'communication', hasSideEffects: true }),
                { to: 'user@example.com', subject: 'Hello' }
            );

            const result = await manager.authorize(request);

            expect(result.authorized).toBe(true);
            // Note: Communication tools with side effects are escalated to tier 3
            // by the irreversible_action escalation trigger in DEFAULT_STEP_UP_AUTH_CONFIG
            expect(result.tier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
            expect(result.auditRequired).toBe(true);
        });

        it('should require HITL for tier 3 tools', async () => {
            const request = createRequest(
                createTool({ id: 'delete_file', category: 'data_modification', hasSideEffects: true }),
                { path: '/important/data.db' }
            );

            const result = await manager.authorize(request);

            expect(result.tier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
            expect(hitlCallback).toHaveBeenCalled();
            expect(result.authorized).toBe(true); // Because callback returned approved: true
        });

        it('should reject when HITL denies', async () => {
            hitlCallback = vi.fn<[HITLApprovalRequest], Promise<HITLApprovalDecision>>().mockResolvedValue({
                actionId: 'action-1',
                approved: false,
                rejectionReason: 'Too risky',
                decidedBy: 'admin',
                decidedAt: new Date(),
            });

            manager = new StepUpAuthorizationManager(
                {
                    defaultTier: ToolRiskTier.TIER_1_AUTONOMOUS,
                    toolTierOverrides: {
                        'delete_file': ToolRiskTier.TIER_3_SYNC_HITL,
                    },
                },
                hitlCallback
            );

            const request = createRequest(
                createTool({ id: 'delete_file', category: 'data_modification', hasSideEffects: true }),
                { path: '/critical/system.db' }
            );

            const result = await manager.authorize(request);

            expect(result.authorized).toBe(false);
            expect(result.denialReason).toBe('Too risky');
        });
    });

    describe('tier determination', () => {
        it('should use default tier for unknown tools', async () => {
            const request = createRequest(
                createTool({ id: 'unknown_tool' }),
                {}
            );

            const result = await manager.authorize(request);
            expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
        });

        it('should escalate based on tool override', async () => {
            const request = createRequest(
                createTool({ id: 'delete_file', hasSideEffects: true }),
                {}
            );

            // delete_file is overridden to tier 3
            const result = await manager.authorize(request);
            expect(result.tier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
        });

        it('should escalate based on category', async () => {
            const request = createRequest(
                createTool({ id: 'new_financial_tool', category: 'financial', hasSideEffects: true }),
                {}
            );

            // Financial category should be tier 3
            const result = await manager.authorize(request);
            expect(result.tier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
        });
    });

    describe('statistics', () => {
        it('should track authorization statistics', async () => {
            // Make a few authorization requests
            await manager.authorize(createRequest(createTool({ id: 'read_file' })));
            await manager.authorize(createRequest(createTool({ id: 'send_email' })));

            const stats = manager.getStatistics();

            expect(stats.totalRequests).toBe(2);
            expect(stats.authorizedCount).toBe(2);
        });
    });
});
