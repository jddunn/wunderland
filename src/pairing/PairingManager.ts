/**
 * @fileoverview Pairing manager - Ported from OpenClaw
 * @module wunderland/pairing/PairingManager
 *
 * Manages pairing codes for unknown senders to authenticate
 * with the AI assistant.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
    PairingChannel,
    PairingRequest,
    PairingStore,
    AllowFromStore,
    PairingConfig,
    UpsertResult,
    ApproveResult,
} from './types.js';

const DEFAULT_CODE_LENGTH = 8;
const DEFAULT_PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_PENDING = 3;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars

/**
 * Pairing manager for authenticating unknown channel senders.
 *
 * When a message comes from an unknown sender, the manager generates
 * a pairing code. The user can approve the code via CLI or admin UI,
 * which adds the sender to the allowlist.
 *
 * @example
 * ```typescript
 * const pairing = new PairingManager({ storeDir: '/path/to/data' });
 *
 * // Unknown sender sends a message
 * const { code, created } = await pairing.upsertRequest('telegram', 'user-123');
 * console.log(`Reply: "Your pairing code is ${code}. Please ask the assistant owner to approve."`);
 *
 * // Owner approves via CLI
 * const result = await pairing.approveCode('telegram', code);
 * console.log(`Approved: ${result?.id}`);
 *
 * // Future messages from this user are allowed
 * const isAllowed = await pairing.isAllowed('telegram', 'user-123');
 * ```
 */
export class PairingManager {
    private readonly storeDir: string;
    private readonly pendingTtlMs: number;
    private readonly maxPending: number;
    private readonly codeLength: number;

    constructor(config: PairingConfig) {
        this.storeDir = config.storeDir;
        this.pendingTtlMs = config.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
        this.maxPending = config.maxPending ?? DEFAULT_MAX_PENDING;
        this.codeLength = config.codeLength ?? DEFAULT_CODE_LENGTH;
    }

    // ============================================================================
    // Allowlist Operations
    // ============================================================================

    /**
     * Checks if a sender is on the allowlist.
     */
    async isAllowed(channel: PairingChannel, senderId: string): Promise<boolean> {
        const allowlist = await this.readAllowlist(channel);
        const normalized = this.normalizeId(senderId);
        return allowlist.includes(normalized);
    }

    /**
     * Reads the allowlist for a channel.
     */
    async readAllowlist(channel: PairingChannel): Promise<string[]> {
        const filePath = this.resolveAllowlistPath(channel);
        const store = await this.readJsonFile<AllowFromStore>(filePath, {
            version: 1,
            allowFrom: [],
        });
        return store.allowFrom.map((e) => this.normalizeId(e)).filter(Boolean);
    }

    /**
     * Adds an entry to the allowlist.
     */
    async addToAllowlist(
        channel: PairingChannel,
        entry: string
    ): Promise<{ changed: boolean; allowFrom: string[] }> {
        const filePath = this.resolveAllowlistPath(channel);
        const store = await this.readJsonFile<AllowFromStore>(filePath, {
            version: 1,
            allowFrom: [],
        });

        const current = store.allowFrom.map((e) => this.normalizeId(e)).filter(Boolean);
        const normalized = this.normalizeId(entry);

        if (!normalized || current.includes(normalized)) {
            return { changed: false, allowFrom: current };
        }

        const next = [...current, normalized];
        await this.writeJsonFile(filePath, { version: 1, allowFrom: next });
        return { changed: true, allowFrom: next };
    }

    /**
     * Removes an entry from the allowlist.
     */
    async removeFromAllowlist(
        channel: PairingChannel,
        entry: string
    ): Promise<{ changed: boolean; allowFrom: string[] }> {
        const filePath = this.resolveAllowlistPath(channel);
        const store = await this.readJsonFile<AllowFromStore>(filePath, {
            version: 1,
            allowFrom: [],
        });

        const current = store.allowFrom.map((e) => this.normalizeId(e)).filter(Boolean);
        const normalized = this.normalizeId(entry);
        const next = current.filter((e) => e !== normalized);

        if (next.length === current.length) {
            return { changed: false, allowFrom: current };
        }

        await this.writeJsonFile(filePath, { version: 1, allowFrom: next });
        return { changed: true, allowFrom: next };
    }

