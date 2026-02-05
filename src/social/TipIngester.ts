/**
 * @fileoverview TipIngester — processes on-chain tips into agent stimulus feed.
 *
 * Monitors on-chain tip events, processes content (URL fetch or text sanitization),
 * pins to IPFS, routes to agents with priority, and triggers settlement/refund.
 *
 * @module @framers/wunderland/social/TipIngester
 */

import { EventEmitter } from 'events';
import { ContentSanitizer, type SanitizedContent, ContentError, SSRFError } from './ContentSanitizer.js';
import { IpfsPinner, type PinningConfig, type PinResult, PinningError } from './IpfsPinner.js';
import type { StimulusRouter } from './StimulusRouter.js';
import type { Tip, TipPriorityLevel } from './types.js';

// ============================================================================
// Types
// ============================================================================

/** Priority levels matching on-chain TipPriority (re-exported from types). */
export type TipPriority = TipPriorityLevel;

/** Source type matching on-chain TipSourceType. */
export type TipSourceType = 'text' | 'url';

/** On-chain tip data (from indexer/RPC). */
export interface OnChainTip {
  /** Tip account public key. */
  tipPda: string;
  /** Tipper wallet public key. */
  tipper: string;
  /** Content hash (hex). */
  contentHash: string;
  /** Tip amount in lamports. */
  amount: number;
  /** Priority level. */
  priority: TipPriority;
  /** Source type. */
  sourceType: TipSourceType;
  /** Target enclave PDA (or system program for global). */
  targetEnclave: string;
  /** Tip nonce. */
  tipNonce: number;
  /** Creation timestamp (Unix seconds). */
  createdAt: number;
}

/** Off-chain tip content (submitted via API). */
export interface TipContent {
  /** Either URL or text content. */
  content: string;
  /** Source type. */
  sourceType: TipSourceType;
}

/** Result of processing a tip. */
export interface ProcessedTip {
  /** Original on-chain tip. */
  tip: OnChainTip;
  /** Whether processing succeeded. */
  success: boolean;
  /** Sanitized content (if successful). */
  sanitized?: SanitizedContent;
  /** IPFS pin result (if successful). */
  pinResult?: PinResult;
  /** Error message (if failed). */
  error?: string;
  /** Processing timestamp. */
  processedAt: Date;
}

/** Settlement callback signature. */
export type SettlementCallback = (tipPda: string) => Promise<void>;

/** Refund callback signature. */
export type RefundCallback = (tipPda: string, reason: string) => Promise<void>;

/** System program ID (used for global tips). */
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

// ============================================================================
// TipIngester
// ============================================================================

/**
 * Processes on-chain tips into the agent stimulus feed.
 *
 * @example
 * ```typescript
 * const ingester = new TipIngester(stimulusRouter, {
 *   provider: 'pinata',
 *   apiKey: 'xxx',
 * });
 *
 * ingester.onSettle(async (tipPda) => {
 *   // Call on-chain settle_tip instruction
 * });
 *
 * ingester.onRefund(async (tipPda, reason) => {
 *   // Call on-chain refund_tip instruction
 * });
 *
 * const result = await ingester.processTip(onChainTip, { content: 'Breaking news!', sourceType: 'text' });
 * ```
 */
export class TipIngester extends EventEmitter {
  private sanitizer: ContentSanitizer;
  private pinner: IpfsPinner;
  private router: StimulusRouter;
  private settleCallback?: SettlementCallback;
  private refundCallback?: RefundCallback;

  /** Pending tips being processed (for deduplication). */
  private processing: Set<string> = new Set();

  /** Processed tips log (for analytics). */
  private processedLog: ProcessedTip[] = [];

  /** Maximum processed log size. */
  private maxLogSize: number;

  constructor(
    router: StimulusRouter,
    pinningConfig: PinningConfig,
    options?: { maxLogSize?: number },
  ) {
    super();
    this.router = router;
    this.sanitizer = new ContentSanitizer();
    this.pinner = new IpfsPinner(pinningConfig);
    this.maxLogSize = options?.maxLogSize ?? 1000;
  }

  /**
   * Register settlement callback.
   */
  onSettle(callback: SettlementCallback): void {
    this.settleCallback = callback;
  }

  /**
   * Register refund callback.
   */
  onRefund(callback: RefundCallback): void {
    this.refundCallback = callback;
  }

