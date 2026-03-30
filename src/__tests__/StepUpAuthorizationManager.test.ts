/**
 * @fileoverview Tests for StepUpAuthorizationManager
 * @module wunderland/__tests__/StepUpAuthorizationManager.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StepUpAuthorizationManager } from '../security/StepUpAuthorizationManager.js';
import type {
    HITLApprovalRequest,
    HITLApprovalDecision,
    ToolCallRequest,
    AuthorizableTool,
    HITLRequestCallback,
} from '../security/authorization-types.js';
import {
    ToolRiskTier,
    FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG,
    OVERDRIVE_STEP_UP_AUTH_CONFIG,
    DEFAULT_STEP_UP_AUTH_CONFIG,
    createStepUpAuthConfigFromTier,
} from '../core/types.js';

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

    describe('OVERDRIVE_STEP_UP_AUTH_CONFIG', () => {
        it('should have TIER_2_ASYNC_REVIEW as default tier', () => {
            expect(OVERDRIVE_STEP_UP_AUTH_CONFIG.defaultTier).toBe(ToolRiskTier.TIER_2_ASYNC_REVIEW);
        });

        it('should have toolTierOverrides for navigation tools', () => {
            const overrides = OVERDRIVE_STEP_UP_AUTH_CONFIG.toolTierOverrides!;
            expect(overrides).toBeDefined();
            expect(overrides['list_directory']).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
            expect(overrides['change_directory']).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
            expect(overrides['file_read']).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
            expect(overrides['read_file']).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
            expect(overrides['read_document']).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
            expect(overrides['file_search']).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
            expect(overrides['file_info']).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
        });

        it('should have financial category as TIER_3_SYNC_HITL', () => {
            expect(OVERDRIVE_STEP_UP_AUTH_CONFIG.categoryTierOverrides!.financial).toBe(
                ToolRiskTier.TIER_3_SYNC_HITL
            );
        });

        it('should have system category as TIER_3_SYNC_HITL', () => {
            expect(OVERDRIVE_STEP_UP_AUTH_CONFIG.categoryTierOverrides!.system).toBe(
                ToolRiskTier.TIER_3_SYNC_HITL
            );
        });

        it('should have non-empty escalation triggers', () => {
            expect(OVERDRIVE_STEP_UP_AUTH_CONFIG.escalationTriggers).toBeDefined();
            expect(OVERDRIVE_STEP_UP_AUTH_CONFIG.escalationTriggers!.length).toBeGreaterThan(0);
        });

        it('should authorize navigation tools as Tier 1 autonomous without HITL', async () => {
            const mockHitl = vi.fn();
            const overdriveManager = new StepUpAuthorizationManager(
                OVERDRIVE_STEP_UP_AUTH_CONFIG,
                mockHitl
            );

            const navigationTools = ['change_directory', 'list_directory', 'file_read'];
            for (const toolId of navigationTools) {
                const result = await overdriveManager.authorize(
                    createRequest(createTool({ id: toolId, hasSideEffects: true }))
                );
                expect(result.authorized).toBe(true);
                expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
            }
            expect(mockHitl).not.toHaveBeenCalled();
        });

        it('should classify side-effect tools without category override as Tier 2', async () => {
            const overdriveManager = new StepUpAuthorizationManager(OVERDRIVE_STEP_UP_AUTH_CONFIG);

            const result = await overdriveManager.authorize(
                createRequest(createTool({ id: 'some_custom_tool', hasSideEffects: true, category: 'research' }))
            );
            expect(result.tier).toBe(ToolRiskTier.TIER_2_ASYNC_REVIEW);
            expect(result.authorized).toBe(true);
        });

        it('should classify financial tools as Tier 3', async () => {
            const mockHitl = vi.fn<[HITLApprovalRequest], Promise<HITLApprovalDecision>>().mockResolvedValue({
                actionId: 'action-1',
                approved: true,
                decidedBy: 'admin',
                decidedAt: new Date(),
            });
            const overdriveManager = new StepUpAuthorizationManager(
                OVERDRIVE_STEP_UP_AUTH_CONFIG,
                mockHitl
            );

            const result = await overdriveManager.authorize(
                createRequest(createTool({ id: 'transfer_money', hasSideEffects: true, category: 'financial' }))
            );
            expect(result.tier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
            expect(mockHitl).toHaveBeenCalled();
        });
    });

    describe('createStepUpAuthConfigFromTier', () => {
        it('should return FULLY_AUTONOMOUS config for dangerous tier', () => {
            const config = createStepUpAuthConfigFromTier('dangerous');
            expect(config.autoApproveAll).toBe(true);
            expect(config).toBe(FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG);
        });

        it('should return FULLY_AUTONOMOUS config for permissive tier', () => {
            const config = createStepUpAuthConfigFromTier('permissive');
            expect(config.autoApproveAll).toBe(true);
            expect(config).toBe(FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG);
        });

        it('should return OVERDRIVE config for balanced tier', () => {
            const config = createStepUpAuthConfigFromTier('balanced');
            expect(config.defaultTier).toBe(ToolRiskTier.TIER_2_ASYNC_REVIEW);
            expect(config).toBe(OVERDRIVE_STEP_UP_AUTH_CONFIG);
        });

        it('should return DEFAULT config for strict tier', () => {
            const config = createStepUpAuthConfigFromTier('strict');
            expect(config.defaultTier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
            expect(config).toBe(DEFAULT_STEP_UP_AUTH_CONFIG);
        });

        it('should return DEFAULT config for paranoid tier', () => {
            const config = createStepUpAuthConfigFromTier('paranoid');
            expect(config.defaultTier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
            expect(config).toBe(DEFAULT_STEP_UP_AUTH_CONFIG);
        });

        it('should return OVERDRIVE config for unknown tier (default fallback)', () => {
            const config = createStepUpAuthConfigFromTier('nonexistent');
            expect(config.defaultTier).toBe(ToolRiskTier.TIER_2_ASYNC_REVIEW);
            expect(config).toBe(OVERDRIVE_STEP_UP_AUTH_CONFIG);
        });
    });

    describe('SAFE_NAVIGATION_TOOLS behavior', () => {
        it('should classify change_directory with hasSideEffects=true as TIER_1 with OVERDRIVE config', async () => {
            const overdriveManager = new StepUpAuthorizationManager(OVERDRIVE_STEP_UP_AUTH_CONFIG);
            const result = await overdriveManager.authorize(
                createRequest(createTool({ id: 'change_directory', hasSideEffects: true }))
            );
            expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
        });

        it('should classify list_directory with hasSideEffects=true as TIER_1 with OVERDRIVE config', async () => {
            const overdriveManager = new StepUpAuthorizationManager(OVERDRIVE_STEP_UP_AUTH_CONFIG);
            const result = await overdriveManager.authorize(
                createRequest(createTool({ id: 'list_directory', hasSideEffects: true }))
            );
            expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
        });

        it('should classify file_read with hasSideEffects=true as TIER_1 with OVERDRIVE config', async () => {
            const overdriveManager = new StepUpAuthorizationManager(OVERDRIVE_STEP_UP_AUTH_CONFIG);
            const result = await overdriveManager.authorize(
                createRequest(createTool({ id: 'file_read', hasSideEffects: true }))
            );
            expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
        });

        it('should classify read_document with hasSideEffects=true as TIER_1 with OVERDRIVE config', async () => {
            const overdriveManager = new StepUpAuthorizationManager(OVERDRIVE_STEP_UP_AUTH_CONFIG);
            const result = await overdriveManager.authorize(
                createRequest(createTool({ id: 'read_document', hasSideEffects: true }))
            );
            expect(result.tier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
        });

        it('should NOT classify shell_execute with hasSideEffects=true as TIER_1', async () => {
            const overdriveManager = new StepUpAuthorizationManager(OVERDRIVE_STEP_UP_AUTH_CONFIG);
            const result = await overdriveManager.authorize(
                createRequest(createTool({ id: 'shell_execute', hasSideEffects: true }))
            );
            expect(result.tier).not.toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
            // shell_execute is not in toolTierOverrides, so it falls to default (TIER_2)
            expect(result.tier).toBe(ToolRiskTier.TIER_2_ASYNC_REVIEW);
        });

        it('should use default tier for unknown tool with hasSideEffects=true', async () => {
            const overdriveManager = new StepUpAuthorizationManager(OVERDRIVE_STEP_UP_AUTH_CONFIG);
            const result = await overdriveManager.authorize(
                createRequest(createTool({ id: 'totally_unknown_tool', hasSideEffects: true }))
            );
            // Not in overrides, no category override, falls to OVERDRIVE default = TIER_2
            expect(result.tier).toBe(ToolRiskTier.TIER_2_ASYNC_REVIEW);
        });
    });
});
