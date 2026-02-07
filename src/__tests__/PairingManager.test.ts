/**
 * @fileoverview Tests for PairingManager
 * @module wunderland/__tests__/PairingManager.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PairingManager } from '../pairing/PairingManager.js';

describe('PairingManager', () => {
    let manager: PairingManager;
    let testDir: string;

    beforeEach(async () => {
        testDir = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'pairing-test-')
        );
        manager = new PairingManager({
            storeDir: testDir,
            pendingTtlMs: 3600 * 1000, // 1 hour
            maxPending: 5,
            codeLength: 8,
        });
    });

    afterEach(async () => {
        await fs.promises.rm(testDir, { recursive: true, force: true });
    });

    describe('allowlist operations', () => {
        it('should return false for unknown senders', async () => {
            const result = await manager.isAllowed('telegram', 'unknown-user');
            expect(result).toBe(false);
        });

        it('should add and check allowlist entries', async () => {
            await manager.addToAllowlist('telegram', 'user-123');
            const result = await manager.isAllowed('telegram', 'user-123');
            expect(result).toBe(true);
        });

        it('should not duplicate allowlist entries', async () => {
            await manager.addToAllowlist('telegram', 'user-123');
            const { changed } = await manager.addToAllowlist('telegram', 'user-123');
            expect(changed).toBe(false);

            const allowlist = await manager.readAllowlist('telegram');
            expect(allowlist.filter(e => e === 'user-123').length).toBe(1);
        });

        it('should remove allowlist entries', async () => {
            await manager.addToAllowlist('telegram', 'user-to-remove');
            const { changed } = await manager.removeFromAllowlist('telegram', 'user-to-remove');

            expect(changed).toBe(true);
            const isAllowed = await manager.isAllowed('telegram', 'user-to-remove');
            expect(isAllowed).toBe(false);
        });

        it('should handle separate channels independently', async () => {
            await manager.addToAllowlist('telegram', 'user-123');

            const telegramAllowed = await manager.isAllowed('telegram', 'user-123');
            const discordAllowed = await manager.isAllowed('discord', 'user-123');

            expect(telegramAllowed).toBe(true);
            expect(discordAllowed).toBe(false);
        });
    });

    describe('pairing requests', () => {
        it('should create a new pairing request', async () => {
            const { code, created } = await manager.upsertRequest('telegram', 'new-user');

            expect(created).toBe(true);
            expect(code).toHaveLength(8);
            expect(code).toMatch(/^[A-Z0-9]+$/);
        });

        it('should return existing code for same user', async () => {
            const first = await manager.upsertRequest('telegram', 'same-user');
            const second = await manager.upsertRequest('telegram', 'same-user');

            expect(second.created).toBe(false);
            expect(second.code).toBe(first.code);
        });

        it('should list pending requests', async () => {
            await manager.upsertRequest('telegram', 'user-1');
            await manager.upsertRequest('telegram', 'user-2');

            const requests = await manager.listRequests('telegram');

            expect(requests.length).toBe(2);
            expect(requests.some(r => r.id === 'user-1')).toBe(true);
            expect(requests.some(r => r.id === 'user-2')).toBe(true);
        });

        it('should store metadata with requests', async () => {
            await manager.upsertRequest('telegram', 'user-with-meta', {
                displayName: 'Test User',
                username: '@testuser',
            });

            const requests = await manager.listRequests('telegram');
            const request = requests.find(r => r.id === 'user-with-meta');

            expect(request?.meta?.displayName).toBe('Test User');
            expect(request?.meta?.username).toBe('@testuser');
        });
    });

    describe('code approval', () => {
        it('should approve a valid code', async () => {
            const { code } = await manager.upsertRequest('telegram', 'pending-user');
            const result = await manager.approveCode('telegram', code);

            expect(result).not.toBeNull();
            expect(result?.id).toBe('pending-user');

            // Should now be on allowlist
            const isAllowed = await manager.isAllowed('telegram', 'pending-user');
            expect(isAllowed).toBe(true);

            // Should no longer have pending request
            const requests = await manager.listRequests('telegram');
            expect(requests.some(r => r.id === 'pending-user')).toBe(false);
        });

        it('should return null for invalid code', async () => {
            const result = await manager.approveCode('telegram', 'INVALID1');
            expect(result).toBeNull();
        });

        it('should handle case-insensitive codes', async () => {
            const { code } = await manager.upsertRequest('telegram', 'case-user');
            const result = await manager.approveCode('telegram', code.toLowerCase());

            expect(result).not.toBeNull();
            expect(result?.id).toBe('case-user');
        });
    });

    describe('code rejection', () => {
        it('should reject and remove a pending code', async () => {
            const { code } = await manager.upsertRequest('telegram', 'reject-user');
            const rejected = await manager.rejectCode('telegram', code);

            expect(rejected).toBe(true);

            // Should no longer have pending request
            const requests = await manager.listRequests('telegram');
            expect(requests.some(r => r.id === 'reject-user')).toBe(false);

            // Should not be on allowlist
            const isAllowed = await manager.isAllowed('telegram', 'reject-user');
            expect(isAllowed).toBe(false);
        });

        it('should return false for invalid code rejection', async () => {
            const rejected = await manager.rejectCode('telegram', 'NONEXIST');
            expect(rejected).toBe(false);
        });
    });

    describe('max pending limit', () => {
        it('should limit pending requests to maxPending', async () => {
            // Create 5 requests (the max)
            for (let i = 0; i < 5; i++) {
                await manager.upsertRequest('telegram', `user-${i}`);
            }

            // 6th request should fail
            const { code, created } = await manager.upsertRequest('telegram', 'user-overflow');

            expect(code).toBe('');
            expect(created).toBe(false);
        });
    });
});
