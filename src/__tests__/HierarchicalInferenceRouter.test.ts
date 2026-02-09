/**
 * @fileoverview Tests for HierarchicalInferenceRouter
 * @module wunderland/__tests__/HierarchicalInferenceRouter.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HierarchicalInferenceRouter } from '../inference/HierarchicalInferenceRouter.js';
import type { ModelTarget } from '../core/types.js';

describe('HierarchicalInferenceRouter', () => {
    let router: HierarchicalInferenceRouter;
    let mockInvokeModel: ReturnType<typeof vi.fn>;

    const routerModel: ModelTarget = {
        providerId: 'ollama',
        modelId: 'llama3.2:3b',
        role: 'router',
    };

    const primaryModel: ModelTarget = {
        providerId: 'ollama',
        modelId: 'dolphin-llama3:8b',
        role: 'primary',
    };

    beforeEach(() => {
        mockInvokeModel = vi.fn();

        router = new HierarchicalInferenceRouter(
            {
                hierarchy: {
                    routerModel,
                    primaryModel,
                    auditorModel: routerModel, // Use router as auditor too
                    enableRouterModel: true,
                },
            },
            mockInvokeModel
        );
    });

    describe('route', () => {
        it('should route simple queries to router model', async () => {
            mockInvokeModel.mockResolvedValueOnce(JSON.stringify({
                complexity: 'simple',
                reasoning: 'Simple greeting',
                requiresTools: false,
            }));

            const result = await router.route('Hi there');

            expect(result.targetModel.modelId).toBe('llama3.2:3b');
            expect(result.complexity).toBe('simple');
        });

        it('should escalate complex queries to primary model', async () => {
            mockInvokeModel.mockResolvedValueOnce(JSON.stringify({
                complexity: 'complex',
                reasoning: 'Multi-step analysis required',
                requiresTools: true,
            }));

            const result = await router.route(
                'Analyze the implications of quantum computing on modern cryptography and provide a comprehensive roadmap'
            );

            expect(result.targetModel.modelId).toBe('dolphin-llama3:8b');
            expect(result.complexity).toBe('complex');
        });

        it('should include routing reason in decision', async () => {
            mockInvokeModel.mockResolvedValueOnce(JSON.stringify({
                complexity: 'moderate',
                reasoning: 'Requires some domain knowledge',
                requiresTools: false,
            }));

            const result = await router.route('Explain how transformers work');

            expect(result.routingReason).toBeDefined();
            expect(typeof result.routingReason).toBe('string');
        });
    });

    describe('analyzeComplexity', () => {
        it('should analyze input complexity', async () => {
            mockInvokeModel.mockResolvedValueOnce(JSON.stringify({
                complexity: 'simple',
                reasoning: 'Basic question',
                requiresTools: false,
            }));

            const analysis = await router.analyzeComplexity('What is 2+2?');

            expect(analysis.level).toBe('simple');
            expect(analysis.requiresTools).toBe(false);
        });

        it('should detect code/technical content as complex', async () => {
            mockInvokeModel.mockResolvedValueOnce(JSON.stringify({
                complexity: 'complex',
                reasoning: 'Code debugging requires deep analysis',
                requiresTools: true,
            }));

            const analysis = await router.analyzeComplexity(
                'Debug this code: const x = async () => { await Promise.all([...]) }'
            );

            expect(analysis.level).toBe('complex');
        });
    });

    describe('heuristic fallback', () => {
        it('should fallback to heuristics when LLM fails', async () => {
            mockInvokeModel.mockRejectedValueOnce(new Error('Model unavailable'));

            // Long complex query should be detected as complex via heuristics
            const result = await router.route(
                'This is a very long and detailed question that requires extensive analysis ' +
                'of multiple factors and considerations spanning various domains of knowledge ' +
                'including multi-step reasoning and tool usage for data retrieval. ' +
                'Please provide comprehensive analysis with code examples and citations.'
            );

            // Should still return a decision via heuristics
            expect(result.targetModel).toBeDefined();
        });

        it('should handle short simple inputs via heuristics', async () => {
            mockInvokeModel.mockRejectedValueOnce(new Error('Model unavailable'));

            const result = await router.route('Hello');

            expect(result.targetModel.modelId).toBe('llama3.2:3b');
        });
    });

    describe('statistics', () => {
        it('should track routing statistics', async () => {
            mockInvokeModel.mockResolvedValue(JSON.stringify({
                complexity: 'simple',
                reasoning: 'Simple',
                requiresTools: false,
            }));

            await router.route('Query 1');
            await router.route('Query 2');
            await router.route('Query 3');

            const stats = router.getStatistics();

            expect(stats.totalRequests).toBe(3);
        });

        it('should reset statistics', async () => {
            mockInvokeModel.mockResolvedValue(JSON.stringify({
                complexity: 'simple',
                reasoning: 'Simple',
                requiresTools: false,
            }));

            await router.route('Query');
            router.resetStatistics();

            const stats = router.getStatistics();
            expect(stats.totalRequests).toBe(0);
        });
    });

    describe('cache', () => {
        it('should cache routing decisions', async () => {
            mockInvokeModel.mockResolvedValueOnce(JSON.stringify({
                complexity: 'simple',
                reasoning: 'Simple query',
                requiresTools: false,
            }));

            // First call
            await router.route('Same query');

            // Second call with same query should use cache
            await router.route('Same query');

            // Model should only be called once
            expect(mockInvokeModel).toHaveBeenCalledTimes(1);
        });

        it('should clear cache when requested', async () => {
            mockInvokeModel.mockResolvedValue(JSON.stringify({
                complexity: 'simple',
                reasoning: 'Simple',
                requiresTools: false,
            }));

            await router.route('Query');
            router.clearCache();

            await router.route('Query');

            // Should be called twice after cache clear
            expect(mockInvokeModel).toHaveBeenCalledTimes(2);
        });
    });

    describe('configuration', () => {
        it('should expose current hierarchy', () => {
            const hierarchy = router.getHierarchy();

            expect(hierarchy.routerModel.modelId).toBe('llama3.2:3b');
            expect(hierarchy.primaryModel.modelId).toBe('dolphin-llama3:8b');
        });
    });
});
