/**
 * @fileoverview Browser session management - Ported from OpenClaw
 * @module wunderland/browser/BrowserSession
 *
 * Playwright-based browser session for direct CDP control.
 */

import type { Browser, BrowserContext, Page } from 'playwright-core';
import type {
    BrowserConsoleMessage,
    BrowserPageError,
    BrowserNetworkRequest,
    PageState,
    RoleRefs,
} from './types.js';

const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;

/**
 * Browser session configuration.
 */
export interface BrowserSessionConfig {
    /** CDP WebSocket URL */
    cdpUrl: string;
    /** Connection timeout in ms */
    connectTimeoutMs?: number;
}

/**
 * Browser session for Playwright-based automation.
 *
 * Manages connection to a Chrome browser via CDP and provides
 * page state tracking and interaction methods.
 *
 * @example
 * ```typescript
 * const session = new BrowserSession({ cdpUrl: 'ws://localhost:9222/devtools/browser/...' });
 * await session.connect();
 *
 * const page = await session.getPage();
 * const state = session.getPageState(page);
 * ```
 */
export class BrowserSession {
    private browser: Browser | null = null;
    private readonly cdpUrl: string;
    private readonly connectTimeoutMs: number;
    private readonly pageStates = new WeakMap<Page, PageState>();
    private connecting: Promise<Browser> | null = null;

    constructor(config: BrowserSessionConfig) {
        this.cdpUrl = config.cdpUrl.replace(/\/$/, '');
        this.connectTimeoutMs = config.connectTimeoutMs ?? 10000;
    }

    /**
     * Connects to the browser via CDP.
     */
    async connect(): Promise<Browser> {
        if (this.browser) {
            return this.browser;
        }

        if (this.connecting) {
            return this.connecting;
        }

        this.connecting = this.connectWithRetry();
        try {
            this.browser = await this.connecting;
            return this.browser;
        } finally {
            this.connecting = null;
        }
    }

