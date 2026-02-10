/**
 * @file JobEvaluator.selectivity.test.ts
 * @description Unit tests for agent selectivity improvements in JobEvaluator.
 *
 * Tests verify that agents are highly selective and don't spam bids:
 * - Baseline threshold raised from 0.5 to 0.65
 * - Busy agents (2-3+ jobs) have much higher thresholds
 * - Workload penalty increased from 0.2 to 0.3 per job
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JobEvaluator } from '../JobEvaluator.js';
import type { Job, AgentProfile, AgentJobState } from '../JobEvaluator.js';
import type { HEXACOTraits, PADState } from '../types.js';
import { MoodEngine } from '../../social/MoodEngine.js';

describe('JobEvaluator - Agent Selectivity', () => {
  let evaluator: JobEvaluator;
  let moodEngine: MoodEngine;
  let baseAgent: AgentProfile;
  let baseState: AgentJobState;
  let testJob: Job;

  beforeEach(() => {
    moodEngine = new MoodEngine();
    const seedId = 'test-agent-selectivity';

    // Initialize agent with neutral mood
    moodEngine.initializeAgent(seedId, {
      honesty_humility: 0.5,
      emotionality: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      conscientiousness: 0.5,
      openness: 0.5,
    });

    evaluator = new JobEvaluator(moodEngine, seedId);

    baseAgent = {
      seedId,
      level: 2,
      reputation: 60,
      hexaco: {
        honesty_humility: 0.5,
        emotionality: 0.5,
        extraversion: 0.5,
        agreeableness: 0.5,
        conscientiousness: 0.5,
        openness: 0.5,
      },
      completedJobs: 10,
      averageRating: 4.2,
    };

    baseState = {
      seedId,
      activeJobCount: 0,
      bandwidth: 1.0,
      minAcceptableRatePerHour: 0.02, // 0.02 SOL/hour
      preferredCategories: new Map([['development', 0.8]]),
      recentOutcomes: [],
      riskTolerance: 0.5,
      totalJobsEvaluated: 100,
      totalJobsBidOn: 20,
      totalJobsCompleted: 10,
      successRate: 0.75,
    };

    testJob = {
      id: 'test-job-1',
      title: 'Build a simple REST API',
      description: 'Create a REST API with Node.js and Express',
      budgetLamports: 500_000_000, // 0.5 SOL
      category: 'development',
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
      creatorWallet: 'Creator123',
      bidsCount: 0,
      status: 'open',
    };
  });

  describe('Baseline threshold (0.65)', () => {
    it('should reject jobs with scores below 0.65', async () => {
      // Modify job to have low budget (low score)
      testJob.budgetLamports = 100_000_000; // 0.1 SOL (low for development work)

      const result = await evaluator.evaluateJob(testJob, baseAgent, baseState);

      expect(result.jobScore).toBeLessThan(0.65);
      expect(result.shouldBid).toBe(false);
      expect(result.reasoning).toContain('score');
    });

    it('should accept jobs with scores above 0.65', async () => {
      // Good budget, good fit
      testJob.budgetLamports = 800_000_000; // 0.8 SOL

      const result = await evaluator.evaluateJob(testJob, baseAgent, baseState);

      expect(result.jobScore).toBeGreaterThan(0.65);
      expect(result.shouldBid).toBe(true);
    });
  });

  describe('Workload penalty (0.3 per job)', () => {
    it('should apply 0.3 penalty per active job', async () => {
      // Evaluate same job with 0, 1, 2 jobs
      const results = [];

      for (let jobCount = 0; jobCount <= 2; jobCount++) {
        const state = { ...baseState, activeJobCount: jobCount };
        const result = await evaluator.evaluateJob(testJob, baseAgent, state);
        results.push({ jobCount, penalty: result.workloadPenalty, score: result.jobScore });
      }

      // Verify penalty increases by ~0.3 per job
      expect(results[1].penalty).toBeCloseTo(0.3, 1);
      expect(results[2].penalty).toBeCloseTo(0.6, 1);

      // Score should decrease significantly
      expect(results[0].score).toBeGreaterThan(results[1].score);
      expect(results[1].score).toBeGreaterThan(results[2].score);
    });

    it('should make 3+ jobs nearly impossible to bid on', async () => {
      const state = { ...baseState, activeJobCount: 3 };
      testJob.budgetLamports = 1_000_000_000; // 1 SOL - very high budget

      const result = await evaluator.evaluateJob(testJob, baseAgent, state);

      // Even with high budget, workload penalty (~0.9) + threshold bump should prevent bid
      expect(result.workloadPenalty).toBeGreaterThanOrEqual(0.9);
      expect(result.shouldBid).toBe(false);
    });
  });

  describe('Busy agent threshold increase', () => {
    it('should increase threshold by 0.1 with 2 active jobs', async () => {
      const state = { ...baseState, activeJobCount: 2 };
      testJob.budgetLamports = 700_000_000; // 0.7 SOL

      const result = await evaluator.evaluateJob(testJob, baseAgent, state);

      // With 2 jobs: threshold becomes ~0.75 (0.65 base + 0.1)
      // Job needs higher score to pass
      expect(result.shouldBid).toBe(false);
    });

    it('should increase threshold by 0.15 with 3+ active jobs', async () => {
      const state = { ...baseState, activeJobCount: 3 };
      testJob.budgetLamports = 900_000_000; // 0.9 SOL

      const result = await evaluator.evaluateJob(testJob, baseAgent, state);

      // With 3 jobs: threshold becomes ~0.8 (0.65 base + 0.15)
      // Plus massive workload penalty (0.9)
      expect(result.shouldBid).toBe(false);
    });
  });

  describe('High-performing agents (success rate > 0.8)', () => {
    it('should be even more selective', async () => {
      const state = { ...baseState, successRate: 0.85 };
      testJob.budgetLamports = 600_000_000; // 0.6 SOL (moderate budget)

      const result = await evaluator.evaluateJob(testJob, baseAgent, state);

      // High success rate adds 0.15 to threshold → ~0.8 minimum
      expect(result.shouldBid).toBe(false);
    });
  });

  describe('Low-performing agents (success rate < 0.4)', () => {
    it('should bid more aggressively to recover', async () => {
      const state = { ...baseState, successRate: 0.3 };
      testJob.budgetLamports = 500_000_000; // 0.5 SOL

      const result = await evaluator.evaluateJob(testJob, baseAgent, state);

      // Low success rate reduces threshold to ~0.55 (0.65 - 0.1)
      // More likely to bid to recover reputation
      expect(result.shouldBid).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should never bid with 5+ active jobs (hard cap)', async () => {
      const state = { ...baseState, activeJobCount: 5 };
      testJob.budgetLamports = 2_000_000_000; // 2 SOL - extremely high

      const result = await evaluator.evaluateJob(testJob, baseAgent, state);

      // Hard cap at 5 jobs regardless of score
      expect(result.shouldBid).toBe(false);
    });

    it('should handle 0 active jobs correctly (no penalty)', async () => {
      const state = { ...baseState, activeJobCount: 0 };
      testJob.budgetLamports = 700_000_000; // 0.7 SOL

      const result = await evaluator.evaluateJob(testJob, baseAgent, state);

      expect(result.workloadPenalty).toBe(0);
      // With no penalty, should be more likely to bid
      expect(result.shouldBid).toBe(true);
    });
  });

  describe('Combined effects', () => {
    it('should compound penalties (busy + low success + negative mood)', async () => {
      // Worst case: busy, struggling, bad mood
      const state = {
        ...baseState,
        activeJobCount: 2,
        successRate: 0.35,
      };

      // Set negative mood
      moodEngine.updateMood(baseAgent.seedId, { valence: -0.5, arousal: -0.3, dominance: -0.2 });

      testJob.budgetLamports = 600_000_000; // 0.6 SOL

      const result = await evaluator.evaluateJob(testJob, baseAgent, state);

      // Multiple penalties should make bidding very unlikely
      expect(result.shouldBid).toBe(false);
    });

    it('should allow bids for perfect matches even when busy (1 job)', async () => {
      const state = { ...baseState, activeJobCount: 1, successRate: 0.9 };
      testJob.budgetLamports = 1_500_000_000; // 1.5 SOL - very high budget
      testJob.category = 'development'; // Matches preferred category

      // Set positive mood
      moodEngine.updateMood(baseAgent.seedId, { valence: 0.5, arousal: 0.3, dominance: 0.2 });

      const result = await evaluator.evaluateJob(testJob, baseAgent, state);

      // Perfect match should overcome moderate workload
      expect(result.jobScore).toBeGreaterThan(0.68);
      expect(result.shouldBid).toBe(true);
    });
  });
});
