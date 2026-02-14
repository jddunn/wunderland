/**
 * @file JobScanner.ts
 * @description Polls for open jobs and evaluates which ones to bid on using agent-specific evaluators.
 *
 * Features:
 * - Per-agent JobEvaluator instances with mood awareness
 * - Configurable polling interval (influenced by agent traits + mood)
 * - Persistent AgentJobState for learning
 * - Integrates with JobEvaluator for decision-making
 */

import { JobEvaluator, type Job, type AgentProfile, type JobEvaluationResult } from './JobEvaluator.js';
import type { AgentJobState } from './AgentJobState.js';
import { recordJobEvaluation } from './AgentJobState.js';
import type { MoodEngine } from '../social/MoodEngine.js';
import type { JobMemoryService } from './JobMemoryService.js';

export interface JobScanConfig {
  /**
   * Base polling interval in milliseconds (default: 30000 = 30 seconds)
   */
  baseIntervalMs?: number;

  /**
   * Randomized delay before the first scan to avoid stampeding herds on startup.
   * Set to 0 to disable (useful for tests).
   *
   * Default: 30000ms (capped by the computed polling interval).
   */
  startupJitterMs?: number;

  /**
   * Enable adaptive polling based on mood + traits
   */
  enableAdaptivePolling?: boolean;

  /**
   * Maximum number of active bids per agent
   */
  maxActiveBids?: number;

  /**
   * API endpoint for fetching open jobs
   */
  jobsApiUrl: string;

  /**
   * Callback to submit a bid
   */
  onBidDecision?: (job: Job, evaluation: JobEvaluationResult) => Promise<void>;
}

export class JobScanner {
  private evaluator: JobEvaluator;
  private config: Required<JobScanConfig>;
  private timerId?: ReturnType<typeof setTimeout>;
  // Jobs this agent has ever bid on (prevents duplicate bidding).
  private bidJobIds: Set<string> = new Set();
  // Jobs where this agent currently has an active on-chain bid.
  private activeBidJobIds: Set<string> = new Set();
  private stopped = true;

  constructor(
    config: JobScanConfig,
    private moodEngine: MoodEngine,
    private seedId: string,
    jobMemory?: JobMemoryService,
  ) {
    this.evaluator = new JobEvaluator(moodEngine, seedId, jobMemory);
    this.config = {
      baseIntervalMs: config.baseIntervalMs || 30_000,
      startupJitterMs: config.startupJitterMs ?? 30_000,
      enableAdaptivePolling: config.enableAdaptivePolling ?? true,
      maxActiveBids: config.maxActiveBids || 5,
      jobsApiUrl: config.jobsApiUrl,
      onBidDecision: config.onBidDecision || (async () => {}),
    };
  }

  /**
   * Start scanning for jobs
   */
  start(agent: AgentProfile, state: AgentJobState): void {
    if (this.timerId) {
      console.warn('[JobScanner] Already running');
      return;
    }
    this.stopped = false;

    // Calculate initial polling interval based on agent personality + mood
    const pollingIntervalMs = this.jitteredIntervalMs(agent);

    console.log(`[JobScanner] Starting scan for agent ${agent.seedId} (interval: ${pollingIntervalMs}ms)`);

    // Initial scan (with a little chaos to avoid stampeding herds on startup)
    const startupJitterMs = Math.max(0, Math.floor(this.config.startupJitterMs));
    const initialDelayMs =
      startupJitterMs > 0 ? Math.floor(Math.random() * Math.min(startupJitterMs, pollingIntervalMs)) : 0;
    this.timerId = setTimeout(() => {
      void this.scanAndReschedule(agent, state);
    }, initialDelayMs);
  }

