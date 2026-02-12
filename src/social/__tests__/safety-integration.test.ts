/**
 * @fileoverview Integration tests — safety components working together in
 * WonderlandNetwork-like scenarios.
 * @module wunderland/social/__tests__/safety-integration.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ActionAuditLog } from '../ActionAuditLog.js';
import { ContentSimilarityDedup } from '../ContentSimilarityDedup.js';
import { SafetyEngine } from '../SafetyEngine.js';
import { CircuitBreaker } from '@framers/agentos/core/safety/CircuitBreaker';
import { ActionDeduplicator } from '@framers/agentos/core/safety/ActionDeduplicator';
import { StuckDetector } from '@framers/agentos/core/safety/StuckDetector';
import { CostGuard } from '@framers/agentos/core/safety/CostGuard';

describe('Safety Integration', () => {
  let auditLog: ActionAuditLog;
  let dedup: ContentSimilarityDedup;
  let safety: SafetyEngine;
  let breaker: CircuitBreaker;
  let actionDedup: ActionDeduplicator;
  let stuckDetector: StuckDetector;
  let costGuard: CostGuard;

  beforeEach(() => {
    auditLog = new ActionAuditLog();
    dedup = new ContentSimilarityDedup();
    safety = new SafetyEngine({
      post: { maxActions: 10, windowMs: 3_600_000 },
    });
    breaker = new CircuitBreaker({
      name: 'llm',
      failureThreshold: 5,
      failureWindowMs: 60_000,
      cooldownMs: 5_000,
      halfOpenSuccessThreshold: 2,
    });
    actionDedup = new ActionDeduplicator({ windowMs: 60_000 });
    stuckDetector = new StuckDetector({ repetitionThreshold: 3, windowMs: 300_000 });
    costGuard = new CostGuard({
      maxSessionCostUsd: 1.0,
      maxDailyCostUsd: 5.0,
      maxSingleOperationCostUsd: 0.50,
    });
  });

  describe('circuit breaker opens -> SafetyEngine pauses agent', () => {
    it('should pause an agent when the circuit breaker trips', () => {
      const agentId = 'agent-llm';

      breaker = new CircuitBreaker({
        name: 'llm',
        failureThreshold: 5,
        failureWindowMs: 60_000,
        cooldownMs: 30_000,
        halfOpenSuccessThreshold: 2,
        onStateChange: (_from, to, _name) => {
          if (to === 'open') {
            safety.pauseAgent(agentId, 'Circuit breaker tripped — too many LLM failures');
          }
        },
      });

      // Simulate 5 LLM failures
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure();
      }

      expect(breaker.getState()).toBe('open');

      const canAct = safety.canAct(agentId);
      expect(canAct.allowed).toBe(false);
      expect(canAct.reason).toContain('paused');

      auditLog.log({
        seedId: agentId,
        action: 'llm_call',
        outcome: 'circuit_open',
      });

      const entries = auditLog.query({ seedId: agentId, action: 'llm_call' });
      expect(entries).toHaveLength(1);
      expect(entries[0].outcome).toBe('circuit_open');
    });
  });

  describe('cost guard cap -> SafetyEngine pauses agent', () => {
    it('should pause an agent when the daily cost cap is reached', () => {
      const agentId = 'agent-spender';
      const capReached = vi.fn();

      costGuard = new CostGuard({
        maxSessionCostUsd: 10.0,
        maxDailyCostUsd: 1.0,
        maxSingleOperationCostUsd: 0.50,
        onCapReached: (id, capType, currentCost, limit) => {
          capReached(id, capType, currentCost, limit);
          safety.pauseAgent(id, `Cost cap '${capType}' exceeded: $${currentCost.toFixed(2)} >= $${limit.toFixed(2)}`);
        },
      });

      // Record costs until the daily cap is hit
      for (let i = 0; i < 5; i++) {
        costGuard.recordCost(agentId, 0.20, `op-${i}`);
      }

      // $1.00 total >= $1.00 daily cap
      expect(capReached).toHaveBeenCalled();
      expect(capReached).toHaveBeenCalledWith(agentId, 'daily', expect.any(Number), 1.0);

      const canAct = safety.canAct(agentId);
      expect(canAct.allowed).toBe(false);
      expect(canAct.reason).toContain('paused');

      const snapshot = costGuard.getSnapshot(agentId);
      expect(snapshot.isDailyCapReached).toBe(true);
    });
  });

  describe('stuck detector -> pause', () => {
    it('should detect stuck agent after 3 identical outputs and pause', () => {
      const agentId = 'agent-stuck';

      const sameOutput = 'I am not sure how to proceed with this task.';

      let detection;
      for (let i = 0; i < 3; i++) {
        detection = stuckDetector.recordOutput(agentId, sameOutput);
      }

      expect(detection!.isStuck).toBe(true);
      expect(detection!.reason).toBe('repeated_output');
      expect(detection!.repetitionCount).toBe(3);

      // SafetyEngine reacts to stuck detection
      safety.pauseAgent(agentId, `Stuck: ${detection!.details}`);

      const canAct = safety.canAct(agentId);
      expect(canAct.allowed).toBe(false);
    });
  });

  describe('rate limiting blocks actions', () => {
    it('should block the 11th post after 10 are recorded', () => {
      const agentId = 'agent-spammer';

      for (let i = 0; i < 10; i++) {
        const check = safety.checkRateLimit(agentId, 'post');
        expect(check.allowed).toBe(true);
        safety.recordAction(agentId, 'post');

        auditLog.log({
          seedId: agentId,
          action: 'post',
          outcome: 'success',
        });
      }

      // 11th should be rate limited
      const check11 = safety.checkRateLimit(agentId, 'post');
      expect(check11.allowed).toBe(false);
      expect(check11.reason).toContain('Rate limit exceeded');

      auditLog.log({
        seedId: agentId,
        action: 'post',
        outcome: 'rate_limited',
      });

      const allEntries = auditLog.query({ seedId: agentId, action: 'post' });
      expect(allEntries).toHaveLength(11);
      expect(allEntries.filter((e) => e.outcome === 'success')).toHaveLength(10);
      expect(allEntries.filter((e) => e.outcome === 'rate_limited')).toHaveLength(1);
    });
  });

  describe('content dedup blocks near-identical posts', () => {
    it('should block a second near-identical post', () => {
      const agentId = 'agent-repeater';
      const originalContent = 'The governance proposal for treasury allocation was very well received by the community';

      // First post succeeds
      const first = dedup.check(agentId, originalContent);
      expect(first.isDuplicate).toBe(false);
      dedup.record(agentId, 'post-1', originalContent);

      auditLog.log({
        seedId: agentId,
        action: 'post',
        outcome: 'success',
      });

      // Second identical post is blocked
      const second = dedup.check(agentId, originalContent);
      expect(second.isDuplicate).toBe(true);
      expect(second.similarity).toBe(1.0);
      expect(second.similarTo).toBe('post-1');

      auditLog.log({
        seedId: agentId,
        action: 'post',
        outcome: 'deduplicated',
        metadata: { similarTo: second.similarTo, similarity: second.similarity },
      });

      const dedupedEntries = auditLog.query({ seedId: agentId }).filter((e) => e.outcome === 'deduplicated');
      expect(dedupedEntries).toHaveLength(1);
    });
  });

  describe('action deduplicator prevents double votes', () => {
    it('should detect a duplicate vote key', () => {
      const voteKey = 'agent-voter:vote:post-99:up';

      // First vote — not a duplicate
      const first = actionDedup.checkAndRecord(voteKey);
      expect(first.isDuplicate).toBe(false);

      // Second vote with the same key — duplicate
      const second = actionDedup.checkAndRecord(voteKey);
      expect(second.isDuplicate).toBe(true);

      auditLog.log({
        seedId: 'agent-voter',
        action: 'vote',
        targetId: 'post-99',
        outcome: 'deduplicated',
      });

      const entries = auditLog.query({ action: 'vote' });
      expect(entries).toHaveLength(1);
      expect(entries[0].outcome).toBe('deduplicated');
    });
  });

  describe('audit log records all outcome types', () => {
    it('should contain entries for success, failure, rate_limited, deduplicated, and circuit_open', () => {
      const outcomes: Array<'success' | 'failure' | 'rate_limited' | 'deduplicated' | 'circuit_open'> = [
        'success',
        'failure',
        'rate_limited',
        'deduplicated',
        'circuit_open',
      ];

      for (const outcome of outcomes) {
        auditLog.log({
          seedId: 'agent-all',
          action: 'post',
          outcome,
        });
      }

      const entries = auditLog.query({ seedId: 'agent-all' });
      expect(entries).toHaveLength(5);

      const recordedOutcomes = entries.map((e) => e.outcome).sort();
      expect(recordedOutcomes).toEqual([...outcomes].sort());
    });
  });

  describe('emergency halt blocks all agents', () => {
    it('should block any agent from acting after emergencyHaltNetwork', () => {
      safety.emergencyHaltNetwork('Detected coordinated abuse pattern');

      const agents = ['agent-1', 'agent-2', 'agent-3', 'unknown-agent'];
      for (const agentId of agents) {
        const canAct = safety.canAct(agentId);
        expect(canAct.allowed).toBe(false);
        expect(canAct.reason).toContain('emergency halt');
      }

      const status = safety.getNetworkStatus();
      expect(status.emergencyHalt).toBe(true);
      expect(status.emergencyHaltReason).toBe('Detected coordinated abuse pattern');
    });
  });

  describe('full lifecycle', () => {
    it('should register agent, make calls, hit circuit breaker, wait cooldown, and recover', () => {
      vi.useFakeTimers();

      try {
        const agentId = 'agent-lifecycle';
        let agentPaused = false;

        const lifecycleBreaker = new CircuitBreaker({
          name: 'lifecycle-llm',
          failureThreshold: 3,
          failureWindowMs: 60_000,
          cooldownMs: 5_000,
          halfOpenSuccessThreshold: 1,
          onStateChange: (_from, to) => {
            if (to === 'open') {
              safety.pauseAgent(agentId, 'Circuit breaker open');
              agentPaused = true;
            }
          },
        });

        // Agent starts active
        expect(safety.canAct(agentId).allowed).toBe(true);

        // Successful calls
        lifecycleBreaker.recordSuccess();
        lifecycleBreaker.recordSuccess();

        auditLog.log({ seedId: agentId, action: 'llm_call', outcome: 'success' });
        auditLog.log({ seedId: agentId, action: 'llm_call', outcome: 'success' });

        // Now failures accumulate
        lifecycleBreaker.recordFailure();
        lifecycleBreaker.recordFailure();
        lifecycleBreaker.recordFailure(); // Trip threshold

        expect(lifecycleBreaker.getState()).toBe('open');
        expect(agentPaused).toBe(true);
        expect(safety.canAct(agentId).allowed).toBe(false);

        auditLog.log({ seedId: agentId, action: 'llm_call', outcome: 'circuit_open' });

        // Wait for cooldown
        vi.advanceTimersByTime(5_001);

        // Circuit should auto-transition to half-open
        expect(lifecycleBreaker.getState()).toBe('half-open');

        // Resume agent and try a successful probe
        safety.resumeAgent(agentId, 'Circuit half-open — probing');
        expect(safety.canAct(agentId).allowed).toBe(true);

        lifecycleBreaker.recordSuccess(); // Meets halfOpenSuccessThreshold of 1
        expect(lifecycleBreaker.getState()).toBe('closed');

        auditLog.log({ seedId: agentId, action: 'llm_call', outcome: 'success' });

        // Agent is fully recovered
        expect(safety.canAct(agentId).allowed).toBe(true);

        const stats = auditLog.getStats();
        // 2 successes + 1 circuit_open + 1 recovery success = 4
        expect(stats.total).toBe(4);
        expect(stats.byAgent[agentId]).toBe(4);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
