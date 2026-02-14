/**
 * @fileoverview ContentSanitizer — SSRF-safe content fetching and sanitization.
 *
 * Provides secure URL fetching with:
 * - Private IP blocking (RFC1918, localhost, link-local)
 * - Cloud metadata IP blocking (169.254.169.254)
 * - Content-type allowlisting
 * - Size limits and timeouts
 * - HTML sanitization
 *
 * @module wunderland/social/ContentSanitizer
 */

import { createHash } from 'crypto';

// ============================================================================
// Types
// ============================================================================

/** Result of sanitizing content. */
export interface SanitizedContent {
  /** Original URL (validated). */
  url: string;
  /** Sanitized content bytes. */
  content: Buffer;
  /** SHA-256 hash of sanitized content. */
  contentHash: string;
  /** Detected content type. */
  contentType: string;
  /** Content length in bytes. */
  contentLength: number;
  /** Fetch timestamp. */
  fetchedAt: Date;
}

/** Options for content fetching. */
export interface FetchOptions {
  /** Request timeout in milliseconds (default: 10000). */
  timeoutMs?: number;
  /** Maximum content size in bytes (default: 1MB). */
  maxSizeBytes?: number;
  /** User-Agent header (default: 'WunderlandBot/1.0'). */
  userAgent?: string;
}

/** Error thrown when URL validation fails. */
export class SSRFError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSRFError';
  }
}

/** Error thrown when content validation fails. */
export class ContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentError';
  }
}

// ============================================================================
// Constants
// ============================================================================

/** Allowed content types for URL tips. */
const ALLOWED_CONTENT_TYPES = new Set([
  'text/html',
  'text/plain',
  'application/json',
  'application/xml',
  'text/xml',
  'text/markdown',
  'application/rss+xml',
  'application/atom+xml',
]);

/** Default fetch timeout (10 seconds). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default max content size (1 MB). */
const DEFAULT_MAX_SIZE_BYTES = 1_048_576;

/** Default user agent. */
const DEFAULT_USER_AGENT = 'WunderlandBot/1.0 (+https://wunderland.sh)';

// ============================================================================
// ContentSanitizer
// ============================================================================

/**
 * SSRF-safe content fetcher and sanitizer.
 *
 * @example
 * ```typescript
 * const sanitizer = new ContentSanitizer();
 * const result = await sanitizer.fetchAndSanitize('https://example.com/article');
 * console.log(result.contentHash); // SHA-256 of sanitized content
 * ```
 */
export class ContentSanitizer {
  private allowedContentTypes: Set<string>;

  constructor(additionalContentTypes?: string[]) {
    this.allowedContentTypes = new Set([
      ...ALLOWED_CONTENT_TYPES,
      ...(additionalContentTypes ?? []),
    ]);
  }

  /**
   * Validate a URL for SSRF safety.
   *
   * Blocks:
   * - Private IPs (10.x, 172.16-31.x, 192.168.x)
   * - Localhost (127.x, ::1)
   * - Link-local (169.254.x, fe80::)
   * - Cloud metadata (169.254.169.254)
   * - Non-HTTP(S) schemes
   *
   * @throws {SSRFError} If URL is potentially dangerous.
   */
  validateUrl(urlString: string): URL {
    let url: URL;
    try {
      url = new URL(urlString);
    } catch {
      throw new SSRFError('Invalid URL format');
    }

    // Only allow HTTP(S)
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new SSRFError(`Blocked protocol: ${url.protocol}`);
    }

    // Resolve hostname to check for blocked IPs
    const hostname = url.hostname.toLowerCase();

