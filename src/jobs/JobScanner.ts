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

export interface JobScanConfig {
  /**
   * Base polling interval in milliseconds (default: 30000 = 30 seconds)
   */
  baseIntervalMs?: number;

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
  private intervalId?: ReturnType<typeof setInterval>;
  private activeBids: Set<string> = new Set();

  constructor(
    config: JobScanConfig,
    private moodEngine: MoodEngine,
    private seedId: string,
  ) {
    this.evaluator = new JobEvaluator(moodEngine, seedId);
    this.config = {
      baseIntervalMs: config.baseIntervalMs || 30_000,
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
    if (this.intervalId) {
      console.warn('[JobScanner] Already running');
      return;
    }

    // Calculate polling interval based on agent personality + mood
    const pollingIntervalMs = this.calculatePollingInterval(agent);

    console.log(`[JobScanner] Starting scan for agent ${agent.seedId} (interval: ${pollingIntervalMs}ms)`);

    // Initial scan
    void this.scanJobs(agent, state);

    // Set up periodic scanning
    this.intervalId = setInterval(() => {
      void this.scanJobs(agent, state);
    }, pollingIntervalMs);
  }

  /**
   * Stop scanning
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      console.log('[JobScanner] Stopped');
    }
  }

  /**
   * Perform a single scan cycle
   */
  private async scanJobs(agent: AgentProfile, state: AgentJobState): Promise<void> {
    try {
      // Fetch open jobs
      const jobs = await this.fetchOpenJobs();

      // Filter out jobs we've already bid on
      const unbidJobs = jobs.filter(job => !this.activeBids.has(job.id) && job.status === 'open');

      if (unbidJobs.length === 0) {
        console.log('[JobScanner] No new jobs to evaluate');
        return;
      }

      console.log(`[JobScanner] Evaluating ${unbidJobs.length} new jobs`);

      // Evaluate each job
      for (const job of unbidJobs) {
        // Check if we've hit max active bids
        if (this.activeBids.size >= this.config.maxActiveBids) {
          console.log(`[JobScanner] Max active bids reached (${this.config.maxActiveBids})`);
          break;
        }

        // Use agent-centric evaluator with current state
        const evaluation = this.evaluator.evaluateJob(job, agent, state);

        // Record that we evaluated this job
        recordJobEvaluation(state, evaluation.shouldBid);

        if (evaluation.shouldBid) {
          console.log(`[JobScanner] ✓ Bidding on job ${job.id}: ${evaluation.reasoning}`);
          console.log(`  Score: ${evaluation.jobScore.toFixed(2)}, Bid: ${(evaluation.recommendedBidAmount || 0) / 1e9} SOL${evaluation.useBuyItNow ? ' (BUY IT NOW)' : ''}`);

          // Mark as active
          this.activeBids.add(job.id);

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

  /**
   * Mark a job bid as completed/rejected (remove from active set)
   */
  markBidCompleted(jobId: string): void {
    this.activeBids.delete(jobId);
    console.log(`[JobScanner] Bid for job ${jobId} marked complete`);
  }

  /**
   * Get current status
   */
  getStatus(): { isRunning: boolean; activeBids: number; maxBids: number } {
    return {
      isRunning: !!this.intervalId,
      activeBids: this.activeBids.size,
      maxBids: this.config.maxActiveBids,
    };
  }
}
