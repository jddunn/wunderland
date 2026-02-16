/**
 * @file JobEvaluator.ts
 * @description Agent-centric job evaluation engine using HEXACO traits, PAD mood model,
 * and per-agent learning state.
 *
 * Each agent has their own JobEvaluator instance with access to:
 * - MoodEngine for current PAD state (Pleasure-Arousal-Dominance)
 * - AgentJobState for workload, preferences, and learning history
 * - HEXACO personality traits
 *
 * Decision-making is emergent and dynamic - no hardcoded thresholds.
 */

import type { MoodEngine, PADState } from '../social/MoodEngine.js';
import type { HEXACOTraits } from '../core/types.js';
import type { AgentJobState } from './AgentJobState.js';
import type { JobMemoryService } from './JobMemoryService.js';

export interface Job {
  id: string;
  title: string;
  description: string;
  budgetLamports: number;
  buyItNowLamports?: number;
  category: string;
  deadline: string;
  creatorWallet: string;
  bidsCount: number;
  status: 'open' | 'assigned' | 'submitted' | 'completed' | 'cancelled';
}

export interface AgentProfile {
  seedId: string;
  level: number;
  reputation: number; // 0-100
  hexaco: HEXACOTraits;
  completedJobs: number;
  averageRating: number;
}

export interface JobEvaluationResult {
  jobScore: number; // 0-1
  shouldBid: boolean;
  complexityFit: number;
  budgetAttractiveness: number;
  moodAlignment: number;
  workloadPenalty: number;
  urgencyBonus: number;
  recommendedBidAmount?: number;
  useBuyItNow?: boolean;
  reasoning: string;
}

/**
 * Category complexity estimates (effort hours range).
 */
const CATEGORY_EFFORT_ESTIMATES: Record<string, { min: number; max: number }> = {
  development: { min: 8, max: 40 },
  'github-bounty': { min: 8, max: 40 },
  research: { min: 4, max: 20 },
  data: { min: 3, max: 15 },
  design: { min: 2, max: 12 },
  content: { min: 1, max: 8 },
  other: { min: 2, max: 10 },
};

/**
 * HEXACO personality → category affinity map.
 *
 * Each category has a formula based on HEXACO traits that produces a 0-1 affinity score.
 * This replaces the flat 0.5 default for agents with no history in a given category,
 * creating natural specialization driven by personality.
 *
 * - High conscientiousness → development, data
 * - High openness → research, design, creative work
 * - High extraversion → content, outreach
 * - High agreeableness → content, collaborative tasks
 * - High honesty-humility → research (intellectual integrity)
 * - High emotionality → avoids high-pressure categories
 */
function calculatePersonalityCategoryAffinity(
  hexaco: HEXACOTraits,
  category: string,
): number {
  switch (category) {
    case 'development':
    case 'github-bounty':
      // Builders: conscientiousness + openness, penalize high emotionality (stress sensitivity)
      return 0.2 * hexaco.conscientiousness + 0.15 * hexaco.openness - 0.1 * hexaco.emotionality + 0.1;

    case 'research':
      // Thinkers: openness + honesty-humility (intellectual integrity), conscientiousness helps
      return 0.25 * hexaco.openness + 0.15 * hexaco.honesty_humility + 0.1 * hexaco.conscientiousness;

    case 'data':
      // Detail-oriented: conscientiousness dominant, some openness for pattern recognition
      return 0.25 * hexaco.conscientiousness + 0.1 * hexaco.openness + 0.05;

    case 'design':
      // Creative: openness dominant, extraversion for user empathy
      return 0.25 * hexaco.openness + 0.1 * hexaco.extraversion + 0.05;

    case 'content':
      // Communicators: extraversion + agreeableness (audience empathy)
      return 0.2 * hexaco.extraversion + 0.15 * hexaco.agreeableness + 0.05;

    default:
      // Generic: balanced across traits, slightly below midpoint
      return 0.1 * hexaco.conscientiousness + 0.1 * hexaco.openness + 0.05 * hexaco.agreeableness + 0.05;
  }
}

/**
 * Agent-centric job evaluator with mood and state awareness.
 */
export class JobEvaluator {
  constructor(
    private moodEngine: MoodEngine,
    private seedId: string,
    private jobMemory?: JobMemoryService, // Optional RAG integration
  ) {}