    /**
     * Connects with retry logic.
     */
    private async connectWithRetry(): Promise<Browser> {
        // Dynamic import to avoid bundling Playwright when not used
        const { chromium } = await import('playwright-core');

        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const timeout = this.connectTimeoutMs + attempt * 2000;
                const browser = await chromium.connectOverCDP(this.cdpUrl, { timeout });

                // Set up observers
                this.observeBrowser(browser);

                browser.on('disconnected', () => {
                    if (this.browser === browser) {
                        this.browser = null;
                    }
                });

                return browser;
            } catch (err) {
                lastError = err;
                await new Promise((r) => setTimeout(r, 250 + attempt * 250));
            }
        }

        throw lastError instanceof Error
            ? lastError
            : new Error('CDP connect failed');
    }

    /**
     * Disconnects from the browser.
     */
    async disconnect(): Promise<void> {
        if (this.browser) {
            await this.browser.close().catch(() => { });
            this.browser = null;
        }
    }

    /**
     * Gets the connected browser instance.
     */
    getBrowser(): Browser | null {
        return this.browser;
    }

    /**
     * Gets all pages across all contexts.
     */
    async getAllPages(): Promise<Page[]> {
        if (!this.browser) {
            return [];
        }
        return this.browser.contexts().flatMap((c) => c.pages());
    }

    /**
     * Gets a page by target ID.
     */
    async getPageByTargetId(targetId: string): Promise<Page | null> {
        const pages = await this.getAllPages();

        for (const page of pages) {
            const session = await page.context().newCDPSession(page);
            try {
                const info = await session.send('Target.getTargetInfo') as {
                    targetInfo?: { targetId?: string };
                };
                if (info?.targetInfo?.targetId === targetId) {
                    return page;
                }
            } finally {
                await session.detach().catch(() => { });
            }
        }

        return null;
    }

    /**
     * Gets the first available page or creates one.
     */
    async getPage(): Promise<Page> {
        const pages = await this.getAllPages();
        if (pages.length > 0) {
            return pages[0];
        }

        // Create a new page
        const context = this.browser?.contexts()[0];
        if (!context) {
            throw new Error('No browser context available');
        }

        const page = await context.newPage();
        this.ensurePageState(page);
        return page;
    }

    /**
     * Gets or creates page state for tracking.
     */
    ensurePageState(page: Page): PageState {
        const existing = this.pageStates.get(page);
        if (existing) {
            return existing;
        }

        const state: PageState = {
            console: [],
            errors: [],
            requests: [],
        };

        this.pageStates.set(page, state);
        this.observePage(page, state);

        return state;
    }

    /**
     * Gets page state.
     */
    getPageState(page: Page): PageState | undefined {
        return this.pageStates.get(page);
    }

    /**
     * Stores role refs for element targeting.
     */
    storeRoleRefs(
        page: Page,
        refs: RoleRefs,
        mode: 'role' | 'aria' = 'role',
        frameSelector?: string
    ): void {
        const state = this.ensurePageState(page);
        state.roleRefs = refs;
        state.roleRefsMode = mode;
        state.roleRefsFrameSelector = frameSelector;
    }

    /**
     * Gets a locator for a role ref.
     */
    refLocator(page: Page, ref: string) {
        const normalized = ref.startsWith('@')
            ? ref.slice(1)
            : ref.startsWith('ref=')
                ? ref.slice(4)
                : ref;

        const state = this.pageStates.get(page);

        if (/^e\d+$/.test(normalized)) {
            if (state?.roleRefsMode === 'aria') {
                const scope = state.roleRefsFrameSelector
                    ? page.frameLocator(state.roleRefsFrameSelector)
                    : page;
                return scope.locator(`aria-ref=${normalized}`);
            }

            const info = state?.roleRefs?.[normalized];
            if (!info) {
                throw new Error(
                    `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`
                );
            }

            const scope = state?.roleRefsFrameSelector
                ? page.frameLocator(state.roleRefsFrameSelector)
                : page;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const locator = (scope as any).getByRole(info.role, {
                name: info.name,
                exact: true,
            });

            return info.nth !== undefined ? locator.nth(info.nth) : locator;
        }

        return page.locator(`aria-ref=${normalized}`);
    }

    // ============================================================================
    // Private observers
    // ============================================================================

    private observeBrowser(browser: Browser): void {
        for (const context of browser.contexts()) {
            this.observeContext(context);
        }
    }

    private observeContext(context: BrowserContext): void {
        for (const page of context.pages()) {
            this.ensurePageState(page);
        }
        context.on('page', (page) => this.ensurePageState(page));
    }

    private observePage(page: Page, state: PageState): void {
        const requestIds = new WeakMap<Request, string>();
        let nextRequestId = 0;

        page.on('console', (msg) => {
            const entry: BrowserConsoleMessage = {
                type: msg.type(),
                text: msg.text(),
                timestamp: new Date().toISOString(),
                location: msg.location(),
            };
            state.console.push(entry);
            if (state.console.length > MAX_CONSOLE_MESSAGES) {
                state.console.shift();
            }
        });

        page.on('pageerror', (err) => {
            const entry: BrowserPageError = {
                message: err?.message ?? String(err),
                name: err?.name,
                stack: err?.stack,
                timestamp: new Date().toISOString(),
            };
            state.errors.push(entry);
            if (state.errors.length > MAX_PAGE_ERRORS) {
                state.errors.shift();
            }
        });

        page.on('request', (req) => {
            nextRequestId++;
            const id = `r${nextRequestId}`;
            requestIds.set(req, id);

            const entry: BrowserNetworkRequest = {
                id,
                timestamp: new Date().toISOString(),
                method: req.method(),
                url: req.url(),
                resourceType: req.resourceType(),
            };
            state.requests.push(entry);
            if (state.requests.length > MAX_NETWORK_REQUESTS) {
                state.requests.shift();
            }
        });

        page.on('response', (resp) => {
            const req = resp.request();
            const id = requestIds.get(req);
            if (!id) return;

            const rec = state.requests.find((r) => r.id === id);
            if (rec) {
                rec.status = resp.status();
                rec.ok = resp.ok();
            }
        });

        page.on('requestfailed', (req) => {
            const id = requestIds.get(req);
            if (!id) return;

            const rec = state.requests.find((r) => r.id === id);
            if (rec) {
                rec.failureText = req.failure()?.errorText;
                rec.ok = false;
            }
        });

        page.on('close', () => {
            this.pageStates.delete(page);
        });
    }
}

// Re-export Request type for use in observers
type Request = Awaited<ReturnType<Page['waitForRequest']>>;
