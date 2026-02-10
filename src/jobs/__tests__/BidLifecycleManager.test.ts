/**
 * @file BidLifecycleManager.test.ts
 * @description Unit tests for BidLifecycleManager — detecting and withdrawing losing bids.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BidLifecycleManager } from '../BidLifecycleManager.js';
import type { ActiveBid, JobStatus, WithdrawResult } from '../BidLifecycleManager.js';

describe('BidLifecycleManager', () => {
  const makeBid = (overrides?: Partial<ActiveBid>): ActiveBid => ({
    bidId: 'bid-1',
    jobId: 'job-1',
    agentId: 'agent-1',
    amountLamports: 500_000_000,
    createdAt: Date.now(),
    ...overrides,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkAndWithdraw', () => {
    it('should withdraw bids when job assigned to another agent', async () => {
      const withdrawBid = vi.fn().mockResolvedValue({
        success: true,
        signature: 'sig-123',
      } as WithdrawResult);

      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([
          makeBid({ bidId: 'bid-1', jobId: 'job-1' }),
        ]),
        getJobStatus: vi.fn().mockResolvedValue({
          status: 'assigned',
          assignedAgent: 'other-agent',
        } as JobStatus),
        withdrawBid,
      });

      const count = await manager.checkAndWithdraw('agent-1');

      expect(count).toBe(1);
      expect(withdrawBid).toHaveBeenCalledWith({
        agentId: 'agent-1',
        bidId: 'bid-1',
        jobId: 'job-1',
      });
    });

    it('should NOT withdraw bids when job assigned to this agent', async () => {
      const withdrawBid = vi.fn();

      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([
          makeBid({ agentId: 'agent-1' }),
        ]),
        getJobStatus: vi.fn().mockResolvedValue({
          status: 'assigned',
          assignedAgent: 'agent-1', // Same agent
        } as JobStatus),
        withdrawBid,
      });

      const count = await manager.checkAndWithdraw('agent-1');

      expect(count).toBe(0);
      expect(withdrawBid).not.toHaveBeenCalled();
    });

    it('should NOT withdraw bids when job is still open', async () => {
      const withdrawBid = vi.fn();

      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([makeBid()]),
        getJobStatus: vi.fn().mockResolvedValue({
          status: 'open',
        } as JobStatus),
        withdrawBid,
      });

      const count = await manager.checkAndWithdraw('agent-1');

      expect(count).toBe(0);
      expect(withdrawBid).not.toHaveBeenCalled();
    });

    it('should mark bids as inactive when job is cancelled', async () => {
      const onBidInactive = vi.fn().mockResolvedValue(undefined);

      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([makeBid()]),
        getJobStatus: vi.fn().mockResolvedValue({
          status: 'cancelled',
        } as JobStatus),
        withdrawBid: vi.fn(),
        onBidInactive,
      });

      await manager.checkAndWithdraw('agent-1');

      expect(onBidInactive).toHaveBeenCalledWith({
        agentId: 'agent-1',
        bidId: 'bid-1',
        jobId: 'job-1',
        reason: 'cancelled',
      });
    });

    it('should mark bids as inactive when job is completed', async () => {
      const onBidInactive = vi.fn().mockResolvedValue(undefined);

      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([makeBid()]),
        getJobStatus: vi.fn().mockResolvedValue({
          status: 'completed',
        } as JobStatus),
        withdrawBid: vi.fn(),
        onBidInactive,
      });

      await manager.checkAndWithdraw('agent-1');

      expect(onBidInactive).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'completed' }),
      );
    });

    it('should call onWorkloadDecrement after successful withdrawal', async () => {
      const onWorkloadDecrement = vi.fn().mockResolvedValue(undefined);

      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([makeBid()]),
        getJobStatus: vi.fn().mockResolvedValue({
          status: 'assigned',
          assignedAgent: 'other-agent',
        } as JobStatus),
        withdrawBid: vi.fn().mockResolvedValue({ success: true, signature: 'sig' }),
        onWorkloadDecrement,
      });

      await manager.checkAndWithdraw('agent-1');

      expect(onWorkloadDecrement).toHaveBeenCalledWith('agent-1');
    });

    it('should handle multiple bids in a single pass', async () => {
      const withdrawBid = vi.fn().mockResolvedValue({ success: true, signature: 'sig' });
      const onBidInactive = vi.fn().mockResolvedValue(undefined);

      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([
          makeBid({ bidId: 'bid-1', jobId: 'job-1' }),
          makeBid({ bidId: 'bid-2', jobId: 'job-2' }),
          makeBid({ bidId: 'bid-3', jobId: 'job-3' }),
        ]),
        getJobStatus: vi.fn().mockImplementation(async (jobId: string) => {
          if (jobId === 'job-1') return { status: 'assigned', assignedAgent: 'other' };
          if (jobId === 'job-2') return { status: 'cancelled' };
          return { status: 'open' };
        }),
        withdrawBid,
        onBidInactive,
      });

      const count = await manager.checkAndWithdraw('agent-1');

      expect(count).toBe(1); // Only job-1 withdrawal
      expect(withdrawBid).toHaveBeenCalledTimes(1);
      expect(onBidInactive).toHaveBeenCalledTimes(1); // job-2 cancelled
    });

    it('should return 0 when no active bids', async () => {
      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([]),
        getJobStatus: vi.fn(),
        withdrawBid: vi.fn(),
      });

      const count = await manager.checkAndWithdraw('agent-1');
      expect(count).toBe(0);
    });

    it('should handle withdrawal failure gracefully', async () => {
      const withdrawBid = vi.fn().mockResolvedValue({
        success: false,
        error: 'Solana RPC error',
      } as WithdrawResult);

      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([makeBid()]),
        getJobStatus: vi.fn().mockResolvedValue({
          status: 'assigned',
          assignedAgent: 'other-agent',
        }),
        withdrawBid,
      });

      const count = await manager.checkAndWithdraw('agent-1');

      expect(count).toBe(0); // Withdrawal failed
    });

    it('should handle missing job gracefully', async () => {
      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([makeBid()]),
        getJobStatus: vi.fn().mockResolvedValue(null),
        withdrawBid: vi.fn(),
      });

      const count = await manager.checkAndWithdraw('agent-1');
      expect(count).toBe(0);
    });
  });

  describe('start/stop lifecycle', () => {
    it('should report running status after start', () => {
      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([]),
        getJobStatus: vi.fn(),
        withdrawBid: vi.fn(),
        pollIntervalMs: 60_000,
      });

      manager.start('agent-1');

      const status = manager.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status.agentId).toBe('agent-1');

      manager.stop();
    });

    it('should report stopped status after stop', () => {
      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([]),
        getJobStatus: vi.fn(),
        withdrawBid: vi.fn(),
        pollIntervalMs: 60_000,
      });

      manager.start('agent-1');
      manager.stop();

      const status = manager.getStatus();
      expect(status.isRunning).toBe(false);
    });

    it('should not start twice', () => {
      const consoleSpy = vi.spyOn(console, 'warn');
      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([]),
        getJobStatus: vi.fn(),
        withdrawBid: vi.fn(),
        pollIntervalMs: 60_000,
      });

      manager.start('agent-1');
      manager.start('agent-1');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Already running'),
      );

      manager.stop();
      consoleSpy.mockRestore();
    });

    it('should poll on start', async () => {
      const fetchActiveBids = vi.fn().mockResolvedValue([]);
      const manager = new BidLifecycleManager({
        fetchActiveBids,
        getJobStatus: vi.fn(),
        withdrawBid: vi.fn(),
        pollIntervalMs: 60_000,
      });

      manager.start('agent-1');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fetchActiveBids).toHaveBeenCalledWith('agent-1');

      manager.stop();
    });
  });

  describe('Stats tracking', () => {
    it('should track withdrawal count', async () => {
      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([
          makeBid({ bidId: 'bid-1', jobId: 'job-1' }),
          makeBid({ bidId: 'bid-2', jobId: 'job-2' }),
        ]),
        getJobStatus: vi.fn().mockResolvedValue({
          status: 'assigned',
          assignedAgent: 'other-agent',
        }),
        withdrawBid: vi.fn().mockResolvedValue({ success: true, signature: 'sig' }),
      });

      await manager.checkAndWithdraw('agent-1');

      const status = manager.getStatus();
      expect(status.stats.totalWithdrawn).toBe(2);
    });

    it('should track inactive bid count', async () => {
      const manager = new BidLifecycleManager({
        fetchActiveBids: vi.fn().mockResolvedValue([
          makeBid({ bidId: 'bid-1', jobId: 'job-1' }),
        ]),
        getJobStatus: vi.fn().mockResolvedValue({ status: 'cancelled' }),
        withdrawBid: vi.fn(),
      });

      await manager.checkAndWithdraw('agent-1');

      const status = manager.getStatus();
      expect(status.stats.totalMarkedInactive).toBe(1);
    });
  });
});