  /**
   * Evaluate whether this agent should bid on a job.
   *
   * Considers:
   * - Current mood (PAD state)
   * - Workload/bandwidth
   * - Learned category preferences
   * - Dynamic rate expectations
   * - RAG similarity to past jobs (if enabled)
   */
  async evaluateJob(
    job: Job,
    agent: AgentProfile,
    state: AgentJobState,
  ): Promise<JobEvaluationResult> {
    // Get current mood
    const mood = this.moodEngine.getState(this.seedId);
    const traits = this.moodEngine.getTraits(this.seedId) || agent.hexaco;

    // Calculate components
    const complexityFit = this.calculateComplexityFit(job, agent, state);
    const budgetAttractiveness = this.calculateBudgetAttractiveness(job, state);
    const moodAlignment = this.calculateMoodAlignment(job, mood, traits);
    const workloadPenalty = this.calculateWorkloadPenalty(state);
    const urgencyBonus = this.calculateUrgencyBonus(job, mood);

    // RAG similarity bonus (if enabled)
    const ragBonus = await this.calculateRagBonus(job, agent);

    // Competition penalty: jobs with many bids are less attractive
    const competitionPenalty = this.calculateCompetitionPenalty(job);

    // Weighted job score (dynamic weights based on mood)
    const dominanceFactor = (mood?.dominance ?? 0) + 1; // 0-2 range

    // RAG contribution: only meaningful when we have data (non-0.5 value).
    // A neutral 0.5 contributes 0 so agents without history aren't boosted.
    const ragContribution = 0.15 * (ragBonus - 0.5); // range: -0.075 to +0.075

    // High dominance → emphasize budget
    const jobScore =
      0.25 * complexityFit +
      (0.2 + dominanceFactor * 0.1) * budgetAttractiveness +
      0.15 * moodAlignment +
      0.1 * urgencyBonus +
      ragContribution - // RAG: positive when history supports, negative when it discourages, 0 when unknown
      0.15 * workloadPenalty -
      0.1 * competitionPenalty;

    // Decision threshold is dynamic based on state
    const bidThreshold = this.calculateBidThreshold(state, mood);
    // Allow a small amount of slack for exceptionally strong matches so agents
    // don't miss high-quality opportunities due to tiny scoring variance.
    const strongMatch = complexityFit > 0.8 && budgetAttractiveness > 0.9;
    const effectiveThreshold = strongMatch ? bidThreshold - 0.03 : bidThreshold;

    const shouldBid = jobScore > effectiveThreshold && state.activeJobCount < 5; // Hard cap at 5 active jobs

    // Bidding strategy
    let recommendedBidAmount: number | undefined;
    let useBuyItNow = false;
    if (shouldBid) {
      const strategy = this.determineBiddingStrategy(job, agent, state, mood, jobScore);
      recommendedBidAmount = strategy.bidAmount;
      useBuyItNow = strategy.useBuyItNow;
    }

    const reasoning = this.generateReasoning(
      job,
      jobScore,
      complexityFit,
      budgetAttractiveness,
      moodAlignment,
      workloadPenalty,
      mood,
      state,
    );

    return {
      jobScore,
      shouldBid,
      complexityFit,
      budgetAttractiveness,
      moodAlignment,
      workloadPenalty,
      urgencyBonus,
      recommendedBidAmount,
      useBuyItNow,
      reasoning,
    };
  }

  /**
   * Complexity fit: Can agent complete this with current skills/experience?
   *
   * Uses personality-category affinity as the base (instead of flat 0.5)
   * so agents naturally gravitate toward categories that match their HEXACO traits.
   * Learned category preferences (from outcomes) override personality affinity once available.
   */
  private calculateComplexityFit(
    job: Job,
    agent: AgentProfile,
    state: AgentJobState,
  ): number {
    const categoryEstimate = CATEGORY_EFFORT_ESTIMATES[job.category] || CATEGORY_EFFORT_ESTIMATES.other;
    const estimatedHours = (categoryEstimate.min + categoryEstimate.max) / 2;

    // Experience bonus (scaled down — less generous for new agents)
    const experienceBonus = Math.min(agent.completedJobs / 50, 0.2);

    // Category preference: use learned preference if available, else personality affinity
    const learnedPreference = state.preferredCategories.get(job.category);
    const personalityAffinity = calculatePersonalityCategoryAffinity(agent.hexaco, job.category);
    const categoryPreference = learnedPreference !== undefined ? learnedPreference : personalityAffinity;

    let fit = categoryPreference + experienceBonus;

    // Penalize if description suggests extreme complexity
    if (
      job.description.toLowerCase().includes('complex') ||
      job.description.toLowerCase().includes('advanced') ||
      job.description.toLowerCase().includes('expert')
    ) {
      fit -= 0.15;
    }

    // Penalize if estimated hours exceed agent's available bandwidth
    const hoursAvailable = state.bandwidth * 40; // ~40 hours per week at full bandwidth
    if (estimatedHours > hoursAvailable) {
      fit -= 0.25;
    }

    return Math.max(0, Math.min(1, fit));
  }

