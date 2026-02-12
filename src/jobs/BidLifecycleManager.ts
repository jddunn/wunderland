/**
 * @file BidLifecycleManager.ts
 * @description Automatically detects and withdraws losing bids to free up agent bandwidth.
 *
 * Features:
 * - Polls active bids via callback
 * - Detects losing bids (job assigned to another agent, or job cancelled/completed)
 * - Withdraws via callback (so backend can wire up Solana)
 * - start/stop lifecycle matching JobScanner pattern
 * - Tracks withdrawal statistics
 */

export interface ActiveBid {
  bidId: string;
  jobId: string;
  agentId: string;
  amountLamports: number;
  createdAt: number;
}

export interface JobStatus {
  status: 'open' | 'assigned' | 'submitted' | 'completed' | 'cancelled';
  assignedAgent?: string | null;
}

export interface WithdrawResult {
  success: boolean;
  signature?: string;
  error?: string;
}

/**
 * Callback to fetch active bids for an agent.
 */
export type FetchActiveBidsCallback = (
  agentId: string,
) => Promise<ActiveBid[]>;

/**
 * Callback to get the current status of a job.
 */
export type GetJobStatusCallback = (
  jobId: string,
) => Promise<JobStatus | null>;

/**
 * Callback to withdraw a bid (on-chain or local DB).
 */
export type WithdrawBidCallback = (params: {
  agentId: string;
  bidId: string;
  jobId: string;
}) => Promise<WithdrawResult>;

/**
 * Callback invoked when a bid is marked inactive (job completed/cancelled, no withdrawal needed).
 */
export type OnBidInactiveCallback = (params: {
  agentId: string;
  bidId: string;
  jobId: string;
  reason: 'completed' | 'cancelled';
}) => Promise<void>;

/**
 * Callback invoked when workload should be decremented.
 */
export type OnWorkloadDecrementCallback = (agentId: string) => Promise<void>;

export interface BidLifecycleManagerConfig {
  /**
   * Polling interval in ms (default: 30000)
   */
  pollIntervalMs?: number;

  /**
   * Callback to fetch active bids for an agent
   */
  fetchActiveBids: FetchActiveBidsCallback;

  /**
   * Callback to get the status of a job
   */
  getJobStatus: GetJobStatusCallback;

  /**
   * Callback to withdraw a bid
   */
  withdrawBid: WithdrawBidCallback;

  /**
   * Optional callback when a bid is marked inactive
   */
  onBidInactive?: OnBidInactiveCallback;

  /**
   * Optional callback to decrement agent workload
   */
  onWorkloadDecrement?: OnWorkloadDecrementCallback;
}

export interface BidLifecycleStats {
  totalWithdrawn: number;
  totalMarkedInactive: number;
  lastPollAt: number | null;
}

/**
 * Manages bid lifecycle by detecting and withdrawing losing bids.
 */
export class BidLifecycleManager {
  private readonly config: Required<Pick<BidLifecycleManagerConfig, 'pollIntervalMs'>> &
    BidLifecycleManagerConfig;
  private intervalId?: ReturnType<typeof setInterval>;
  private agentId?: string;
  private readonly stats: BidLifecycleStats = {
    totalWithdrawn: 0,
    totalMarkedInactive: 0,
    lastPollAt: null,
  };

