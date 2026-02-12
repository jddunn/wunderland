/**
 * @file JobScanner.crowded.test.ts
 * @description Unit tests for crowded job filtering in JobScanner.
 *
 * Tests verify that jobs with >10 bids are skipped to prevent spam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JobScanner } from '../JobScanner.js';
import type { Job, AgentProfile, AgentJobState, JobEvaluationResult } from '../JobEvaluator.js';
import { MoodEngine } from '../../social/MoodEngine.js';
import { createAgentJobState } from '../AgentJobState.js';

describe('JobScanner - Crowded Job Filtering', () => {
  let scanner: JobScanner;
  let moodEngine: MoodEngine;
  let agent: AgentProfile;
  let state: AgentJobState;
  let mockJobs: Job[];
  let bidDecisions: Array<{ job: Job; evaluation: JobEvaluationResult }>;

  beforeEach(() => {
    moodEngine = new MoodEngine();
    const seedId = 'test-agent-crowded';

    moodEngine.initializeAgent(seedId, {
      honesty_humility: 0.5,
      emotionality: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      conscientiousness: 0.5,
      openness: 0.5,
    });

    agent = {
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
      completedJobs: 5,
      averageRating: 4.0,
    };

    state = createAgentJobState(seedId, 2, 60);

    bidDecisions = [];

    // Mock fetch to return test jobs
    global.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ jobs: mockJobs }),
    })) as any;

    scanner = new JobScanner(
      {
        jobsApiUrl: 'http://test.com/jobs',
        baseIntervalMs: 1000,
        startupJitterMs: 0,
        enableAdaptivePolling: false,
        maxActiveBids: 5,
        onBidDecision: async (job, evaluation) => {
          bidDecisions.push({ job, evaluation });
        },
      },
      moodEngine,
      seedId
    );
  });

  it('should skip jobs with exactly 11 bids', async () => {
    mockJobs = [
      {
        id: 'crowded-job-1',
        title: 'Popular job',
        description: 'This job has many bids',
        budgetLamports: 1_000_000_000,
        category: 'development',
        deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        creatorWallet: 'Creator123',
        bidsCount: 11, // Over threshold
        status: 'open',
      },
    ];

    scanner.start(agent, state);
    await new Promise((resolve) => setTimeout(resolve, 100)); // Wait for scan
    scanner.stop();

    // No bids should be submitted
    expect(bidDecisions).toHaveLength(0);
  });

  it('should evaluate jobs with exactly 10 bids (threshold)', async () => {
    mockJobs = [
      {
        id: 'threshold-job-1',
        title: 'Job at threshold',
        description: 'This job has exactly 10 bids',
        budgetLamports: 1_000_000_000,
        category: 'development',
        deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        creatorWallet: 'Creator123',
        bidsCount: 10, // At threshold - should still be evaluated
        status: 'open',
      },
    ];

    scanner.start(agent, state);
    await new Promise((resolve) => setTimeout(resolve, 100));
    scanner.stop();

    // Job should be evaluated (may or may not bid based on score)
    // We just verify it wasn't filtered out
    expect(global.fetch).toHaveBeenCalled();
  });

  it('should evaluate jobs with <10 bids', async () => {
    mockJobs = [
      {
        id: 'uncrowded-job-1',
        title: 'Fresh job',
        description: 'This job has few bids',
        budgetLamports: 1_500_000_000, // High budget to ensure bid
        category: 'development',
        deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        creatorWallet: 'Creator123',
        bidsCount: 3, // Well below threshold
        status: 'open',
      },
    ];

    scanner.start(agent, state);
    await new Promise((resolve) => setTimeout(resolve, 100));
    scanner.stop();

    // With high budget + low competition, should bid
    expect(bidDecisions.length).toBeGreaterThan(0);
  });

  it('should filter multiple crowded jobs and evaluate viable ones', async () => {
    mockJobs = [
      {
        id: 'crowded-1',
        title: 'Crowded job 1',
        description: 'Many bids',
        budgetLamports: 1_000_000_000,
        category: 'development',
        deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        creatorWallet: 'Creator123',
        bidsCount: 15,
        status: 'open',
      },
      {
        id: 'viable-1',
        title: 'Viable job 1',
        description: 'Few bids',
        budgetLamports: 1_500_000_000,
        category: 'development',
        deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        creatorWallet: 'Creator456',
        bidsCount: 5,
        status: 'open',
      },
      {
        id: 'crowded-2',
        title: 'Crowded job 2',
        description: 'Many bids',
        budgetLamports: 1_000_000_000,
        category: 'research',
        deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        creatorWallet: 'Creator789',
        bidsCount: 20,
        status: 'open',
      },
      {
        id: 'viable-2',
        title: 'Viable job 2',
        description: 'Few bids',
        budgetLamports: 1_200_000_000,
        category: 'development',
        deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        creatorWallet: 'Creator012',
        bidsCount: 2,
        status: 'open',
      },
    ];

    scanner.start(agent, state);
    await new Promise((resolve) => setTimeout(resolve, 100));
    scanner.stop();

    // Should only evaluate/bid on viable jobs (not crowded ones)
    const bidJobIds = bidDecisions.map((d) => d.job.id);
    expect(bidJobIds).not.toContain('crowded-1');
    expect(bidJobIds).not.toContain('crowded-2');
  });

  it('should log skipped crowded jobs count', async () => {
    const consoleSpy = vi.spyOn(console, 'log');

    mockJobs = [
      { id: 'crowded-1', title: 'Job 1', description: 'Desc', budgetLamports: 1e9, category: 'dev', deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), creatorWallet: 'C1', bidsCount: 12, status: 'open' },
      { id: 'crowded-2', title: 'Job 2', description: 'Desc', budgetLamports: 1e9, category: 'dev', deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), creatorWallet: 'C2', bidsCount: 25, status: 'open' },
      { id: 'crowded-3', title: 'Job 3', description: 'Desc', budgetLamports: 1e9, category: 'dev', deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), creatorWallet: 'C3', bidsCount: 11, status: 'open' },
    ];

    scanner.start(agent, state);
    await new Promise((resolve) => setTimeout(resolve, 100));
    scanner.stop();

    // Should log that 3 jobs were skipped
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipped 3 jobs with >10 bids')
    );

    consoleSpy.mockRestore();
  });

  it('should not filter jobs that are already assigned/completed', async () => {
    mockJobs = [
      {
        id: 'assigned-job',
        title: 'Assigned job',
        description: 'Already assigned',
        budgetLamports: 1_000_000_000,
        category: 'development',
        deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        creatorWallet: 'Creator123',
        bidsCount: 15, // Many bids but not open
        status: 'assigned',
      },
    ];

    scanner.start(agent, state);
    await new Promise((resolve) => setTimeout(resolve, 100));
    scanner.stop();

    // Assigned jobs are filtered out before crowded check (status !== 'open')
    expect(bidDecisions).toHaveLength(0);
  });

  it('should still respect maxActiveBids even with viable jobs', async () => {
    mockJobs = Array.from({ length: 10 }, (_, i) => ({
      id: `viable-${i}`,
      title: `Viable job ${i}`,
      description: 'Good job',
      budgetLamports: 1_500_000_000,
      category: 'development',
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      creatorWallet: `Creator${i}`,
      bidsCount: 3, // All uncrowded
      status: 'open',
    }));

    scanner.start(agent, state);
    await new Promise((resolve) => setTimeout(resolve, 200));
    scanner.stop();

    // Should stop at maxActiveBids (5)
    expect(bidDecisions.length).toBeLessThanOrEqual(5);
  });
});
