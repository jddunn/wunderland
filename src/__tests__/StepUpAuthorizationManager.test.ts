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
import { ToolRiskTier, FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG } from '../core/types.js';

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

    describe('getRiskTier', () => {
        it('returns Tier 1 for read-only tools by default', () => {
            const defaultManager = new StepUpAuthorizationManager();
            const tier = defaultManager.getRiskTier(createRequest(createTool({ hasSideEffects: false, category: 'research' })));
            expect(tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
        });

        it('returns Tier 3 for side-effect tools without explicit overrides', () => {
            const defaultManager = new StepUpAuthorizationManager();
            const tier = defaultManager.getRiskTier(createRequest(createTool({ hasSideEffects: true, category: 'research' })));
            expect(tier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
        });

        it('returns Tier 3 for system-category tools even when read-only', () => {
            const defaultManager = new StepUpAuthorizationManager();
            const tier = defaultManager.getRiskTier(createRequest(createTool({ hasSideEffects: false, category: 'system' })));
            expect(tier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
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

    describe('autoApproveAll mode', () => {
        it('should auto-approve all tools when autoApproveAll is true', async () => {
            const autoManager = new StepUpAuthorizationManager({
                autoApproveAll: true,
                defaultTier: ToolRiskTier.TIER_3_SYNC_HITL, // would normally block
            });

            // Side-effect tool with financial category — normally Tier 3
            const request = createRequest(
                createTool({ id: 'transfer-funds', category: 'financial', hasSideEffects: true }),
                { amount: 10000, currency: 'USD' }
            );

            const result = await autoManager.authorize(request);
            expect(result.authorized).toBe(true);
            expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
            expect(result.auditRequired).toBe(false);
        });

        it('should auto-approve destructive tools when autoApproveAll is true', async () => {
            const autoManager = new StepUpAuthorizationManager({ autoApproveAll: true });

            const request = createRequest(
                createTool({ id: 'rm_rf', category: 'system', hasSideEffects: true }),
                { path: '/important/data' }
            );

            const result = await autoManager.authorize(request);
            expect(result.authorized).toBe(true);
            expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
        });

        it('should not invoke HITL callback when autoApproveAll is true', async () => {
            const mockHitl = vi.fn();
            const autoManager = new StepUpAuthorizationManager(
                { autoApproveAll: true },
                mockHitl
            );

            const request = createRequest(
                createTool({ id: 'delete_file', category: 'financial', hasSideEffects: true }),
                {}
            );

            await autoManager.authorize(request);
            expect(mockHitl).not.toHaveBeenCalled();
        });

        it('should skip escalation triggers when autoApproveAll is true', async () => {
            const autoManager = new StepUpAuthorizationManager({
                autoApproveAll: true,
                escalationTriggers: [
                    { condition: 'sensitive_data_detected', escalateTo: ToolRiskTier.TIER_3_SYNC_HITL },
                ],
            });

            // Args contain credit card pattern — normally would trigger escalation
            const request = createRequest(
                createTool({ id: 'process_payment', hasSideEffects: true }),
                { cardNumber: '4111-1111-1111-1111' }
            );

            const result = await autoManager.authorize(request);
            expect(result.authorized).toBe(true);
            expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
        });

        it('should track statistics correctly in autoApproveAll mode', async () => {
            const autoManager = new StepUpAuthorizationManager({ autoApproveAll: true });

            await autoManager.authorize(createRequest(createTool({ id: 'tool_1' })));
            await autoManager.authorize(createRequest(createTool({ id: 'tool_2', hasSideEffects: true })));
            await autoManager.authorize(createRequest(createTool({ id: 'tool_3', category: 'financial' })));

            const stats = autoManager.getStatistics();
            expect(stats.totalRequests).toBe(3);
            expect(stats.authorizedCount).toBe(3);
            expect(stats.deniedCount).toBe(0);
            expect(stats.requestsByTier[ToolRiskTier.TIER_1_AUTONOMOUS]).toBe(3);
        });
    });

    describe('FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG', () => {
        it('should have autoApproveAll set to true', () => {
            expect(FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG.autoApproveAll).toBe(true);
        });

        it('should have Tier 1 as default tier', () => {
            expect(FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG.defaultTier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
        });

        it('should have empty escalation triggers', () => {
            expect(FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG.escalationTriggers).toEqual([]);
        });

        it('should have empty category overrides', () => {
            expect(FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG.categoryTierOverrides).toEqual({});
        });

        it('should auto-approve everything when used with StepUpAuthorizationManager', async () => {
            const manager = new StepUpAuthorizationManager(FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG);

            const tools = [
                createTool({ id: 'read_file' }),
                createTool({ id: 'write_file', hasSideEffects: true, category: 'data_modification' }),
                createTool({ id: 'send_email', hasSideEffects: true, category: 'communication' }),
                createTool({ id: 'transfer_funds', hasSideEffects: true, category: 'financial' }),
                createTool({ id: 'system_admin', hasSideEffects: true, category: 'system' }),
                createTool({ id: 'run_build', hasSideEffects: true, category: 'system' }),
            ];

            for (const tool of tools) {
                const result = await manager.authorize(createRequest(tool));
                expect(result.authorized).toBe(true);
                expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
            }
        });
    });
});
