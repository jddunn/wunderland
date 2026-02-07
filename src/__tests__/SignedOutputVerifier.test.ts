/**
 * @fileoverview Tests for SignedOutputVerifier
 * @module wunderland/__tests__/SignedOutputVerifier.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignedOutputVerifier } from '../security/SignedOutputVerifier.js';
import type { IntentChainEntry } from '../core/types.js';

describe('SignedOutputVerifier', () => {
    let verifier: SignedOutputVerifier;

    beforeEach(() => {
        // Set env var for testing
        process.env.WUNDERLAND_SIGNING_SECRET = 'test-secret-key-for-hmac-signing';

        verifier = new SignedOutputVerifier({
            algorithm: 'sha256',
            includeIntentChain: true,
        });
    });

    afterEach(() => {
        delete process.env.WUNDERLAND_SIGNING_SECRET;
    });

    describe('sign', () => {
        it('should sign output with HMAC', () => {
            const content = { text: 'Hello, world!' };
            const intentChain: IntentChainEntry[] = [];
            const context = { seedId: 'test-agent' };

            const signed = verifier.sign(content, intentChain, context);

            expect(signed.signature).toBeDefined();
            expect(signed.signature).toHaveLength(64); // SHA256 hex
            expect(signed.content).toEqual(content);
        });

        it('should include metadata in signed output', () => {
            const content = { text: 'Test' };
            const signed = verifier.sign(content, [], { seedId: 'test-agent' });

            expect(signed.timestamp).toBeDefined();
            expect(signed.seedId).toBe('test-agent');
        });

        it('should generate different signatures for different content', () => {
            const content1 = { text: 'Content A' };
            const content2 = { text: 'Content B' };

            const signed1 = verifier.sign(content1, [], { seedId: 'agent' });
            const signed2 = verifier.sign(content2, [], { seedId: 'agent' });

            expect(signed1.signature).not.toBe(signed2.signature);
        });

        it('should include intent chain in signed output', () => {
            const content = { text: 'Response' };
            const chain: IntentChainEntry[] = [
                {
                    stepId: 'step-1',
                    timestamp: new Date(),
                    action: 'user_input',
                    inputHash: 'abc123',
                    outputHash: 'def456',
                    modelUsed: 'llama3.2:3b',
                    securityFlags: [],
                },
            ];

            const signed = verifier.sign(content, chain, { seedId: 'agent' });

            expect(signed.intentChain).toBeDefined();
            expect(signed.intentChain.length).toBe(1);
        });
    });

    describe('verify', () => {
        it('should verify valid signature', () => {
            const content = { text: 'Signed content' };
            const signed = verifier.sign(content, [], { seedId: 'agent' });

            const isValid = verifier.verify(signed);
            expect(isValid).toBe(true);
        });

        it('should reject tampered content', () => {
            const content = { text: 'Original content' };
            const signed = verifier.sign(content, [], { seedId: 'agent' });

            // Tamper with the content
            signed.content = { text: 'Tampered content' };

            const isValid = verifier.verify(signed);
            expect(isValid).toBe(false);
        });

        it('should reject invalid signature', () => {
            const content = { text: 'Content' };
            const signed = verifier.sign(content, [], { seedId: 'agent' });

            // Corrupt the signature
            signed.signature = 'invalid-signature-hash-that-is-wrong';

            const isValid = verifier.verify(signed);
            expect(isValid).toBe(false);
        });

        it('should reject signature from different key', () => {
            const content = { text: 'Content' };
            const signed = verifier.sign(content, [], { seedId: 'agent' });

            // Change the secret
            process.env.WUNDERLAND_SIGNING_SECRET = 'different-secret-key';
            const verifier2 = new SignedOutputVerifier({});

            const isValid = verifier2.verify(signed);
            expect(isValid).toBe(false);
        });
    });

    describe('extractVerifiedIntentChain', () => {
        it('should extract chain from valid signed output', () => {
            const chain: IntentChainEntry[] = [
                {
                    stepId: 'step-1',
                    timestamp: new Date(),
                    action: 'user_input',
                    inputHash: 'abc',
                    outputHash: 'def',
                    modelUsed: 'llama3.2:3b',
                    securityFlags: [],
                },
                {
                    stepId: 'step-2',
                    timestamp: new Date(),
                    action: 'agent_response',
                    inputHash: 'ghi',
                    outputHash: 'jkl',
                    modelUsed: 'llama3.2:3b',
                    securityFlags: [],
                },
            ];

            const signed = verifier.sign({ text: 'Response' }, chain, { seedId: 'agent' });
            const extracted = verifier.extractVerifiedIntentChain(signed);

            expect(extracted).not.toBeNull();
            expect(extracted?.length).toBe(2);
        });

        it('should return null for tampered output', () => {
            const signed = verifier.sign({ text: 'Content' }, [], { seedId: 'agent' });
            signed.content = { text: 'Tampered' };

            const extracted = verifier.extractVerifiedIntentChain(signed);
            expect(extracted).toBeNull();
        });
    });

    describe('summarizeIntentChain', () => {
        it('should create summary of intent chain', () => {
            const chain: IntentChainEntry[] = [
                {
                    stepId: 'step-1',
                    timestamp: new Date('2026-01-01T00:00:00Z'),
                    action: 'user_input',
                    inputHash: 'abc',
                    outputHash: 'def',
                    modelUsed: 'llama3.2:3b',
                    securityFlags: [],
                },
                {
                    stepId: 'step-2',
                    timestamp: new Date('2026-01-01T00:00:01Z'),
                    action: 'tool_call',
                    inputHash: 'ghi',
                    outputHash: 'jkl',
                    modelUsed: 'dolphin-llama3:8b',
                    securityFlags: ['elevated_risk'],
                },
            ];

            const summary = verifier.summarizeIntentChain(chain);

            expect(summary.stepCount).toBe(2);
            expect(summary.uniqueActions).toContain('user_input');
            expect(summary.uniqueActions).toContain('tool_call');
            expect(summary.modelsUsed).toContain('llama3.2:3b');
            expect(summary.modelsUsed).toContain('dolphin-llama3:8b');
            expect(summary.securityFlags).toContain('elevated_risk');
        });
    });

    describe('validateIntentChainLogic', () => {
        it('should validate consistent chain', () => {
            const chain: IntentChainEntry[] = [
                {
                    stepId: 'step-1',
                    timestamp: new Date('2026-01-01T00:00:00Z'),
                    action: 'user_input',
                    inputHash: 'abc',
                    outputHash: 'def',
                    modelUsed: 'llama3.2:3b',
                    securityFlags: [],
                },
                {
                    stepId: 'step-2',
                    timestamp: new Date('2026-01-01T00:00:01Z'),
                    action: 'agent_response',
                    inputHash: 'ghi',
                    outputHash: 'jkl',
                    modelUsed: 'llama3.2:3b',
                    securityFlags: [],
                },
            ];

            const validation = verifier.validateIntentChainLogic(chain);

            expect(validation.valid).toBe(true);
            expect(validation.issues.length).toBe(0);
        });
    });

    describe('configuration', () => {
        it('should expose current configuration', () => {
            const config = verifier.getConfig();

            expect(config.algorithm).toBe('sha256');
            expect(config.includeIntentChain).toBe(true);
        });

        it('should allow updating configuration', () => {
            verifier.updateConfig({ maxIntentChainEntries: 50 });
            const config = verifier.getConfig();

            expect(config.maxIntentChainEntries).toBe(50);
        });
    });
});
