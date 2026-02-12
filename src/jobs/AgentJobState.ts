/**
 * @file AgentJobState.ts
 * @description Per-agent job decision state that evolves with experience.
 *
 * Each agent maintains their own preferences, workload tracking, and learning history.
 * This enables emergent specialization and dynamic decision-making.
 */

export interface JobOutcome {
  jobId: string;
  category: string;
  budgetLamports: number;
  success: boolean;
  completionTimeMs: number;
  timestamp: number;
}

/**
 * Per-agent job decision state - persisted across sessions.
 */
export interface AgentJobState {
  /** Agent identifier */
  seedId: string;

  /** Current active job count (0 = idle, higher = busier) */
  activeJobCount: number;

  /** Processing bandwidth (0-1, affected by system resources) */
  bandwidth: number;

  /** Minimum acceptable SOL/hour rate (evolves based on outcomes) */
  minAcceptableRatePerHour: number;

  /** Categories this agent prefers (learned from successful jobs) */
  preferredCategories: Map<string, number>; // category -> preference score 0-1

  /** Recent job outcomes for learning */
  recentOutcomes: JobOutcome[];

  /** Risk tolerance (0-1, adjusted by mood and recent failures) */
  riskTolerance: number;

  /** Job evaluation history count */
  totalJobsEvaluated: number;

  /** Jobs the agent has bid on */
  totalJobsBidOn: number;

  /** Jobs successfully completed */
  totalJobsCompleted: number;

  /** Average success rate (completed / bidOn) */
  successRate: number;
}

/**
 * Creates a new AgentJobState with sensible defaults based on agent level.
 */
export function createAgentJobState(
  seedId: string,
  level: number,
  reputation: number,
): AgentJobState {
  // Higher level/reputation agents start with higher expectations
  const baseRate = 0.02 + (level * 0.01) + (reputation / 100) * 0.05; // 0.02-0.2 SOL/hour

  return {
    seedId,
    activeJobCount: 0,
    bandwidth: 1.0, // Full bandwidth initially
    minAcceptableRatePerHour: baseRate,
    preferredCategories: new Map(),
    recentOutcomes: [],
    riskTolerance: 0.5, // Neutral risk tolerance
    totalJobsEvaluated: 0,
    totalJobsBidOn: 0,
    totalJobsCompleted: 0,
    successRate: 0,
  };
}

/**
 * Update agent state after evaluating a job.
 */
export function recordJobEvaluation(state: AgentJobState, didBid: boolean): void {
  state.totalJobsEvaluated++;
  if (didBid) {
    state.totalJobsBidOn++;
  }
}

/**
 * Update agent state after completing a job.
 */
export function recordJobOutcome(state: AgentJobState, outcome: JobOutcome): void {
  // Add to recent outcomes (keep last 20)
  state.recentOutcomes.push(outcome);
  if (state.recentOutcomes.length > 20) {
    state.recentOutcomes.shift();
  }

  // Update success rate
  if (outcome.success) {
    state.totalJobsCompleted++;
  }
  state.successRate = state.activeJobCount > 0
    ? state.totalJobsCompleted / state.totalJobsBidOn
    : 0;

  // Adjust minimum acceptable rate based on success
  if (outcome.success && state.successRate > 0.8) {
    // Successful agent → raise expectations
    state.minAcceptableRatePerHour *= 1.05;
  } else if (!outcome.success && state.successRate < 0.5) {
    // Struggling agent → lower expectations
    state.minAcceptableRatePerHour *= 0.95;
  }

  // Update category preferences
  const currentPref = state.preferredCategories.get(outcome.category) || 0.5;
  if (outcome.success) {
    state.preferredCategories.set(outcome.category, Math.min(1, currentPref + 0.1));
  } else {
    state.preferredCategories.set(outcome.category, Math.max(0, currentPref - 0.15));
  }

  // Adjust risk tolerance based on recent outcomes
  const recentSuccesses = state.recentOutcomes.filter(o => o.success).length;
  const recentSuccessRate = recentSuccesses / Math.max(1, state.recentOutcomes.length);
  if (recentSuccessRate > 0.7) {
    // Recent successes → more risk-tolerant
    state.riskTolerance = Math.min(1, state.riskTolerance + 0.05);
  } else if (recentSuccessRate < 0.3) {
    // Recent failures → more conservative
    state.riskTolerance = Math.max(0, state.riskTolerance - 0.1);
  }
}

/**
 * Update workload when agent starts a new job.
 */
export function incrementWorkload(state: AgentJobState): void {
  state.activeJobCount++;
  // Bandwidth decreases as workload increases
  state.bandwidth = Math.max(0.1, 1 - (state.activeJobCount * 0.15));
}

/**
 * Update workload when agent completes/abandons a job.
 */
export function decrementWorkload(state: AgentJobState): void {
  state.activeJobCount = Math.max(0, state.activeJobCount - 1);
  state.bandwidth = Math.max(0.1, 1 - (state.activeJobCount * 0.15));
}

/**
 * Calculate agent's current capacity for new work (0-1).
 * 0 = completely overloaded, 1 = fully available.
 */
export function calculateCapacity(state: AgentJobState): number {
  return state.bandwidth * (1 - (state.activeJobCount * 0.2));
}
