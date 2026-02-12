/**
 * @fileoverview Tests for ActionAuditLog — ring buffer audit trail for agent actions
 * @module wunderland/social/__tests__/ActionAuditLog.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ActionAuditLog, type IAuditPersistenceAdapter, type AuditEntry } from '../ActionAuditLog.js';

function makeEntry(overrides: Partial<Omit<AuditEntry, 'entryId' | 'timestamp'>> = {}): Omit<AuditEntry, 'entryId' | 'timestamp'> {
  return {
    seedId: 'agent-1',
    action: 'post',
    outcome: 'success',
    ...overrides,
  };
}

describe('ActionAuditLog', () => {
  let log: ActionAuditLog;

  beforeEach(() => {
    log = new ActionAuditLog();
  });

  describe('log()', () => {
    it('should create entry with auto-generated ID and timestamp', () => {
      const before = Date.now();
      const entryId = log.log(makeEntry());
      const after = Date.now();

      expect(entryId).toMatch(/^audit_/);

      const entries = log.query({ seedId: 'agent-1' });
      expect(entries).toHaveLength(1);

      const entry = entries[0];
      expect(entry.entryId).toBe(entryId);
      expect(entry.timestamp).toBeGreaterThanOrEqual(before);
      expect(entry.timestamp).toBeLessThanOrEqual(after);
    });

    it('should return entryId as a string', () => {
      const entryId = log.log(makeEntry());
      expect(typeof entryId).toBe('string');
      expect(entryId.length).toBeGreaterThan(0);
    });
  });

  describe('query()', () => {
    beforeEach(() => {
      log.log(makeEntry({ seedId: 'agent-1', action: 'post', outcome: 'success' }));
      log.log(makeEntry({ seedId: 'agent-1', action: 'vote', outcome: 'success' }));
      log.log(makeEntry({ seedId: 'agent-2', action: 'post', outcome: 'failure' }));
      log.log(makeEntry({ seedId: 'agent-2', action: 'comment', outcome: 'rate_limited' }));
    });

    it('should filter by seedId', () => {
      const results = log.query({ seedId: 'agent-1' });
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.seedId === 'agent-1')).toBe(true);
    });

    it('should filter by action', () => {
      const results = log.query({ action: 'post' });
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.action === 'post')).toBe(true);
    });

    it('should respect limit and return last N entries', () => {
      const results = log.query({ limit: 2 });
      expect(results).toHaveLength(2);
      // Should be the last two entries logged
      expect(results[0].seedId).toBe('agent-2');
      expect(results[0].action).toBe('post');
      expect(results[1].seedId).toBe('agent-2');
      expect(results[1].action).toBe('comment');
    });
  });

  describe('ring buffer eviction', () => {
    it('should evict oldest entries when exceeding maxInMemoryEntries', () => {
      const smallLog = new ActionAuditLog({ maxInMemoryEntries: 5 });

      for (let i = 0; i < 10; i++) {
        smallLog.log(makeEntry({ seedId: `agent-${i}` }));
      }

      const allEntries = smallLog.query({});
      expect(allEntries).toHaveLength(5);

      // The remaining entries should be the last 5 logged (agents 5-9)
      const seedIds = allEntries.map((e) => e.seedId);
      expect(seedIds).toEqual(['agent-5', 'agent-6', 'agent-7', 'agent-8', 'agent-9']);
    });
  });

  describe('persistence adapter', () => {
    let adapter: IAuditPersistenceAdapter;

    beforeEach(() => {
      adapter = {
        appendEntries: vi.fn().mockResolvedValue(undefined),
        queryEntries: vi.fn().mockResolvedValue([]),
      };
    });

    it('should auto-flush to persistence adapter when threshold reached', async () => {
      const flushLog = new ActionAuditLog({ flushThreshold: 3 });
      flushLog.setPersistenceAdapter(adapter);

      flushLog.log(makeEntry());
      flushLog.log(makeEntry());
      expect(adapter.appendEntries).not.toHaveBeenCalled();

      flushLog.log(makeEntry());

      // Auto-flush is fire-and-forget (void this.flush()), so wait a tick
      await vi.waitFor(() => {
        expect(adapter.appendEntries).toHaveBeenCalledTimes(1);
      });

      const flushedEntries = (adapter.appendEntries as ReturnType<typeof vi.fn>).mock.calls[0][0] as AuditEntry[];
      expect(flushedEntries).toHaveLength(3);
    });

    it('should send pending entries on manual flush()', async () => {
      const flushLog = new ActionAuditLog({ flushThreshold: 100 }); // High threshold so auto-flush won't fire
      flushLog.setPersistenceAdapter(adapter);

      flushLog.log(makeEntry());
      flushLog.log(makeEntry());

      await flushLog.flush();

      expect(adapter.appendEntries).toHaveBeenCalledTimes(1);
      const flushedEntries = (adapter.appendEntries as ReturnType<typeof vi.fn>).mock.calls[0][0] as AuditEntry[];
      expect(flushedEntries).toHaveLength(2);
    });

    it('should retry on failure by putting entries back to pending', async () => {
      const failingAdapter: IAuditPersistenceAdapter = {
        appendEntries: vi.fn().mockRejectedValueOnce(new Error('DB down')),
        queryEntries: vi.fn().mockResolvedValue([]),
      };

      const flushLog = new ActionAuditLog({ flushThreshold: 100 });
      flushLog.setPersistenceAdapter(failingAdapter);

      flushLog.log(makeEntry());
      flushLog.log(makeEntry());

      // First flush fails — entries should go back to pending
      await flushLog.flush();

      // Second flush should try again with the same entries
      (failingAdapter.appendEntries as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
      await flushLog.flush();

      expect(failingAdapter.appendEntries).toHaveBeenCalledTimes(2);
      const secondCallEntries = (failingAdapter.appendEntries as ReturnType<typeof vi.fn>).mock.calls[1][0] as AuditEntry[];
      expect(secondCallEntries).toHaveLength(2);
    });
  });

  describe('getStats()', () => {
    it('should return correct totals grouped by agent and action', () => {
      log.log(makeEntry({ seedId: 'agent-1', action: 'post' }));
      log.log(makeEntry({ seedId: 'agent-1', action: 'vote' }));
      log.log(makeEntry({ seedId: 'agent-1', action: 'post' }));
      log.log(makeEntry({ seedId: 'agent-2', action: 'comment' }));

      const stats = log.getStats();

      expect(stats.total).toBe(4);
      expect(stats.byAgent).toEqual({ 'agent-1': 3, 'agent-2': 1 });
      expect(stats.byAction).toEqual({ post: 2, vote: 1, comment: 1 });
    });
  });

  describe('clear()', () => {
    it('should empty entries and pending flush queue', async () => {
      log.log(makeEntry());
      log.log(makeEntry());

      expect(log.query({}).length).toBe(2);

      log.clear();

      expect(log.query({})).toHaveLength(0);
      expect(log.getStats().total).toBe(0);
    });
  });

  describe('works without persistence adapter', () => {
    it('should log and query without errors when no adapter is set', () => {
      const standalone = new ActionAuditLog({ flushThreshold: 1 });

      // No adapter set — logging should not throw even when flush threshold is hit
      expect(() => standalone.log(makeEntry())).not.toThrow();
      expect(() => standalone.log(makeEntry())).not.toThrow();

      const entries = standalone.query({});
      expect(entries).toHaveLength(2);
    });

    it('should handle flush() gracefully when no adapter is set', async () => {
      log.log(makeEntry());
      await expect(log.flush()).resolves.toBeUndefined();
    });
  });
});