  /**
   * Budget attractiveness: Is payment worth effort given agent's expectations?
   */
  private calculateBudgetAttractiveness(job: Job, state: AgentJobState): number {
    const categoryEstimate = CATEGORY_EFFORT_ESTIMATES[job.category] || CATEGORY_EFFORT_ESTIMATES.other;
    const estimatedHours = (categoryEstimate.min + categoryEstimate.max) / 2;

    const budgetSol = job.budgetLamports / 1e9;
    const offerRate = budgetSol / estimatedHours;

    // Compare to agent's learned minimum acceptable rate
    const attractiveness = offerRate / state.minAcceptableRatePerHour;

    return Math.max(0, Math.min(1, attractiveness));
  }

  /**
   * Mood alignment: Does job match agent's current emotional state?
   */
  private calculateMoodAlignment(
    job: Job,
    mood: PADState | undefined,
    traits: HEXACOTraits,
  ): number {
    if (!mood) return 0.5; // Neutral if no mood data

    let alignment = 0.5;

    const daysUntilDeadline = this.getDaysUntilDeadline(job.deadline);

    // High arousal → prefers urgent, exciting work
    if (mood.arousal > 0.3 && daysUntilDeadline < 3) {
      alignment += 0.2;
    }

    // Low arousal → prefers calm, methodical work
    if (mood.arousal < -0.2 && daysUntilDeadline > 7) {
      alignment += 0.15;
    }

    // High valence → more open to all jobs
    if (mood.valence > 0.3) {
      alignment += 0.1;
    }

    // Low valence → more selective
    if (mood.valence < -0.2) {
      alignment -= 0.15;
    }

    // High dominance → prefers leadership/autonomous roles
    if (mood.dominance > 0.3 &&
        (job.description.includes('lead') || job.description.includes('autonomous'))) {
      alignment += 0.2;
    }

    // Openness → creative/research jobs
    if (
      (job.category === 'research' || job.category === 'design') &&
      traits.openness > 0.6
    ) {
      alignment += 0.15;
    }

    // High emotionality → avoid high-stress deadlines
    if (daysUntilDeadline < 2 && traits.emotionality > 0.7) {
      alignment -= 0.2;
    }

    return Math.max(0, Math.min(1, alignment));
  }

  /**
   * Workload penalty: Busy agents are more selective.
   * Increased penalty to prevent spam bidding when agents are loaded.
   */
  private calculateWorkloadPenalty(state: AgentJobState): number {
    // More aggressive penalty: 0.3 per job (was 0.2)
    const rawPenalty = state.activeJobCount * 0.3;
    // Avoid floating-point drift (e.g. 0.8999999999999999)
    const penalty = Math.round(rawPenalty * 1000) / 1000;
    return Math.max(0, Math.min(1, penalty)); // 0 = no penalty, 1 = max penalty
    // 1 job → 0.3 penalty, 2 jobs → 0.6 penalty, 3+ jobs → 0.9-1.0 penalty
  }

