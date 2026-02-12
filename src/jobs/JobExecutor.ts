/**
 * @file JobExecutor.ts
 * @description Autonomously executes jobs that have been assigned to an agent (after winning a bid).
 *
 * Features:
 * - Polls for assigned jobs via callback
 * - Builds execution prompt from job details
 * - Mock execution (returns synthetic deliverables — GMI integration pending)
 * - Quality check before submission
 * - Retry logic (configurable max retries with exponential backoff)
 * - start/stop lifecycle matching JobScanner pattern
 *
 * External dependencies (fetching jobs, persisting state) are injected via callbacks
 * so the backend or CLI can wire them up as needed.
 */

import type { Deliverable } from './QualityChecker.js';
import { QualityChecker, type QualityCheckResult, type QualityCheckerConfig } from './QualityChecker.js';
import { DeliverableManager, type DeliverableManagerConfig } from './DeliverableManager.js';

export interface AssignedJob {
  id: string;
  title: string;
  description: string;
  category: string;
  budgetLamports: number;
  deadline: string | null;
  confidentialDetails?: string | null;
}

export interface ExecutionResult {
  success: boolean;
  deliverableId?: string;
  qualityScore?: number;
  error?: string;
}

/**
 * Callback to fetch assigned jobs for an agent.
 */
export type FetchAssignedJobsCallback = (
  agentId: string,
  limit: number,
) => Promise<AssignedJob[]>;

/**
 * Callback invoked when execution starts on a job (e.g. to mark DB timestamp).
 */
export type OnExecutionStartCallback = (
  agentId: string,
  jobId: string,
) => Promise<void>;

/**
 * Callback invoked when execution completes (success or failure).
 */
export type OnExecutionCompleteCallback = (
  agentId: string,
  jobId: string,
  result: ExecutionResult,
) => Promise<void>;

/**
 * Callback to execute the actual job (GMI agent, LLM call, etc.).
 * If not provided, mock execution is used.
 */
export type ExecuteJobCallback = (
  agentId: string,
  job: AssignedJob,
  prompt: string,
) => Promise<Deliverable>;

export interface JobExecutorConfig {
  /**
   * Polling interval in ms (default: 30000)
   */
  pollIntervalMs?: number;

  /**
   * Maximum concurrent job executions per agent (default: 1)
   */
  maxConcurrent?: number;

  /**
   * Maximum retry attempts per job (default: 3)
   */
  maxRetries?: number;

  /**
   * Base retry delay in ms (default: 5000). Doubles on each retry.
   */
  baseRetryDelayMs?: number;

  /**
   * Callback to fetch assigned jobs
   */
  fetchAssignedJobs: FetchAssignedJobsCallback;

  /**
   * Callback invoked when execution starts
   */
  onExecutionStart?: OnExecutionStartCallback;

  /**
   * Callback invoked when execution completes
   */
  onExecutionComplete?: OnExecutionCompleteCallback;

  /**
   * Custom execution callback (replaces mock execution)
   */
  executeJob?: ExecuteJobCallback;

  /**
   * QualityChecker configuration
   */
  qualityCheckerConfig?: QualityCheckerConfig;

  /**
   * DeliverableManager configuration
   */
  deliverableManagerConfig?: DeliverableManagerConfig;
}

/**
 * Executes assigned jobs with quality checks and retry logic.
 */
export class JobExecutor {
  private readonly config: Required<
    Pick<JobExecutorConfig, 'pollIntervalMs' | 'maxConcurrent' | 'maxRetries' | 'baseRetryDelayMs'>
  > & JobExecutorConfig;
  private readonly qualityChecker: QualityChecker;
  private readonly deliverableManager: DeliverableManager;
  private readonly activeExecutions = new Set<string>();
  private readonly retryCounts = new Map<string, number>();
  private intervalId?: ReturnType<typeof setInterval>;
  private agentId?: string;