  /**
   * Process a tip.
   *
   * @param tip On-chain tip data.
   * @param content Off-chain content (URL or text).
   * @returns Processing result.
   */
  async processTip(tip: OnChainTip, content: TipContent): Promise<ProcessedTip> {
    // Check for duplicate processing
    if (this.processing.has(tip.tipPda)) {
      return {
        tip,
        success: false,
        error: 'Tip is already being processed',
        processedAt: new Date(),
      };
    }

    this.processing.add(tip.tipPda);

    try {
      // 1. Sanitize content
      let sanitized: SanitizedContent;
      if (content.sourceType === 'url') {
        sanitized = await this.sanitizer.fetchAndSanitize(content.content);
      } else {
        sanitized = this.sanitizer.sanitizeText(content.content);
      }

      // 2. Verify content hash matches on-chain commitment
      if (sanitized.contentHash !== tip.contentHash) {
        const error = 'Content hash mismatch: content does not match on-chain commitment';
        await this.handleRefund(tip, error);
        return {
          tip,
          success: false,
          error,
          processedAt: new Date(),
        };
      }

      // 3. Pin to IPFS
      let pinResult: PinResult;
      try {
        pinResult = await this.pinner.pin(sanitized.content);
      } catch (err) {
        if (err instanceof PinningError) {
          const error = `IPFS pinning failed: ${err.message}`;
          await this.handleRefund(tip, error);
          return {
            tip,
            success: false,
            error,
            processedAt: new Date(),
          };
        }
        throw err;
      }

      // 4. Route to agents via StimulusRouter
      const isGlobal = tip.targetEnclave === SYSTEM_PROGRAM_ID;
      this.routeToAgents(tip, sanitized, pinResult, isGlobal);

      // 5. Settle on-chain
      await this.handleSettle(tip);

      const result: ProcessedTip = {
        tip,
        success: true,
        sanitized,
        pinResult,
        processedAt: new Date(),
      };

      this.logProcessed(result);
      this.emit('tip_processed', result);

      return result;
    } catch (err) {
      let error: string;

      if (err instanceof SSRFError) {
        error = `URL blocked (SSRF protection): ${err.message}`;
      } else if (err instanceof ContentError) {
        error = `Content fetch failed: ${err.message}`;
      } else if (err instanceof Error) {
        error = `Processing failed: ${err.message}`;
      } else {
        error = 'Unknown processing error';
      }

      await this.handleRefund(tip, error);

      const result: ProcessedTip = {
        tip,
        success: false,
        error,
        processedAt: new Date(),
      };

      this.logProcessed(result);
      this.emit('tip_failed', result);

      return result;
    } finally {
      this.processing.delete(tip.tipPda);
    }
  }

  /**
   * Check if a tip is currently being processed.
   */
  isProcessing(tipPda: string): boolean {
    return this.processing.has(tipPda);
  }

  /**
   * Get recent processed tips.
   */
  getProcessedLog(limit?: number): ProcessedTip[] {
    if (limit) {
      return this.processedLog.slice(-limit);
    }
    return [...this.processedLog];
  }

  /**
   * Get processing statistics.
   */
  getStats(): {
    totalProcessed: number;
    successCount: number;
    failureCount: number;
    currentlyProcessing: number;
  } {
    const successCount = this.processedLog.filter((p) => p.success).length;
    return {
      totalProcessed: this.processedLog.length,
      successCount,
      failureCount: this.processedLog.length - successCount,
      currentlyProcessing: this.processing.size,
    };
  }

  /**
   * Preview a tip without processing (for UI).
   */
  async previewTip(content: TipContent): Promise<{
    valid: boolean;
    contentHash?: string;
    contentLength?: number;
    error?: string;
  }> {
    try {
      let sanitized: SanitizedContent;
      if (content.sourceType === 'url') {
        sanitized = await this.sanitizer.fetchAndSanitize(content.content);
      } else {
        sanitized = this.sanitizer.sanitizeText(content.content);
      }

      return {
        valid: true,
        contentHash: sanitized.contentHash,
        contentLength: sanitized.contentLength,
      };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  // ── Private methods ──

  /**
   * Route tip content to agents via StimulusRouter.
   */
  private routeToAgents(
    tip: OnChainTip,
    sanitized: SanitizedContent,
    pinResult: PinResult,
    isGlobal: boolean,
  ): void {
    // Create Tip object matching the existing interface
    const tipObject: Tip = {
      tipId: tip.tipPda,
      tipPda: tip.tipPda,
      amount: tip.amount,
      priority: tip.priority,
      dataSource: {
        type: tip.sourceType === 'url' ? 'url' : 'text',
        payload: sanitized.content.toString('utf-8').slice(0, 1000), // Preview
      },
      attribution: {
        type: 'wallet',
        identifier: tip.tipper,
      },
      targetSeedIds: isGlobal ? undefined : [], // TODO: resolve enclave -> agent IDs
      targetEnclave: isGlobal ? undefined : tip.targetEnclave,
      visibility: 'public',
      createdAt: new Date(tip.createdAt * 1000).toISOString(),
      status: 'delivered',
      ipfsCid: pinResult.cid,
      contentHash: sanitized.contentHash,
    };

    // Ingest via router
    this.router.ingestTip(tipObject);
  }

  /**
   * Handle successful settlement.
   */
  private async handleSettle(tip: OnChainTip): Promise<void> {
    if (this.settleCallback) {
      try {
        await this.settleCallback(tip.tipPda);
      } catch (err) {
        console.error(`[TipIngester] Settlement callback failed for ${tip.tipPda}:`, err);
      }
    }
    this.emit('tip_settled', tip.tipPda);
  }

  /**
   * Handle refund.
   */
  private async handleRefund(tip: OnChainTip, reason: string): Promise<void> {
    if (this.refundCallback) {
      try {
        await this.refundCallback(tip.tipPda, reason);
      } catch (err) {
        console.error(`[TipIngester] Refund callback failed for ${tip.tipPda}:`, err);
      }
    }
    this.emit('tip_refunded', { tipPda: tip.tipPda, reason });
  }

  /**
   * Log processed tip (with size limit).
   */
  private logProcessed(result: ProcessedTip): void {
    this.processedLog.push(result);
    if (this.processedLog.length > this.maxLogSize) {
      this.processedLog.shift();
    }
  }
}
