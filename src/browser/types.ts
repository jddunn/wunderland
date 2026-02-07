/**
 * @fileoverview Browser automation types - Ported from OpenClaw
 * @module wunderland/browser/types
 */

/**
 * Browser console message captured during automation.
 */
export interface BrowserConsoleMessage {
    type: string;
    text: string;
    timestamp: string;
    location?: {
        url?: string;
        lineNumber?: number;
        columnNumber?: number;
    };
}

/**
 * Browser page error captured during automation.
 */
export interface BrowserPageError {
    message: string;
    name?: string;
    stack?: string;
    timestamp: string;
}

/**
 * Network request tracked during automation.
 */
export interface BrowserNetworkRequest {
    id: string;
    timestamp: string;
    method: string;
    url: string;
    resourceType?: string;
    status?: number;
    ok?: boolean;
    failureText?: string;
}

/**
 * Browser status information.
 */
export interface BrowserStatus {
    enabled: boolean;
    profile?: string;
    running: boolean;
    cdpReady?: boolean;
    cdpHttp?: boolean;
    pid: number | null;
    cdpPort: number;
    cdpUrl?: string;
    chosenBrowser: string | null;
    detectedBrowser?: string | null;
    detectedExecutablePath?: string | null;
    detectError?: string | null;
    userDataDir: string | null;
    color: string;
    headless: boolean;
    noSandbox?: boolean;
    executablePath?: string | null;
    attachOnly: boolean;
}

/**
 * Browser profile status.
 */
export interface ProfileStatus {
    name: string;
    cdpPort: number;
    cdpUrl: string;
    color: string;
    running: boolean;
    tabCount: number;
    isDefault: boolean;
    isRemote: boolean;
}

/**
 * Browser tab information.
 */
export interface BrowserTab {
    targetId: string;
    title: string;
    url: string;
    wsUrl?: string;
    type?: string;
}

/**
 * Aria tree node for accessibility snapshots.
 */
export interface SnapshotAriaNode {
    ref: string;
    role: string;
    name: string;
    value?: string;
    description?: string;
    backendDOMNodeId?: number;
    depth: number;
}

/**
 * Result of a browser snapshot operation.
 */
export type SnapshotResult =
    | {
        ok: true;
        format: 'aria';
        targetId: string;
        url: string;
        nodes: SnapshotAriaNode[];
    }
    | {
        ok: true;
        format: 'ai';
        targetId: string;
        url: string;
        snapshot: string;
        truncated?: boolean;
        refs?: Record<string, { role: string; name?: string; nth?: number }>;
        stats?: {
            lines: number;
            chars: number;
            refs: number;
            interactive: number;
        };
        labels?: boolean;
        labelsCount?: number;
        labelsSkipped?: number;
        imagePath?: string;
        imageType?: 'png' | 'jpeg';
    };

/**
 * Options for browser interactions.
 */
export interface BrowserInteractionOptions {
    cdpUrl: string;
    targetId?: string;
    timeoutMs?: number;
}

/**
 * Click action options.
 */
export interface ClickOptions extends BrowserInteractionOptions {
    ref: string;
    doubleClick?: boolean;
    button?: 'left' | 'right' | 'middle';
    modifiers?: Array<'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift'>;
}

/**
 * Type action options.
 */
export interface TypeOptions extends BrowserInteractionOptions {
    ref: string;
    text: string;
    submit?: boolean;
    slowly?: boolean;
}

/**
 * Form field for batch form filling.
 */
export interface BrowserFormField {
    ref: string;
    value: string;
    type?: 'text' | 'select' | 'checkbox' | 'radio';
}

/**
 * Screenshot options.
 */
export interface ScreenshotOptions extends BrowserInteractionOptions {
    ref?: string;
    element?: string;
    fullPage?: boolean;
    type?: 'png' | 'jpeg';
}

/**
 * Wait condition options.
 */
export interface WaitOptions extends BrowserInteractionOptions {
    timeMs?: number;
    text?: string;
    textGone?: string;
    selector?: string;
    url?: string;
    loadState?: 'load' | 'domcontentloaded' | 'networkidle';
    fn?: string;
}

/**
 * Role refs for element targeting.
 */
export type RoleRefs = Record<string, { role: string; name?: string; nth?: number }>;

/**
 * Page state for tracking events and refs.
 */
export interface PageState {
    console: BrowserConsoleMessage[];
    errors: BrowserPageError[];
    requests: BrowserNetworkRequest[];
    roleRefs?: RoleRefs;
    roleRefsMode?: 'role' | 'aria';
    roleRefsFrameSelector?: string;
}