  constructor(config: JobExecutorConfig) {
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 30_000,
      maxConcurrent: config.maxConcurrent ?? 1,
      maxRetries: config.maxRetries ?? 3,
      baseRetryDelayMs: config.baseRetryDelayMs ?? 5_000,
      ...config,
    };
    this.qualityChecker = new QualityChecker(config.qualityCheckerConfig);
    this.deliverableManager = new DeliverableManager(config.deliverableManagerConfig);
  }

  /**
   * Start execution loop for an agent.
   */
  start(agentId: string): void {
    if (this.intervalId) {
      console.warn(`[JobExecutor] Already running for agent ${this.agentId}`);
      return;
    }

    this.agentId = agentId;
    console.log(
      `[JobExecutor] Starting execution loop for agent ${agentId} (interval: ${this.config.pollIntervalMs}ms, max: ${this.config.maxConcurrent})`,
    );

    // Initial poll
    void this.pollAndExecute();

    // Set up periodic polling
    this.intervalId = setInterval(() => {
      void this.pollAndExecute();
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop execution loop.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      console.log(`[JobExecutor] Stopped for agent ${this.agentId}`);
    }
  }

  /**
   * Get current execution status.
   */
  getStatus(): {
    isRunning: boolean;
    activeExecutions: number;
    maxConcurrent: number;
    agentId?: string;
  } {
    return {
      isRunning: !!this.intervalId,
      activeExecutions: this.activeExecutions.size,
      maxConcurrent: this.config.maxConcurrent,
      agentId: this.agentId,
    };
  }

  /**
   * Execute a single job directly (bypasses polling).
   */
  async executeJob(agentId: string, job: AssignedJob): Promise<ExecutionResult> {
    return this.runExecution(agentId, job);
  }

  /**
   * Poll for assigned jobs and execute them.
   */
  private async pollAndExecute(): Promise<void> {
    if (!this.agentId) return;

    if (this.activeExecutions.size >= this.config.maxConcurrent) {
      console.log(
        `[JobExecutor] Agent ${this.agentId} at max concurrent (${this.activeExecutions.size}/${this.config.maxConcurrent})`,
      );
      return;
    }

    try {
      const slotsAvailable = this.config.maxConcurrent - this.activeExecutions.size;
      const jobs = await this.config.fetchAssignedJobs(this.agentId, slotsAvailable);

      if (jobs.length === 0) return;

      console.log(
        `[JobExecutor] Agent ${this.agentId} found ${jobs.length} assigned job(s) to execute`,
      );

      for (const job of jobs) {
        if (this.activeExecutions.size >= this.config.maxConcurrent) break;
        if (this.activeExecutions.has(job.id)) continue;

        this.activeExecutions.add(job.id);
        void this.runExecution(this.agentId, job).finally(() => {
          this.activeExecutions.delete(job.id);
        });
      }
    } catch (err) {
      console.error(`[JobExecutor] Poll failed for agent ${this.agentId}:`, err);
    }
  }

  /**
   * Run a single job execution with quality checks and retries.
   */
  private async runExecution(
    agentId: string,
    job: AssignedJob,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    console.log(
      `[JobExecutor] Agent ${agentId} starting job ${job.id} — category: ${job.category}, budget: ${job.budgetLamports / 1e9} SOL`,
    );

    try {
      // Notify execution start
      if (this.config.onExecutionStart) {
        await this.config.onExecutionStart(agentId, job.id);
      }

      // Build prompt
      const prompt = this.buildJobPrompt(job);

      // Execute (custom callback or mock)
      let deliverable: Deliverable;
      if (this.config.executeJob) {
        deliverable = await this.config.executeJob(agentId, job, prompt);
      } else {
        deliverable = await this.mockExecuteJob(job);
      }

      // Quality check
      const qualityResult = await this.qualityChecker.checkDeliverable(deliverable, {
        id: job.id,
        title: job.title,
        description: job.description,
        category: job.category,
      });

      if (!qualityResult.passed) {
        return this.handleQualityFailure(agentId, job, qualityResult);
      }

      // Store deliverable
      const deliverableId = await this.deliverableManager.storeDeliverable(
        job.id,
        agentId,
        deliverable,
      );

      // Submit
      const submissionResult = await this.deliverableManager.submitJob(
        agentId,
        job.id,
        deliverableId,
      );

      if (!submissionResult.success) {
        const result: ExecutionResult = {
          success: false,
          error: submissionResult.error,
        };
        await this.notifyComplete(agentId, job.id, result);
        return result;
      }

      const executionTime = Date.now() - startTime;
      console.log(
        `[JobExecutor] Job ${job.id} completed in ${executionTime}ms — quality: ${qualityResult.score.toFixed(2)}, signature: ${submissionResult.signature ?? 'n/a'}`,
      );

      const result: ExecutionResult = {
        success: true,
        deliverableId,
        qualityScore: qualityResult.score,
      };
      await this.notifyComplete(agentId, job.id, result);
      this.retryCounts.delete(job.id);
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[JobExecutor] Error executing job ${job.id}:`, err);

      const result: ExecutionResult = { success: false, error: errorMsg };
      await this.notifyComplete(agentId, job.id, result);
      return result;
    }
  }

  /**
   * Handle quality check failure with retry logic.
   */
  private async handleQualityFailure(
    agentId: string,
    job: AssignedJob,
    qualityResult: QualityCheckResult,
  ): Promise<ExecutionResult> {
    const retryCount = (this.retryCounts.get(job.id) ?? 0) + 1;
    this.retryCounts.set(job.id, retryCount);

    console.warn(
      `[JobExecutor] Quality check failed for job ${job.id}: score=${qualityResult.score.toFixed(2)}, issues=${qualityResult.issues.join(', ')} (attempt ${retryCount}/${this.config.maxRetries})`,
    );

    if (retryCount >= this.config.maxRetries) {
      const result: ExecutionResult = {
        success: false,
        qualityScore: qualityResult.score,
        error: `Quality check failed after ${this.config.maxRetries} retries: ${qualityResult.issues.join(', ')}`,
      };
      this.retryCounts.delete(job.id);
      await this.notifyComplete(agentId, job.id, result);
      return result;
    }

    // Exponential backoff retry
    const delay = this.config.baseRetryDelayMs * Math.pow(2, retryCount - 1);
    console.log(`[JobExecutor] Retrying job ${job.id} in ${delay}ms...`);
    await this.sleep(delay);

    return this.runExecution(agentId, job);
  }

  /**
   * Build execution prompt from job details.
   */
  private buildJobPrompt(job: AssignedJob): string {
    let prompt = `You have been assigned job: "${job.title}"

Description: ${job.description}
Budget: ${job.budgetLamports / 1e9} SOL
Category: ${job.category}`;

    if (job.deadline) {
      prompt += `\nDeadline: ${job.deadline}`;
    }

    if (job.confidentialDetails) {
      prompt += '\n\nConfidential Details:';
      try {
        const parsed = JSON.parse(job.confidentialDetails) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          prompt += '\n' + String(parsed ?? job.confidentialDetails);
        } else {
          const confidential = parsed as Record<string, unknown>;
          if (confidential.apiKeys) {
            prompt +=
              '\nAPI Keys: ' +
              Object.keys(confidential.apiKeys as Record<string, unknown>).join(', ');
          }
          if (confidential.credentials) {
            prompt +=
              '\nCredentials: ' +
              Object.keys(confidential.credentials as Record<string, unknown>).join(', ');
          }
          if (confidential.instructions) {
            prompt += '\n' + String(confidential.instructions);
          }
        }
      } catch {
        // If the UI stored raw text, include it directly so the assigned agent can act on it.
        prompt += '\n' + job.confidentialDetails;
      }
    }

    prompt += `\n\nYour task: Complete this job and produce deliverables.
Output format: Wrap deliverables in <DELIVERABLE type="code|report|data">...</DELIVERABLE> tags.`;

    return prompt;
  }

  /**
   * Mock job execution (returns synthetic deliverables for testing).
   */
  private async mockExecuteJob(job: AssignedJob): Promise<Deliverable> {
    console.warn('[JobExecutor] [MOCK] Executing job with mock agent (GMI integration pending)');

    // Simulate execution delay
    await this.sleep(500);

    let content: string;
    let type: Deliverable['type'];

    if (job.category === 'development') {
      type = 'code';
      content = `// Mock code deliverable for job: ${job.title}
function mockImplementation() {
  console.log("This is a mock implementation");
  // TODO: Replace with actual GMI-generated code
  return { success: true, data: "mock result" };
}

export default mockImplementation;`;
    } else if (job.category === 'research') {
      type = 'report';
      content = `# Mock Research Report: ${job.title}

## Summary
This is a mock research report generated for testing purposes.

## Findings
- Mock finding 1: The job description requested research on: ${job.description.substring(0, 100)}
- Mock finding 2: This would contain actual research results from the GMI agent
- Mock finding 3: Tool usage, web searches, and data analysis would appear here

## Conclusion
This mock deliverable demonstrates the job execution flow. In production, the GMI agent would generate actual research findings.`;
    } else {
      type = 'report';
      content = `# Job Deliverable: ${job.title}

## Description
This deliverable addresses the following job requirements:
${job.description}

## Output
Mock deliverable content generated for category: ${job.category}

This would contain the actual work product from the GMI agent using available tools (web search, code interpreter, CLI, etc.).

---
Generated by mock execution service (GMI integration pending)`;
    }

    return { type, content };
  }

  /**
   * Notify completion callback.
   */
  private async notifyComplete(
    agentId: string,
    jobId: string,
    result: ExecutionResult,
  ): Promise<void> {
    if (this.config.onExecutionComplete) {
      try {
        await this.config.onExecutionComplete(agentId, jobId, result);
      } catch (err) {
        console.error('[JobExecutor] onExecutionComplete callback failed:', err);
      }
    }
  }

  /**
   * Sleep helper.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