  /**
   * Stop scanning
   */
  stop(): void {
    this.stopped = true;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = undefined;
      console.log('[JobScanner] Stopped');
    }
  }

  /**
   * Perform a single scan cycle, then schedule the next one.
   */
  private async scanAndReschedule(agent: AgentProfile, state: AgentJobState): Promise<void> {
    try {
      await this.scanJobs(agent, state);
    } catch (err) {
      console.warn('[JobScanner] Scan cycle failed:', err);
    }

    if (this.stopped) {
      this.timerId = undefined;
      return;
    }

    // Recompute interval each tick so mood changes can influence cadence.
    const nextIntervalMs = this.jitteredIntervalMs(agent);
    this.timerId = setTimeout(() => {
      void this.scanAndReschedule(agent, state);
    }, nextIntervalMs);
  }

  /**
   * Seed active bids from an external source (e.g., on-chain indexer).
   *
   * This keeps JobScanner's internal capacity accounting correct after restarts.
   */
  setActiveBids(jobIds: string[]): void {
    const normalized = jobIds.map((id) => String(id || '').trim()).filter(Boolean);
    this.activeBidJobIds = new Set(normalized);
    for (const id of normalized) {
      this.bidJobIds.add(id);
    }
  }

  /**
   * Mark a bid as no longer active (withdrawn, accepted, completed, cancelled).
   *
   * This frees up `maxActiveBids` capacity without allowing duplicate bidding on the same job.
   */
  markBidInactive(jobId: string): void {
    const id = String(jobId || '').trim();
    if (!id) return;
    this.activeBidJobIds.delete(id);
  }

  /**
   * Perform a single scan cycle
   */
  private async scanJobs(agent: AgentProfile, state: AgentJobState): Promise<void> {
    try {
      // Fetch open jobs
      const jobs = await this.fetchOpenJobs();

      // Filter out jobs we've already bid on
      const unbidJobs = jobs.filter(job => !this.bidJobIds.has(job.id) && job.status === 'open');

      // Filter out crowded jobs (>10 bids = low win probability, skip to reduce spam)
      const viableJobs = unbidJobs.filter(job => job.bidsCount <= 10);
      const skippedCrowded = unbidJobs.length - viableJobs.length;
      if (skippedCrowded > 0) {
        console.log(`[JobScanner] Skipped ${skippedCrowded} jobs with >10 bids (crowded market)`);
      }

      if (viableJobs.length === 0) {
        console.log('[JobScanner] No viable jobs to evaluate');
        return;
      }

      console.log(`[JobScanner] Evaluating ${viableJobs.length} new jobs`);

      // Evaluate each job
      for (const job of viableJobs) {
        // Check if we've hit max active bids
        if (this.activeBidJobIds.size >= this.config.maxActiveBids) {
          console.log(`[JobScanner] Max active bids reached (${this.config.maxActiveBids})`);
          break;
        }

        // Use agent-centric evaluator with current state (with RAG)
        const evaluation = await this.evaluator.evaluateJob(job, agent, state);

        // Record that we evaluated this job
        recordJobEvaluation(state, evaluation.shouldBid);

        if (evaluation.shouldBid) {
          console.log(`[JobScanner] ✓ Bidding on job ${job.id}: ${evaluation.reasoning}`);
          console.log(`  Score: ${evaluation.jobScore.toFixed(2)}, Bid: ${(evaluation.recommendedBidAmount || 0) / 1e9} SOL${evaluation.useBuyItNow ? ' (BUY IT NOW)' : ''}`);

          // Mark as active
          this.bidJobIds.add(job.id);
          this.activeBidJobIds.add(job.id);

          // Submit bid via callback
          await this.config.onBidDecision(job, evaluation);
        } else {
          console.log(`[JobScanner] ✗ Skipping job ${job.id}: ${evaluation.reasoning}`);
        }
      }
    } catch (err) {
      console.error('[JobScanner] Scan failed:', err);
    }
  }

  /**
   * Fetch open jobs from API
   */
  private async fetchOpenJobs(): Promise<Job[]> {
    const response = await fetch(`${this.config.jobsApiUrl}?status=open&limit=50`);
    if (!response.ok) {
      throw new Error(`Failed to fetch jobs: ${response.status}`);
    }

    const data = (await response.json()) as { jobs: Job[] };
    return data.jobs || [];
  }

  /**
   * Calculate polling interval based on agent traits + mood.
   */
  private calculatePollingInterval(agent: AgentProfile): number {
    if (!this.config.enableAdaptivePolling) {
      return this.config.baseIntervalMs;
    }

    const mood = this.moodEngine.getState(this.seedId);
    let multiplier = 1.0;

    // High Extraversion → more aggressive polling
    if (agent.hexaco.extraversion > 0.7) {
      multiplier *= 0.5; // 15 seconds
    } else if (agent.hexaco.extraversion > 0.5) {
      multiplier *= 0.75; // 22.5 seconds
    }

    // Mood affects polling
    if (mood) {
      // High arousal → faster polling
      if (mood.arousal > 0.3) {
        multiplier *= 0.8;
      }
      // Low arousal → slower polling
      if (mood.arousal < -0.2) {
        multiplier *= 1.5;
      }

      // High valence (positive mood) → more active
      if (mood.valence > 0.3) {
        multiplier *= 0.9;
      }
    }

    return Math.floor(this.config.baseIntervalMs * multiplier);
  }

  private jitteredIntervalMs(agent: AgentProfile): number {
    const base = this.calculatePollingInterval(agent);
    const openness = agent.hexaco.openness ?? 0.5;

    // Higher openness → more exploratory cadence (more randomness).
    const jitterPct = 0.05 + 0.25 * Math.min(1, Math.max(0, openness));
    const jitter = (Math.random() * 2 - 1) * base * jitterPct;

    // Keep scans from getting too aggressive even for highly extraverted agents.
    return Math.max(7_500, Math.floor(base + jitter));
  }

  /**
   * Mark a job bid as completed/rejected (remove from active set)
   */
  markBidCompleted(jobId: string): void {
    this.markBidInactive(jobId);
    console.log(`[JobScanner] Bid for job ${jobId} marked inactive`);
  }

  /**
   * Get current status
   */
  getStatus(): { isRunning: boolean; activeBids: number; maxBids: number } {
    return {
      isRunning: !!this.timerId,
      activeBids: this.activeBidJobIds.size,
      maxBids: this.config.maxActiveBids,
    };
  }
}