    // ============================================================================
    // Pairing Request Operations
    // ============================================================================

    /**
     * Lists pending pairing requests for a channel.
     */
    async listRequests(channel: PairingChannel): Promise<PairingRequest[]> {
        const filePath = this.resolvePairingPath(channel);
        const store = await this.readJsonFile<PairingStore>(filePath, {
            version: 1,
            requests: [],
        });

        const now = Date.now();
        const { requests: pruned, removed } = this.pruneExpired(store.requests, now);
        const { requests: capped, removed: cappedRemoved } = this.pruneExcess(pruned);

        if (removed || cappedRemoved) {
            await this.writeJsonFile(filePath, { version: 1, requests: capped });
        }

        return capped
            .filter((r) => r && r.id && r.code && r.createdAt)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    /**
     * Creates or updates a pairing request for a sender.
     */
    async upsertRequest(
        channel: PairingChannel,
        senderId: string,
        meta?: Record<string, string>
    ): Promise<UpsertResult> {
        const filePath = this.resolvePairingPath(channel);
        const store = await this.readJsonFile<PairingStore>(filePath, {
            version: 1,
            requests: [],
        });

        const now = new Date().toISOString();
        const nowMs = Date.now();
        const id = this.normalizeId(senderId);

        // Prune expired
        let requests = store.requests.filter((r) => !this.isExpired(r, nowMs));

        // Check for existing
        const existingIdx = requests.findIndex((r) => r.id === id);
        const existingCodes = new Set(requests.map((r) => r.code?.toUpperCase()));

        if (existingIdx >= 0) {
            // Update existing
            const existing = requests[existingIdx];
            const code = existing.code || this.generateUniqueCode(existingCodes);

            requests[existingIdx] = {
                id,
                code,
                createdAt: existing.createdAt ?? now,
                lastSeenAt: now,
                meta: meta ?? existing.meta,
            };

            requests = this.pruneExcess(requests).requests;
            await this.writeJsonFile(filePath, { version: 1, requests });
            return { code, created: false };
        }

        // Cap pending requests
        requests = this.pruneExcess(requests).requests;
        if (this.maxPending > 0 && requests.length >= this.maxPending) {
            await this.writeJsonFile(filePath, { version: 1, requests });
            return { code: '', created: false };
        }

        // Create new
        const code = this.generateUniqueCode(existingCodes);
        const newRequest: PairingRequest = {
            id,
            code,
            createdAt: now,
            lastSeenAt: now,
            ...(meta ? { meta } : {}),
        };

        requests.push(newRequest);
        await this.writeJsonFile(filePath, { version: 1, requests });
        return { code, created: true };
    }

    /**
     * Approves a pairing code and adds the sender to the allowlist.
     */
    async approveCode(
        channel: PairingChannel,
        code: string
    ): Promise<ApproveResult | null> {
        const normalizedCode = code.trim().toUpperCase();
        if (!normalizedCode) {
            return null;
        }

        const filePath = this.resolvePairingPath(channel);
        const store = await this.readJsonFile<PairingStore>(filePath, {
            version: 1,
            requests: [],
        });

        const nowMs = Date.now();
        const pruned = store.requests.filter((r) => !this.isExpired(r, nowMs));
        const idx = pruned.findIndex((r) => r.code?.toUpperCase() === normalizedCode);

        if (idx < 0) {
            // Code not found - save pruned anyway
            await this.writeJsonFile(filePath, { version: 1, requests: pruned });
            return null;
        }

        const entry = pruned[idx];
        pruned.splice(idx, 1);

        await this.writeJsonFile(filePath, { version: 1, requests: pruned });
        await this.addToAllowlist(channel, entry.id);

        return { id: entry.id, entry };
    }

    /**
     * Rejects/removes a pairing code.
     */
    async rejectCode(channel: PairingChannel, code: string): Promise<boolean> {
        const normalizedCode = code.trim().toUpperCase();
        if (!normalizedCode) {
            return false;
        }

        const filePath = this.resolvePairingPath(channel);
        const store = await this.readJsonFile<PairingStore>(filePath, {
            version: 1,
            requests: [],
        });

        const filtered = store.requests.filter(
            (r) => r.code?.toUpperCase() !== normalizedCode
        );

        if (filtered.length === store.requests.length) {
            return false;
        }

        await this.writeJsonFile(filePath, { version: 1, requests: filtered });
        return true;
    }

    // ============================================================================
    // Private Helpers
    // ============================================================================

    private resolvePairingPath(channel: PairingChannel): string {
        const key = this.safeChannelKey(channel);
        return path.join(this.storeDir, `${key}-pairing.json`);
    }

    private resolveAllowlistPath(channel: PairingChannel): string {
        const key = this.safeChannelKey(channel);
        return path.join(this.storeDir, `${key}-allowFrom.json`);
    }

    private safeChannelKey(channel: PairingChannel): string {
        const raw = String(channel).trim().toLowerCase();
        if (!raw) throw new Error('Invalid pairing channel');

        const safe = raw.replace(/[\\/:<>"|?*]/g, '_').replace(/\.\./g, '_');
        if (!safe || safe === '_') throw new Error('Invalid pairing channel');

        return safe;
    }

    private normalizeId(value: string | number): string {
        return String(value).trim();
    }

    private generateUniqueCode(existing: Set<string>): string {
        for (let attempt = 0; attempt < 500; attempt++) {
            const code = this.randomCode();
            if (!existing.has(code)) {
                return code;
            }
        }
        throw new Error('Failed to generate unique pairing code');
    }

    private randomCode(): string {
        let out = '';
        for (let i = 0; i < this.codeLength; i++) {
            const idx = crypto.randomInt(0, CODE_ALPHABET.length);
            out += CODE_ALPHABET[idx];
        }
        return out;
    }

    private isExpired(entry: PairingRequest, nowMs: number): boolean {
        const createdAt = Date.parse(entry.createdAt);
        if (!Number.isFinite(createdAt)) return true;
        return nowMs - createdAt > this.pendingTtlMs;
    }

    private pruneExpired(
        requests: PairingRequest[],
        nowMs: number
    ): { requests: PairingRequest[]; removed: boolean } {
        const kept = requests.filter((r) => !this.isExpired(r, nowMs));
        return { requests: kept, removed: kept.length !== requests.length };
    }

    private pruneExcess(
        requests: PairingRequest[]
    ): { requests: PairingRequest[]; removed: boolean } {
        if (this.maxPending <= 0 || requests.length <= this.maxPending) {
            return { requests, removed: false };
        }

        // Keep most recent
        const sorted = [...requests].sort((a, b) => {
            const aTime = Date.parse(a.lastSeenAt || a.createdAt) || 0;
            const bTime = Date.parse(b.lastSeenAt || b.createdAt) || 0;
            return aTime - bTime;
        });

        return { requests: sorted.slice(-this.maxPending), removed: true };
    }

    private async readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
        try {
            const raw = await fs.promises.readFile(filePath, 'utf-8');
            return JSON.parse(raw) as T;
        } catch {
            return fallback;
        }
    }

    private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
        const dir = path.dirname(filePath);
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

        const tmp = path.join(
            dir,
            `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`
        );
        await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
        await fs.promises.chmod(tmp, 0o600);
        await fs.promises.rename(tmp, filePath);
    }
}