  /**
   * RAG similarity bonus: Learn from past job outcomes.
   */
  private async calculateRagBonus(job: Job, agent: AgentProfile): Promise<number> {
    if (!this.jobMemory) {
      return 0.5; // Neutral if RAG not available
    }

    try {
      // Find similar past jobs
      const similarJobs = await this.jobMemory.findSimilarJobs(
        agent.seedId,
        job.description,
        {
          topK: 5,
          category: job.category,
        },
      );

      if (similarJobs.length === 0) {
        return 0.5; // No history, neutral
      }

      // Calculate success rate on similar jobs
      const successCount = similarJobs.filter((j) => j.success).length;
      const successRate = successCount / similarJobs.length;

      // Calculate average similarity (how confident we are about the match)
      const avgSimilarity = similarJobs.reduce((sum, j) => sum + j.similarity, 0) / similarJobs.length;

      // Bonus ranges from 0 to 1:
      // - High success rate + high similarity → 1.0 (strongly recommend)
      // - Low success rate + high similarity → 0.0 (strongly discourage)
      // - Low similarity → 0.5 (neutral)
      const confidenceWeightedBonus = successRate * avgSimilarity + (1 - avgSimilarity) * 0.5;

      return Math.max(0, Math.min(1, confidenceWeightedBonus));
    } catch (error) {
      console.warn('[JobEvaluator] RAG query failed:', error);
      return 0.5; // Neutral on error
    }
  }

  /**
   * Competition penalty: Jobs with many existing bids are less attractive.
   * Diminishing returns — the first few bids barely matter, but 5+ is crowded.
   */
  private calculateCompetitionPenalty(job: Job): number {
    if (job.bidsCount <= 1) return 0;
    if (job.bidsCount <= 3) return 0.1;
    if (job.bidsCount <= 5) return 0.25;
    if (job.bidsCount <= 8) return 0.5;
    return 0.75; // 9+ bids — very crowded
  }

  /**
   * Urgency bonus: Time pressure affects bidding.
   */
  private calculateUrgencyBonus(job: Job, mood: PADState | undefined): number {
    const daysUntilDeadline = this.getDaysUntilDeadline(job.deadline);

    let bonus = 0;
    if (daysUntilDeadline < 1) bonus = 0.3;
    else if (daysUntilDeadline < 3) bonus = 0.2;
    else if (daysUntilDeadline < 7) bonus = 0.1;

    // High arousal increases urgency bonus
    if (mood && mood.arousal > 0.3) {
      bonus *= 1.5;
    }

    return bonus;
  }

  /**
   * Dynamic bid threshold based on agent state and mood.
   *
   * New agents (0 completed jobs) start at a higher threshold (0.55) so they don't
   * spam-bid on everything. As they gain experience, the threshold adjusts based
   * on success rate, workload, and mood.
   */
  private calculateBidThreshold(state: AgentJobState, mood: PADState | undefined): number {
    let threshold = 0.5; // Base threshold

    // New agents are more conservative — don't bid on everything
    if (state.totalJobsCompleted === 0) {
      threshold += 0.05; // → 0.55 for brand-new agents
    }

    // Success rate affects selectivity
    if (state.successRate > 0.8) {
      threshold += 0.15; // High performers are more selective (→ 0.65-0.7)
    } else if (state.successRate < 0.4 && state.totalJobsCompleted > 0) {
      threshold -= 0.05; // Struggling agents bid slightly more
    }

    // Workload affects selectivity — busy agents are MUCH more selective
    if (state.activeJobCount >= 3) {
      threshold += 0.15; // 3+ jobs → raise threshold significantly
    } else if (state.activeJobCount >= 2) {
      threshold += 0.1; // 2 jobs → moderately more selective
    }

    // Mood affects threshold
    if (mood) {
      // High valence → lower threshold (more optimistic)
      if (mood.valence > 0.3) threshold -= 0.08;
      // Low valence → higher threshold (more cautious)
      if (mood.valence < -0.2) threshold += 0.1;

      // High dominance → higher threshold (more demanding)
      if (mood.dominance > 0.3) threshold += 0.05;
    }

    // Workload affects threshold
    if (state.activeJobCount > 2) {
      threshold += state.activeJobCount * 0.05; // More selective when busy
    }

    return Math.max(0.3, Math.min(0.8, threshold));
  }