  constructor(config: BidLifecycleManagerConfig) {
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 30_000,
      ...config,
    };
  }

  /**
   * Start the withdrawal loop for an agent.
   */
  start(agentId: string): void {
    if (this.intervalId) {
      console.warn(`[BidLifecycleManager] Already running for agent ${this.agentId}`);
      return;
    }

    this.agentId = agentId;
    console.log(
      `[BidLifecycleManager] Starting withdrawal loop for agent ${agentId} (interval: ${this.config.pollIntervalMs}ms)`,
    );

    // Initial poll
    void this.pollAndWithdraw();

    // Set up periodic polling
    this.intervalId = setInterval(() => {
      void this.pollAndWithdraw();
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop the withdrawal loop.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      console.log(`[BidLifecycleManager] Stopped for agent ${this.agentId}`);
    }
  }

  /**
   * Get current status.
   */
  getStatus(): {
    isRunning: boolean;
    agentId?: string;
    stats: BidLifecycleStats;
  } {
    return {
      isRunning: !!this.intervalId,
      agentId: this.agentId,
      stats: { ...this.stats },
    };
  }

  /**
   * Manually trigger a withdrawal check (useful for testing).
   */
  async checkAndWithdraw(agentId: string): Promise<number> {
    return this.withdrawLosingBids(agentId);
  }

  /**
   * Poll and withdraw losing bids.
   */
  private async pollAndWithdraw(): Promise<void> {
    if (!this.agentId) return;

    try {
      await this.withdrawLosingBids(this.agentId);
      this.stats.lastPollAt = Date.now();
    } catch (err) {
      console.error(
        `[BidLifecycleManager] Error in withdrawal loop for ${this.agentId}:`,
        err,
      );
    }
  }

  /**
   * Find and withdraw losing bids. Returns number of bids withdrawn.
   */
  private async withdrawLosingBids(agentId: string): Promise<number> {
    const activeBids = await this.config.fetchActiveBids(agentId);

    if (activeBids.length === 0) return 0;

    let withdrawnCount = 0;

    for (const bid of activeBids) {
      const jobStatus = await this.config.getJobStatus(bid.jobId);

      if (!jobStatus) {
        console.warn(`[BidLifecycleManager] Job ${bid.jobId} not found`);
        continue;
      }

      // Job assigned to another agent — withdraw our bid
      if (
        jobStatus.status === 'assigned' &&
        jobStatus.assignedAgent !== agentId
      ) {
        const success = await this.withdrawBid(agentId, bid);
        if (success) withdrawnCount++;
      }

      // Job cancelled or completed — mark bid inactive
      if (
        jobStatus.status === 'cancelled' ||
        jobStatus.status === 'completed'
      ) {
        await this.markBidInactive(agentId, bid, jobStatus.status as 'cancelled' | 'completed');
      }
    }

    if (withdrawnCount > 0) {
      console.log(
        `[BidLifecycleManager] Agent ${agentId} withdrew ${withdrawnCount} losing bid(s)`,
      );
    }

    return withdrawnCount;
  }

  /**
   * Withdraw a single bid.
   */
  private async withdrawBid(agentId: string, bid: ActiveBid): Promise<boolean> {
    try {
      const result = await this.config.withdrawBid({
        agentId,
        bidId: bid.bidId,
        jobId: bid.jobId,
      });

      if (!result.success) {
        console.error(
          `[BidLifecycleManager] Failed to withdraw bid ${bid.bidId}: ${result.error}`,
        );
        return false;
      }

      this.stats.totalWithdrawn++;

      // Decrement workload
      if (this.config.onWorkloadDecrement) {
        await this.config.onWorkloadDecrement(agentId);
      }

      console.log(
        `[BidLifecycleManager] Bid withdrawn — agent=${agentId}, bid=${bid.bidId}, job=${bid.jobId}, sig=${result.signature ?? 'n/a'}`,
      );

      return true;
    } catch (err) {
      console.error(`[BidLifecycleManager] Error withdrawing bid ${bid.bidId}:`, err);
      return false;
    }
  }

  /**
   * Mark a bid as inactive (no on-chain withdrawal needed).
   */
  private async markBidInactive(
    agentId: string,
    bid: ActiveBid,
    reason: 'cancelled' | 'completed',
  ): Promise<void> {
    this.stats.totalMarkedInactive++;

    if (this.config.onBidInactive) {
      try {
        await this.config.onBidInactive({
          agentId,
          bidId: bid.bidId,
          jobId: bid.jobId,
          reason,
        });
      } catch (err) {
        console.error('[BidLifecycleManager] onBidInactive callback failed:', err);
      }
    }

    console.log(
      `[BidLifecycleManager] Bid ${bid.bidId} marked inactive (job ${reason})`,
    );
  }
}
