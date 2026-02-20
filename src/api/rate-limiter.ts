/**
 * @fileoverview In-memory sliding-window rate limiter for the Wunderland API server.
 * @module wunderland/api/rate-limiter
 *
 * Token-bucket style rate limiter keyed by client identifier (IP, API key, etc.).
 * No external dependencies — uses a Map with periodic cleanup.
 */

// ============================================================================
// Types
// ============================================================================

export interface RateLimiterConfig {
  /** Maximum requests per window. @default 60 */
  maxRequests: number;
  /** Window size in milliseconds. @default 60_000 (1 minute) */
  windowMs: number;
  /** Cleanup interval for expired entries. @default 300_000 (5 minutes) */
  cleanupIntervalMs: number;
}

export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Remaining requests in the current window. */
  remaining: number;
  /** Total limit. */
  limit: number;
  /** When the current window resets (epoch ms). */
  resetAt: number;
  /** Retry-After in seconds (only set when blocked). */
  retryAfterSec?: number;
}

interface BucketEntry {
  /** Timestamps of requests within the current window. */
  timestamps: number[];
}

// ============================================================================
// RateLimiter
// ============================================================================

/**
 * In-memory sliding-window rate limiter.
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter({ maxRequests: 30, windowMs: 60_000 });
 *
 * // In HTTP handler:
 * const clientKey = req.socket.remoteAddress ?? 'unknown';
 * const result = limiter.check(clientKey);
 * if (!result.allowed) {
 *   res.writeHead(429, {
 *     'Retry-After': String(result.retryAfterSec ?? 60),
 *     'X-RateLimit-Limit': String(result.limit),
 *     'X-RateLimit-Remaining': String(result.remaining),
 *   });
 *   res.end(JSON.stringify({ error: 'Too Many Requests' }));
 *   return;
 * }
 * ```
 */
export class RateLimiter {
  private readonly config: RateLimiterConfig;
  private readonly buckets = new Map<string, BucketEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = {
      maxRequests: config?.maxRequests ?? 60,
      windowMs: config?.windowMs ?? 60_000,
      cleanupIntervalMs: config?.cleanupIntervalMs ?? 300_000,
    };

    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);
    // Allow the timer to not block process exit
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      (this.cleanupTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Check and consume a request for the given client key.
   * Returns whether the request is allowed and rate limit metadata.
   */
  check(clientKey: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let entry = this.buckets.get(clientKey);
    if (!entry) {
      entry = { timestamps: [] };
      this.buckets.set(clientKey, entry);
    }

    // Prune timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    const resetAt = entry.timestamps.length > 0
      ? entry.timestamps[0] + this.config.windowMs
      : now + this.config.windowMs;

    if (entry.timestamps.length >= this.config.maxRequests) {
      const retryAfterMs = entry.timestamps[0] + this.config.windowMs - now;
      return {
        allowed: false,
        remaining: 0,
        limit: this.config.maxRequests,
        resetAt,
        retryAfterSec: Math.ceil(Math.max(1, retryAfterMs / 1000)),
      };
    }

    // Allow and record
    entry.timestamps.push(now);

    return {
      allowed: true,
      remaining: this.config.maxRequests - entry.timestamps.length,
      limit: this.config.maxRequests,
      resetAt,
    };
  }

  /**
   * Get current usage for a client without consuming a request.
   */
  peek(clientKey: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    const entry = this.buckets.get(clientKey);
    if (!entry) {
      return {
        allowed: true,
        remaining: this.config.maxRequests,
        limit: this.config.maxRequests,
        resetAt: now + this.config.windowMs,
      };
    }

    const active = entry.timestamps.filter((t) => t > windowStart);
    return {
      allowed: active.length < this.config.maxRequests,
      remaining: Math.max(0, this.config.maxRequests - active.length),
      limit: this.config.maxRequests,
      resetAt: active.length > 0 ? active[0] + this.config.windowMs : now + this.config.windowMs,
    };
  }

  /**
   * Reset rate limit for a specific client.
   */
  reset(clientKey: string): void {
    this.buckets.delete(clientKey);
  }

  /**
   * Clean up expired entries.
   */
  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    for (const [key, entry] of this.buckets.entries()) {
      entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
      if (entry.timestamps.length === 0) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Shut down the cleanup timer.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.buckets.clear();
  }

  /**
   * Get stats about current rate limiter state.
   */
  getStats(): { trackedClients: number; totalRequests: number } {
    let totalRequests = 0;
    for (const entry of this.buckets.values()) {
      totalRequests += entry.timestamps.length;
    }
    return {
      trackedClients: this.buckets.size,
      totalRequests,
    };
  }
}
