/**
 * @fileoverview LlmsTxtDiscovery — discovers and caches llms.txt files from websites.
 *
 * Implements the llms.txt standard (https://llmstxt.org/) for discovering machine-readable
 * site context. When an agent fetches content from a URL, this module can check for
 * `/.well-known/llms.txt` or `/llms.txt` and cache the content for injecting into
 * the agent's context window.
 *
 * Uses an LRU-style in-memory cache (Map with max 100 entries, 1 hour TTL).
 *
 * @module wunderland/tools/LlmsTxtDiscovery
 */

/** A cached llms.txt entry with TTL tracking. */
export interface LlmsTxtCacheEntry {
  /** The llms.txt content, or null if the domain has no llms.txt. */
  content: string | null;
  /** Timestamp (ms) when this entry was cached. */
  cachedAt: number;
  /** The URL the content was fetched from (for debugging). */
  sourceUrl: string | null;
}

/** Configuration options for LlmsTxtDiscovery. */
export interface LlmsTxtDiscoveryOptions {
  /** Maximum number of cache entries. Defaults to 100. */
  maxCacheSize?: number;
  /** Cache TTL in milliseconds. Defaults to 3_600_000 (1 hour). */
  cacheTtlMs?: number;
  /** Fetch timeout in milliseconds per request. Defaults to 5_000. */
  fetchTimeoutMs?: number;
  /** Maximum response body size in bytes. Defaults to 512_000 (512 KB). */
  maxBodyBytes?: number;
}

/** Default configuration values. */
const DEFAULTS = {
  maxCacheSize: 100,
  cacheTtlMs: 3_600_000,   // 1 hour
  fetchTimeoutMs: 5_000,    // 5 seconds
  maxBodyBytes: 512_000,    // 512 KB
} as const;

/**
 * Candidate paths for llms.txt discovery, tried in order.
 * The well-known path is preferred per the specification.
 */
const CANDIDATE_PATHS = ['/.well-known/llms.txt', '/llms.txt'] as const;

/**
 * Extracts the origin (scheme + host) from a URL string.
 *
 * @param url - Any valid URL string
 * @returns The origin (e.g., "https://example.com") or null if invalid
 */
function extractOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Extracts the domain (hostname) from a URL string.
 *
 * @param url - Any valid URL string
 * @returns The hostname (e.g., "example.com") or null if invalid
 */
function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * Discovers and caches llms.txt files from websites following the llms.txt standard.
 *
 * @example
 * ```typescript
 * const discovery = new LlmsTxtDiscovery();
 *
 * // Discover llms.txt for a domain
 * const content = await discovery.discoverLlmsTxt('https://example.com/some/page');
 * if (content) {
 *   console.log('Found llms.txt:', content.substring(0, 200));
 * }
 *
 * // Later, retrieve from cache without fetching
 * const cached = discovery.getCachedContext('example.com');
 * ```
 */
export class LlmsTxtDiscovery {
  private readonly cache = new Map<string, LlmsTxtCacheEntry>();
  private readonly maxCacheSize: number;
  private readonly cacheTtlMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly maxBodyBytes: number;

  constructor(options?: LlmsTxtDiscoveryOptions) {
    this.maxCacheSize = options?.maxCacheSize ?? DEFAULTS.maxCacheSize;
    this.cacheTtlMs = options?.cacheTtlMs ?? DEFAULTS.cacheTtlMs;
    this.fetchTimeoutMs = options?.fetchTimeoutMs ?? DEFAULTS.fetchTimeoutMs;
    this.maxBodyBytes = options?.maxBodyBytes ?? DEFAULTS.maxBodyBytes;
  }

  /**
   * Discover and cache the llms.txt file for the domain of the given URL.
   *
   * Tries `/.well-known/llms.txt` first, then `/llms.txt`. Results (including
   * negative results) are cached to avoid repeated network requests.
   *
   * @param baseUrl - Any URL on the target domain (e.g., "https://example.com/docs/api")
   * @returns The llms.txt content string, or null if not found or on error
   */
  async discoverLlmsTxt(baseUrl: string): Promise<string | null> {
    const origin = extractOrigin(baseUrl);
    const domain = extractDomain(baseUrl);

    if (!origin || !domain) {
      return null;
    }

    // Check cache first (including negative cache entries)
    const cached = this.cache.get(domain);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
      return cached.content;
    }

    // Try each candidate path in order
    for (const path of CANDIDATE_PATHS) {
      const candidateUrl = `${origin}${path}`;

      try {
        const content = await this.fetchLlmsTxt(candidateUrl);
        if (content !== null) {
          this.setCacheEntry(domain, {
            content,
            cachedAt: Date.now(),
            sourceUrl: candidateUrl,
          });
          return content;
        }
      } catch {
        // Silently continue to next candidate path
      }
    }

    // Cache the negative result to avoid re-fetching
    this.setCacheEntry(domain, {
      content: null,
      cachedAt: Date.now(),
      sourceUrl: null,
    });

    return null;
  }

  /**
   * Get cached llms.txt content for a domain without triggering a fetch.
   *
   * @param domain - The domain hostname (e.g., "example.com")
   * @returns The cached llms.txt content, or null if not cached or expired
   */
  getCachedContext(domain: string): string | null {
    const entry = this.cache.get(domain);
    if (!entry) {
      return null;
    }

    // Check TTL
    if (Date.now() - entry.cachedAt >= this.cacheTtlMs) {
      this.cache.delete(domain);
      return null;
    }

    return entry.content;
  }

  /**
   * Clear all cached llms.txt entries.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get the current number of cached entries (useful for diagnostics).
   */
  get cacheSize(): number {
    return this.cache.size;
  }

  /**
   * Fetch a single llms.txt URL and return the text content.
   *
   * @param url - The full URL to fetch
   * @returns The text content, or null if not a valid llms.txt response
   */
  private async fetchLlmsTxt(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'text/plain, text/markdown, */*;q=0.1',
          'User-Agent': 'WunderlandAgent/1.0 (llms-txt-discovery)',
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        return null;
      }

      // Verify content type is text-based
      const contentType = response.headers.get('content-type') || '';
      if (
        !contentType.includes('text/') &&
        !contentType.includes('application/octet-stream') &&
        contentType !== ''
      ) {
        return null;
      }

      // Check content-length if available to avoid downloading huge files
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > this.maxBodyBytes) {
        return null;
      }

      const text = await response.text();

      // Validate that we got something that looks like an llms.txt file
      // (non-empty, reasonable size, not HTML)
      if (
        !text.trim() ||
        text.length > this.maxBodyBytes ||
        text.trimStart().startsWith('<!DOCTYPE') ||
        text.trimStart().startsWith('<html')
      ) {
        return null;
      }

      return text;
    } catch {
      // Network errors, timeouts, abort signals — all handled gracefully
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Set a cache entry, evicting the oldest entry if at capacity (LRU eviction).
   */
  private setCacheEntry(domain: string, entry: LlmsTxtCacheEntry): void {
    // If updating an existing entry, delete first to refresh insertion order
    if (this.cache.has(domain)) {
      this.cache.delete(domain);
    }

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }

    this.cache.set(domain, entry);
  }
}
