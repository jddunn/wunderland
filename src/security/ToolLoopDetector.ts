/**
 * @fileoverview Tool Loop Detector — prevents infinite tool call loops
 * @module wunderland/security/ToolLoopDetector
 *
 * Detects when an agent gets stuck in a tool call loop (repeatedly invoking
 * the same tool with the same/similar arguments) and applies exponential
 * backoff to break the loop.
 *
 * Ported from OpenClaw upstream feature: configurable tool loop detection
 * with exponential backoff.
 */

/**
 * Configuration for the tool loop detector.
 */
export interface ToolLoopDetectorConfig {
  /**
   * Maximum number of identical tool calls before triggering loop detection.
   * Default: 3
   */
  maxRepeatedCalls?: number;

  /**
   * Time window in milliseconds to track repeated calls.
   * Calls older than this are forgotten.
   * Default: 60_000 (1 minute)
   */
  windowMs?: number;

  /**
   * Base delay for exponential backoff in milliseconds.
   * Default: 2_000 (2 seconds)
   */
  baseDelayMs?: number;

  /**
   * Maximum backoff delay in milliseconds.
   * Default: 60_000 (1 minute)
   */
  maxDelayMs?: number;

  /**
   * Maximum total calls (any tool) in a session before hard stopping.
   * Prevents runaway agents.
   * Default: 200
   */
  maxTotalCallsPerSession?: number;

  /**
   * Whether to enable the detector.
   * Default: true
   */
  enabled?: boolean;
}

/**
 * Record of a tool call for loop detection.
 */
interface ToolCallRecord {
  toolId: string;
  argsHash: string;
  timestamp: number;
}

/**
 * Result of a loop detection check.
 */
export interface LoopDetectionResult {
  /** Whether the call is allowed */
  allowed: boolean;

  /** If not allowed, the reason */
  reason?: string;

  /** Suggested delay before retrying (ms) */
  suggestedDelayMs?: number;

  /** Number of consecutive identical calls detected */
  consecutiveCount: number;

  /** Total calls in session */
  totalCalls: number;

  /** Whether a loop was detected */
  loopDetected: boolean;
}

/**
 * Detects and prevents tool call loops with exponential backoff.
 *
 * @example
 * ```typescript
 * const detector = new ToolLoopDetector({ maxRepeatedCalls: 3 });
 *
 * // First call: allowed
 * detector.check('web_search', { query: 'hello' });
 * // → { allowed: true, consecutiveCount: 1, loopDetected: false }
 *
 * // Second identical call: allowed
 * detector.check('web_search', { query: 'hello' });
 * // → { allowed: true, consecutiveCount: 2, loopDetected: false }
 *
 * // Third identical call: loop detected, backoff suggested
 * detector.check('web_search', { query: 'hello' });
 * // → { allowed: false, loopDetected: true, suggestedDelayMs: 2000 }
 * ```
 */
export class ToolLoopDetector {
  private readonly config: Required<ToolLoopDetectorConfig>;
  private callHistory: ToolCallRecord[] = [];
  private totalCalls = 0;

  constructor(config: ToolLoopDetectorConfig = {}) {
    this.config = {
      maxRepeatedCalls: config.maxRepeatedCalls ?? 3,
      windowMs: config.windowMs ?? 60_000,
      baseDelayMs: config.baseDelayMs ?? 2_000,
      maxDelayMs: config.maxDelayMs ?? 60_000,
      maxTotalCallsPerSession: config.maxTotalCallsPerSession ?? 200,
      enabled: config.enabled ?? true,
    };
  }

  /**
   * Checks if a tool call should be allowed or if a loop is detected.
   *
   * @param toolId - The tool being called
   * @param args - The tool arguments
   * @returns Detection result with backoff suggestion
   */
  check(toolId: string, args: Record<string, unknown>): LoopDetectionResult {
    if (!this.config.enabled) {
      return { allowed: true, consecutiveCount: 0, totalCalls: this.totalCalls, loopDetected: false };
    }

    this.totalCalls++;

    // Hard limit on total calls
    if (this.totalCalls > this.config.maxTotalCallsPerSession) {
      return {
        allowed: false,
        reason: `Session tool call limit exceeded (${this.config.maxTotalCallsPerSession}). Agent may be in a runaway state.`,
        consecutiveCount: 0,
        totalCalls: this.totalCalls,
        loopDetected: true,
      };
    }

    const now = Date.now();
    const argsHash = this.hashArgs(args);

    // Prune old records outside the window
    this.callHistory = this.callHistory.filter(
      (r) => now - r.timestamp < this.config.windowMs
    );

    // Count consecutive identical calls (same tool + same args)
    let consecutiveCount = 0;
    for (let i = this.callHistory.length - 1; i >= 0; i--) {
      const record = this.callHistory[i];
      if (record.toolId === toolId && record.argsHash === argsHash) {
        consecutiveCount++;
      } else {
        break; // Non-matching call breaks the streak
      }
    }

    // Record this call
    this.callHistory.push({ toolId, argsHash, timestamp: now });

    // Include current call in count
    consecutiveCount++;

    // Check if loop threshold exceeded
    if (consecutiveCount > this.config.maxRepeatedCalls) {
      const exponent = consecutiveCount - this.config.maxRepeatedCalls;
      const delay = Math.min(
        this.config.baseDelayMs * Math.pow(2, exponent - 1),
        this.config.maxDelayMs
      );

      return {
        allowed: false,
        reason: `Tool loop detected: "${toolId}" called ${consecutiveCount} times with identical arguments. Backoff: ${delay}ms.`,
        suggestedDelayMs: delay,
        consecutiveCount,
        totalCalls: this.totalCalls,
        loopDetected: true,
      };
    }

    return {
      allowed: true,
      consecutiveCount,
      totalCalls: this.totalCalls,
      loopDetected: false,
    };
  }

  /**
   * Records a tool call without checking for loops.
   * Used for tool calls that bypass loop detection (e.g., HITL responses).
   */
  record(toolId: string, args: Record<string, unknown>): void {
    this.totalCalls++;
    this.callHistory.push({
      toolId,
      argsHash: this.hashArgs(args),
      timestamp: Date.now(),
    });
  }

  /**
   * Resets the detector state. Call this at session boundaries.
   */
  reset(): void {
    this.callHistory = [];
    this.totalCalls = 0;
  }

  /**
   * Gets statistics about the current session.
   */
  getStats(): {
    totalCalls: number;
    uniqueTools: number;
    historySize: number;
    windowMs: number;
  } {
    const uniqueTools = new Set(this.callHistory.map((r) => r.toolId)).size;
    return {
      totalCalls: this.totalCalls,
      uniqueTools,
      historySize: this.callHistory.length,
      windowMs: this.config.windowMs,
    };
  }

  /**
   * Creates a deterministic hash of tool arguments for comparison.
   */
  private hashArgs(args: Record<string, unknown>): string {
    try {
      // Sort keys for deterministic comparison
      const sorted = JSON.stringify(args, Object.keys(args).sort());
      // Simple hash for fast comparison (not cryptographic)
      let hash = 0;
      for (let i = 0; i < sorted.length; i++) {
        const char = sorted.charCodeAt(i);
        hash = ((hash << 5) - hash + char) | 0; // eslint-disable-line no-bitwise
      }
      return hash.toString(36);
    } catch {
      return 'unhashable';
    }
  }
}