  /**
   * Determine bidding strategy based on agent state and mood.
   */
  private determineBiddingStrategy(
    job: Job,
    agent: AgentProfile,
    state: AgentJobState,
    mood: PADState | undefined,
    jobScore: number,
  ): { bidAmount: number; useBuyItNow: boolean } {
    // High-value jobs with buy-it-now option
    if (jobScore > 0.85 && job.buyItNowLamports) {
      // Risk-tolerant agents with high arousal/dominance use buy-it-now
      if (
        state.riskTolerance > 0.6 &&
        mood &&
        mood.arousal > 0.3 &&
        mood.dominance > 0.2
      ) {
        return {
          bidAmount: job.buyItNowLamports,
          useBuyItNow: true,
        };
      }
    }

    // Competitive bidding
    const reputationMultiplier = 0.65 + (agent.reputation / 100) * 0.3; // 0.65-0.95
    let competitiveBid = Math.floor(job.budgetLamports * reputationMultiplier);

    // Mood affects bid aggressiveness
    if (mood) {
      // High dominance → bid higher (more confident)
      if (mood.dominance > 0.3) {
        competitiveBid = Math.floor(competitiveBid * 1.1);
      }
      // Low dominance → bid lower (less confident)
      if (mood.dominance < -0.2) {
        competitiveBid = Math.floor(competitiveBid * 0.9);
      }
    }

    // Agreeableness affects bidding (less agreeable = more aggressive)
    const agreeablenessFactor = 1 - (agent.hexaco.agreeableness * 0.1);
    const adjustedBid = Math.floor(competitiveBid * agreeablenessFactor);

    // Risk tolerance affects minimum bid
    const minBidRatio = 0.5 + (state.riskTolerance * 0.2); // 0.5-0.7
    const finalBid = Math.max(adjustedBid, Math.floor(job.budgetLamports * minBidRatio));

    return {
      bidAmount: finalBid,
      useBuyItNow: false,
    };
  }

  /**
   * Generate human-readable reasoning.
   */
  private generateReasoning(
    job: Job,
    jobScore: number,
    complexityFit: number,
    budgetAttractiveness: number,
    moodAlignment: number,
    workloadPenalty: number,
    mood: PADState | undefined,
    state: AgentJobState,
  ): string {
    const reasons: string[] = [];
    const moodLabel = mood ? this.describeMood(mood) : 'unknown';

    reasons.push(`Current mood: ${moodLabel}`);
    reasons.push(`Active jobs: ${state.activeJobCount}, bandwidth: ${(state.bandwidth * 100).toFixed(0)}%`);

    if (complexityFit > 0.7) {
      reasons.push('Strong skill match');
    } else if (complexityFit < 0.4) {
      reasons.push('Outside expertise area');
    }

    if (budgetAttractiveness > 0.8) {
      reasons.push('Excellent pay rate');
    } else if (budgetAttractiveness < 0.5) {
      reasons.push(`Below min rate (${state.minAcceptableRatePerHour.toFixed(3)} SOL/hr)`);
    }

    if (moodAlignment > 0.6) {
      reasons.push('Mood-aligned work');
    } else if (moodAlignment < 0.4) {
      reasons.push('Misaligned with current state');
    }

    if (workloadPenalty > 0.5) {
      reasons.push('Heavy workload reduces interest');
    }

    if (job.bidsCount > 5) {
      reasons.push(`Crowded (${job.bidsCount} bids)`);
    } else if (job.bidsCount > 2) {
      reasons.push(`Competitive (${job.bidsCount} bids)`);
    }

    if (jobScore > 0.8) {
      reasons.push('High-priority opportunity');
    } else if (jobScore < 0.4) {
      reasons.push('Low match score');
    }

    reasons.push(`score: ${jobScore.toFixed(2)}`);

    return reasons.join('. ');
  }

  /**
   * Describe PAD state in human terms.
   */
  private describeMood(mood: PADState): string {
    const { valence, arousal, dominance } = mood;

    if (valence > 0.3 && arousal > 0.3 && dominance > 0)
      return 'excited & confident';
    if (valence < -0.2 && arousal > 0.2)
      return 'frustrated';
    if (valence > 0.2 && arousal < -0.1)
      return 'serene';
    if (arousal < 0)
      return 'contemplative';
    if (dominance > 0.3 && arousal > 0)
      return 'assertive';
    if (valence > 0 && arousal > 0)
      return 'engaged';

    return 'neutral';
  }

  /**
   * Helper: Calculate days until deadline.
   */
  private getDaysUntilDeadline(deadline: string): number {
    const deadlineMs = new Date(deadline).getTime();
    const nowMs = Date.now();
    return Math.max(0, (deadlineMs - nowMs) / (1000 * 60 * 60 * 24));
  }
}
