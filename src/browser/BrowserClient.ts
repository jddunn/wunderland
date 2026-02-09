/**
 * @fileoverview Browser automation client - Ported from OpenClaw
 * @module wunderland/browser/BrowserClient
 *
 * HTTP client for browser automation service.
 */

import type {
    BrowserStatus,
    ProfileStatus,
    BrowserTab,
    SnapshotResult,
} from './types.js';

/**
 * Configuration for the browser client.
 */
export interface BrowserClientConfig {
    /** Base URL for the browser service (e.g., http://localhost:9222) */
    baseUrl?: string;
    /** Default timeout for requests in ms */
    defaultTimeoutMs?: number;
}

/**
 * Browser automation client.
 *
 * Provides HTTP interface to control browser instances for agent use.
 *
 * @example
 * ```typescript
 * const client = new BrowserClient({ baseUrl: 'http://localhost:9222' });
 *
 * // Start browser and open tab
 * await client.start();
 * const tab = await client.openTab('https://example.com');
 *
 * // Take snapshot for agent consumption
 * const snapshot = await client.snapshot({ format: 'ai', targetId: tab.targetId });
 * console.log(snapshot.snapshot);
 * ```
 */
export class BrowserClient {
    private readonly baseUrl: string;
    private readonly defaultTimeoutMs: number;

    constructor(config: BrowserClientConfig = {}) {
        this.baseUrl = config.baseUrl?.replace(/\/$/, '') ?? 'http://localhost:9222';
        this.defaultTimeoutMs = config.defaultTimeoutMs ?? 10000;
    }

    /**
     * Makes a JSON request to the browser service.
     */
    private async fetchJson<T>(
        path: string,
        options: RequestInit & { timeoutMs?: number } = {}
    ): Promise<T> {
        const { timeoutMs = this.defaultTimeoutMs, ...fetchOptions } = options;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                ...fetchOptions,
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    ...fetchOptions.headers,
                },
            });

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`Browser API error: ${response.status} ${text}`);
            }

            return (await response.json()) as T;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Builds query string from profile option.
     */
    private buildProfileQuery(profile?: string): string {
        return profile ? `?profile=${encodeURIComponent(profile)}` : '';
    }

    // ============================================================================
    // Browser Lifecycle
    // ============================================================================

    /**
     * Gets browser status.
     */
    async status(profile?: string): Promise<BrowserStatus> {
        const q = this.buildProfileQuery(profile);
        return this.fetchJson<BrowserStatus>(`/${q}`, { timeoutMs: 1500 });
    }

    /**
     * Lists all browser profiles.
     */
    async profiles(): Promise<ProfileStatus[]> {
        const res = await this.fetchJson<{ profiles: ProfileStatus[] }>('/profiles', {
            timeoutMs: 3000,
        });
        return res.profiles ?? [];
    }

    /**
     * Starts the browser.
     */
    async start(profile?: string): Promise<void> {
        const q = this.buildProfileQuery(profile);
        await this.fetchJson(`/start${q}`, { method: 'POST', timeoutMs: 15000 });
    }

    /**
     * Stops the browser.
     */
    async stop(profile?: string): Promise<void> {
        const q = this.buildProfileQuery(profile);
        await this.fetchJson(`/stop${q}`, { method: 'POST', timeoutMs: 15000 });
    }

    /**
     * Creates a new browser profile.
     */
    async createProfile(options: {
        name: string;
        color?: string;
        cdpUrl?: string;
        driver?: 'openclaw' | 'extension';
    }): Promise<{
        ok: true;
        profile: string;
        cdpPort: number;
        cdpUrl: string;
        color: string;
        isRemote: boolean;
    }> {
        return this.fetchJson('/profiles/create', {
            method: 'POST',
            body: JSON.stringify(options),
            timeoutMs: 10000,
        });
    }

    /**
     * Deletes a browser profile.
     */
    async deleteProfile(profile: string): Promise<{
        ok: true;
        profile: string;
        deleted: boolean;
    }> {
        return this.fetchJson(`/profiles/${encodeURIComponent(profile)}`, {
            method: 'DELETE',
            timeoutMs: 20000,
        });
    }

    // ============================================================================
    // Tab Management
    // ============================================================================

    /**
     * Lists all open tabs.
     */
    async tabs(profile?: string): Promise<BrowserTab[]> {
        const q = this.buildProfileQuery(profile);
        const res = await this.fetchJson<{ running: boolean; tabs: BrowserTab[] }>(
            `/tabs${q}`,
            { timeoutMs: 3000 }
        );
        return res.tabs ?? [];
    }

    /**
     * Opens a new tab with the given URL.
     */
    async openTab(url: string, profile?: string): Promise<BrowserTab> {
        const q = this.buildProfileQuery(profile);
        return this.fetchJson<BrowserTab>(`/tabs/open${q}`, {
            method: 'POST',
            body: JSON.stringify({ url }),
            timeoutMs: 15000,
        });
    }

    /**
     * Focuses a tab by targetId.
     */
    async focusTab(targetId: string, profile?: string): Promise<void> {
        const q = this.buildProfileQuery(profile);
        await this.fetchJson(`/tabs/focus${q}`, {
            method: 'POST',
            body: JSON.stringify({ targetId }),
            timeoutMs: 5000,
        });
    }

    /**
     * Closes a tab by targetId.
     */
    async closeTab(targetId: string, profile?: string): Promise<void> {
        const q = this.buildProfileQuery(profile);
        await this.fetchJson(`/tabs/${encodeURIComponent(targetId)}${q}`, {
            method: 'DELETE',
            timeoutMs: 5000,
        });
    }

    // ============================================================================
    // Snapshots
    // ============================================================================

    /**
     * Takes a snapshot of the current page state.
     *
     * @param options - Snapshot options
     * @returns Snapshot result with accessibility tree or AI-formatted text
     */
    async snapshot(options: {
        format: 'aria' | 'ai';
        targetId?: string;
        limit?: number;
        maxChars?: number;
        refs?: 'role' | 'aria';
        interactive?: boolean;
        compact?: boolean;
        depth?: number;
        selector?: string;
        frame?: string;
        labels?: boolean;
        mode?: 'efficient';
        profile?: string;
    }): Promise<SnapshotResult> {
        const q = new URLSearchParams();
        q.set('format', options.format);

        if (options.targetId) q.set('targetId', options.targetId);
        if (typeof options.limit === 'number') q.set('limit', String(options.limit));
        if (typeof options.maxChars === 'number') q.set('maxChars', String(options.maxChars));
        if (options.refs) q.set('refs', options.refs);
        if (typeof options.interactive === 'boolean') q.set('interactive', String(options.interactive));
        if (typeof options.compact === 'boolean') q.set('compact', String(options.compact));
        if (typeof options.depth === 'number') q.set('depth', String(options.depth));
        if (options.selector?.trim()) q.set('selector', options.selector.trim());
        if (options.frame?.trim()) q.set('frame', options.frame.trim());
        if (options.labels === true) q.set('labels', '1');
        if (options.mode) q.set('mode', options.mode);
        if (options.profile) q.set('profile', options.profile);

        return this.fetchJson<SnapshotResult>(`/snapshot?${q.toString()}`, {
            timeoutMs: 20000,
        });
    }
}