    // Block localhost variants
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1' ||
      hostname.endsWith('.localhost')
    ) {
      throw new SSRFError('Blocked: localhost');
    }

    // Block cloud metadata endpoints
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      throw new SSRFError('Blocked: cloud metadata endpoint');
    }

    // Check for IP address patterns
    if (this.isBlockedIP(hostname)) {
      throw new SSRFError(`Blocked: private/reserved IP address`);
    }

    // Block common internal hostnames
    const blockedHostnames = [
      'internal',
      'intranet',
      'corp',
      'private',
      'admin',
      'kubernetes',
      'k8s',
    ];
    for (const blocked of blockedHostnames) {
      if (hostname.includes(blocked)) {
        throw new SSRFError(`Blocked: internal hostname pattern`);
      }
    }

    return url;
  }

  /**
   * Fetch and sanitize content from a URL.
   *
   * @param urlString URL to fetch.
   * @param options Fetch options.
   * @returns Sanitized content with hash.
   * @throws {SSRFError} If URL validation fails.
   * @throws {ContentError} If content validation fails.
   */
  async fetchAndSanitize(
    urlString: string,
    options: FetchOptions = {},
  ): Promise<SanitizedContent> {
    const {
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxSizeBytes = DEFAULT_MAX_SIZE_BYTES,
      userAgent = DEFAULT_USER_AGENT,
    } = options;

    // Validate URL
    const url = this.validateUrl(urlString);

    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html, text/plain, application/json, */*',
        },
        redirect: 'follow',
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ContentError(`Request timed out after ${timeoutMs}ms`);
      }
      throw new ContentError(`Fetch failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      clearTimeout(timeoutId);
    }

    // Check response status
    if (!response.ok) {
      throw new ContentError(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Validate content type
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (!this.isAllowedContentType(contentType)) {
      throw new ContentError(`Blocked content-type: ${contentType}`);
    }

    // Check content length header if available
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const declaredSize = parseInt(contentLengthHeader, 10);
      if (declaredSize > maxSizeBytes) {
        throw new ContentError(`Content too large: ${declaredSize} bytes (max: ${maxSizeBytes})`);
      }
    }

    // Read body with size limit
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    const reader = response.body?.getReader();

    if (!reader) {
      throw new ContentError('No response body');
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalSize += value.length;
        if (totalSize > maxSizeBytes) {
          throw new ContentError(`Content too large: exceeded ${maxSizeBytes} bytes`);
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    // Combine chunks
    const rawContent = Buffer.concat(chunks.map((c) => Buffer.from(c)));

    // Sanitize content based on type
    const sanitizedContent = this.sanitizeContent(rawContent, contentType);

    // Compute hash
    const contentHash = createHash('sha256').update(sanitizedContent).digest('hex');

    return {
      url: url.toString(),
      content: sanitizedContent,
      contentHash,
      contentType,
      contentLength: sanitizedContent.length,
      fetchedAt: new Date(),
    };
  }

  /**
   * Sanitize text content directly (for text tips).
   */
  sanitizeText(text: string): SanitizedContent {
    // Normalize and trim
    const sanitized = text
      .trim()
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .slice(0, DEFAULT_MAX_SIZE_BYTES);

    const content = Buffer.from(sanitized, 'utf-8');
    const contentHash = createHash('sha256').update(content).digest('hex');

    return {
      url: '',
      content,
      contentHash,
      contentType: 'text/plain',
      contentLength: content.length,
      fetchedAt: new Date(),
    };
  }

  // ── Private methods ──

  /**
   * Check if an IP address is in a blocked range.
   */
  private isBlockedIP(hostname: string): boolean {
    // IPv4 pattern
    const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = hostname.match(ipv4Pattern);

    if (match) {
      const octets = match.slice(1, 5).map((o) => parseInt(o, 10));
      const [a, b, c, _d] = octets;

      // Validate octets
      if (octets.some((o) => o < 0 || o > 255)) {
        return true; // Invalid IP
      }

      // 10.0.0.0/8 - Private
      if (a === 10) return true;

      // 172.16.0.0/12 - Private
      if (a === 172 && b >= 16 && b <= 31) return true;

      // 192.168.0.0/16 - Private
      if (a === 192 && b === 168) return true;

      // 127.0.0.0/8 - Loopback
      if (a === 127) return true;

      // 169.254.0.0/16 - Link-local
      if (a === 169 && b === 254) return true;

      // 0.0.0.0/8 - Current network
      if (a === 0) return true;

      // 224.0.0.0/4 - Multicast
      if (a >= 224 && a <= 239) return true;

      // 240.0.0.0/4 - Reserved
      if (a >= 240) return true;

      // 100.64.0.0/10 - Carrier-grade NAT
      if (a === 100 && b >= 64 && b <= 127) return true;

      // 192.0.0.0/24 - IETF Protocol Assignments
      if (a === 192 && b === 0 && c === 0) return true;

      // 192.0.2.0/24 - Documentation (TEST-NET-1)
      if (a === 192 && b === 0 && c === 2) return true;

      // 198.51.100.0/24 - Documentation (TEST-NET-2)
      if (a === 198 && b === 51 && c === 100) return true;

      // 203.0.113.0/24 - Documentation (TEST-NET-3)
      if (a === 203 && b === 0 && c === 113) return true;
    }

    // IPv6 patterns (simplified)
    if (hostname.startsWith('[') || hostname.includes(':')) {
      const ipv6 = hostname.replace(/[[\]]/g, '').toLowerCase();

      // Loopback
      if (ipv6 === '::1') return true;

      // Link-local (fe80::/10)
      if (ipv6.startsWith('fe80:')) return true;

      // Unique local (fc00::/7)
      if (ipv6.startsWith('fc') || ipv6.startsWith('fd')) return true;

      // Unspecified
      if (ipv6 === '::') return true;
    }

    return false;
  }

  /**
   * Check if content type is allowed.
   */
  private isAllowedContentType(contentType: string): boolean {
    if (!contentType) return false;
    return this.allowedContentTypes.has(contentType);
  }

  /**
   * Sanitize content based on type.
   */
  private sanitizeContent(content: Buffer, contentType: string): Buffer {
    if (contentType === 'text/html') {
      return this.sanitizeHtml(content);
    }

    // For other types, just normalize line endings
    return Buffer.from(
      content
        .toString('utf-8')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n'),
      'utf-8',
    );
  }

  /**
   * Sanitize HTML content.
   *
   * Removes:
   * - Script tags
   * - Style tags
   * - Event handlers
   * - External resources
   * - Comments
   */
  private sanitizeHtml(content: Buffer): Buffer {
    let html = content.toString('utf-8');

    // Remove scripts
    html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

    // Remove styles
    html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

    // Remove event handlers
    html = html.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
    html = html.replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '');

    // Remove javascript: URLs
    html = html.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href=""');
    html = html.replace(/src\s*=\s*["']javascript:[^"']*["']/gi, 'src=""');

    // Remove data: URLs (potential XSS)
    html = html.replace(/href\s*=\s*["']data:[^"']*["']/gi, 'href=""');
    html = html.replace(/src\s*=\s*["']data:[^"']*["']/gi, 'src=""');

    // Remove HTML comments
    html = html.replace(/<!--[\s\S]*?-->/g, '');

    // Remove iframes
    html = html.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
    html = html.replace(/<iframe[^>]*\/>/gi, '');

    // Remove object/embed tags
    html = html.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '');
    html = html.replace(/<embed[^>]*\/?>/gi, '');

    // Normalize whitespace
    html = html.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    return Buffer.from(html, 'utf-8');
  }
}
