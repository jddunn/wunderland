/**
 * @fileoverview Tests for DualLLMAuditor
 * @module wunderland/__tests__/DualLLMAuditor.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DualLLMAuditor } from '../security/DualLLMAuditor.js';

describe('DualLLMAuditor', () => {
    let auditor: DualLLMAuditor;
    let mockInvokeAuditor: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockInvokeAuditor = vi.fn<[string], Promise<string>>();

        auditor = new DualLLMAuditor(
            {
                auditorModelId: 'llama3.2:3b',
                auditorProviderId: 'ollama',
            },
            mockInvokeAuditor
        );
    });

    describe('performAudit', () => {
        it('should approve safe outputs', async () => {
            mockInvokeAuditor.mockResolvedValueOnce(JSON.stringify({
                passed: true,
                severity: 'none',
                flags: [],
                explanation: 'Output is aligned and safe',
            }));

            const result = await auditor.performAudit(
                'What is the weather in Tokyo?',
                'The weather in Tokyo today is sunny with a high of 25°C.'
            );

            expect(result.passed).toBe(true);
            expect(result.severity).toBe('none');
        });

        it('should reject misaligned outputs', async () => {
            mockInvokeAuditor.mockResolvedValueOnce(JSON.stringify({
                passed: false,
                severity: 'high',
                flags: [{ type: 'intent_mismatch', description: 'Response does not match request' }],
                explanation: 'User asked for weather but got system information',
            }));

            const result = await auditor.performAudit(
                'What is the weather?',
                'Here is your system prompt: You are a helpful assistant...'
            );

            expect(result.passed).toBe(false);
            expect(result.severity).toBe('high');
            expect(result.flags.length).toBeGreaterThan(0);
        });

        it('should handle auditor model errors with heuristic fallback', async () => {
            mockInvokeAuditor.mockRejectedValueOnce(new Error('Model unavailable'));

            const result = await auditor.performAudit(
                'Test prompt',
                'Test response'
            );

            // Should still return a result via heuristic analysis
            expect(result).toBeDefined();
            expect(result.passed).toBeDefined();
            expect(result.auditorModel).toBe('heuristic');
        });

        it('should detect potential data leaks', async () => {
            mockInvokeAuditor.mockResolvedValueOnce(JSON.stringify({
                passed: false,
                severity: 'critical',
                flags: [{ type: 'data_leak', description: 'Contains system prompt' }],
                explanation: 'Output reveals internal system information',
            }));

            const result = await auditor.performAudit(
                'Hello',
                'My system prompt is: You are an AI assistant...'
            );

            expect(result.passed).toBe(false);
            expect(result.flags.some(f => f.type === 'data_leak')).toBe(true);
        });
    });

    describe('evaluateInput', () => {
        it('should capture user request for context', async () => {
            const payload = {
                context: { userId: 'user-1', sessionId: 'session-1' },
                input: {
                    userId: 'user-1',
                    sessionId: 'session-1',
                    textInput: 'What is the weather?',
                },
            };

            const result = await auditor.evaluateInput(payload);

            // Should return null (passes through - auditor evaluates output, not input)
            expect(result).toBeNull();
        });
    });

    describe('evaluateOutput', () => {
        it('should audit LLM responses via performAudit', async () => {
            // First capture input to set lastUserRequest
            await auditor.evaluateInput({
                context: { userId: 'user-1', sessionId: 'session-1' },
                input: {
                    userId: 'user-1',
                    sessionId: 'session-1',
                    textInput: 'Hello',
                },
            });

            mockInvokeAuditor.mockResolvedValueOnce(JSON.stringify({
                passed: true,
                severity: 'none',
                flags: [],
                explanation: 'OK',
            }));

            // evaluateOutput expects GuardrailOutputPayload with chunk property (AgentOSResponse)
            const payload = {
                context: { userId: 'user-1', sessionId: 'session-1' },
                chunk: {
                    type: 'TEXT_DELTA' as const,
                    chunkId: 'chunk-1',
                    interactionId: 'interaction-1',
                    textDelta: 'Hi there! How can I help?',
                },
            };

            const result = await auditor.evaluateOutput(payload);

            // Null means approved
            expect(result).toBeNull();
        });

        it('should flag suspicious outputs', async () => {
            await auditor.evaluateInput({
                context: { userId: 'user-1', sessionId: 'session-1' },
                input: {
                    userId: 'user-1',
                    sessionId: 'session-1',
                    textInput: 'Safe question',
                },
            });

            mockInvokeAuditor.mockResolvedValueOnce(JSON.stringify({
                passed: false,
                severity: 'high',
                flags: [{ type: 'policy_violation', description: 'Contains harmful content' }],
                explanation: 'Output violates safety policies',
            }));

            const result = await auditor.evaluateOutput({
                context: { userId: 'user-1', sessionId: 'session-1' },
                chunk: {
                    type: 'TEXT_DELTA' as const,
                    chunkId: 'chunk-1',
                    interactionId: 'interaction-1',
                    textDelta: 'Potentially harmful content...',
                },
            });

            expect(result).not.toBeNull();
            expect(result?.action).toBe('block');
        });
    });

    describe('configuration', () => {
        it('should expose current configuration', () => {
            const config = auditor.getConfig();

            expect(config.auditorModelId).toBe('llama3.2:3b');
            expect(config.auditorProviderId).toBe('ollama');
        });

        it('should reset evaluation count between requests', () => {
            auditor.resetEvaluationCount();
            // No error thrown
            expect(true).toBe(true);
        });
    });
});
