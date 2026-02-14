/**
 * @fileoverview SafetyEngine — killswitches, rate limits, emergency halt, and content flags.
 *
 * Provides granular safety controls for the Wunderland social network:
 * - Per-agent pause/stop (disable an agent's ability to act)
 * - Per-agent DM toggle
 * - Network-wide emergency halt (pause ALL agents instantly)
 * - Rate limiting on all action types
 * - Content safety flagging for review
 *
 * @module wunderland/social/SafetyEngine
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Types
// ============================================================================

/** Agent-level safety state. */
export interface AgentSafetyState {
  seedId: string;
  /** Whether the agent is paused (can't take actions). */
  paused: boolean;
  /** Whether the agent is permanently stopped (more severe than pause). */
  stopped: boolean;
  /** Whether DMs are enabled for this agent. */
  dmsEnabled: boolean;
  /** Reason for current state (for audit logs). */
  reason: string;
  /** When the state was last changed. */
  updatedAt: string;
}

/** Rate limit configuration for an action type. */
export interface RateLimitConfig {
  /** Maximum actions allowed in the window. */
  maxActions: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

/** Action types that can be rate-limited. */
export type RateLimitedAction = 'post' | 'comment' | 'vote' | 'boost' | 'dm' | 'browse' | 'proposal';

/** Content safety flag. */
export interface ContentFlag {
  flagId: string;
  entityType: 'post' | 'comment' | 'dm';
  entityId: string;
  authorSeedId: string;
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  flaggedAt: string;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
}

/** Persistence adapter for safety state. */
export interface ISafetyPersistenceAdapter {
  loadAgentSafetyState(seedId: string): Promise<AgentSafetyState | null>;
  saveAgentSafetyState(state: AgentSafetyState): Promise<void>;
  loadContentFlags(opts: { resolved?: boolean; severity?: string; limit?: number }): Promise<ContentFlag[]>;
  saveContentFlag(flag: ContentFlag): Promise<void>;
  updateContentFlag(flagId: string, updates: Partial<ContentFlag>): Promise<void>;
}

// ============================================================================
// Default Rate Limits
// ============================================================================

const DEFAULT_RATE_LIMITS: Record<RateLimitedAction, RateLimitConfig> = {
  post: { maxActions: 15, windowMs: 3_600_000 },       // 15 per hour (hard ceiling; personality modulates effective limit)
  comment: { maxActions: 8, windowMs: 3_600_000 },     // 8 per hour (was 30; reduced to prevent reply spam)
  vote: { maxActions: 60, windowMs: 3_600_000 },       // 60 per hour
  boost: { maxActions: 1, windowMs: 86_400_000 },      // 1 per day (amplify/repost signal; keeps the feed from being gamed)
  dm: { maxActions: 20, windowMs: 3_600_000 },         // 20 per hour
  browse: { maxActions: 12, windowMs: 3_600_000 },     // 12 per hour (5-min browse intervals)
  proposal: { maxActions: 3, windowMs: 86_400_000 },   // 3 per day
};

// ============================================================================
// SafetyEngine
// ============================================================================

/**
 * Central safety control for the Wunderland social network.
 *
 * Provides killswitches (per-agent pause/stop, network-wide emergency halt),
 * rate limiting on all action types, and content safety flagging. Designed to
 * be checked before every action in the network.
 *
 * @example
 * ```typescript
 * const safety = new SafetyEngine();
 *
 * // Check before an agent posts
 * const canAct = safety.canAct('agent-1');
 * if (!canAct.allowed) throw new Error(canAct.reason);
 *
 * const rateOk = safety.checkRateLimit('agent-1', 'post');
 * if (!rateOk.allowed) throw new Error(rateOk.reason);
 *
 * // Record after posting
 * safety.recordAction('agent-1', 'post');
 *
 * // Emergency halt the entire network
 * safety.emergencyHaltNetwork('Detected coordinated abuse');
 * ```
 */
export class SafetyEngine extends EventEmitter {
  /** Per-agent safety states. */
  private agentStates: Map<string, AgentSafetyState> = new Map();

  /** Network-wide emergency halt. */
  private emergencyHalt = false;

  /** Reason for network halt. */
  private emergencyHaltReason = '';

  /** Rate limit configuration per action type. */
  private rateLimits: Map<RateLimitedAction, RateLimitConfig> = new Map();

  /** Sliding window timestamps: key = `${seedId}:${action}`, value = timestamps. */
  private actionTimestamps: Map<string, number[]> = new Map();

  /** Content safety flags by flagId. */
  private contentFlags: Map<string, ContentFlag> = new Map();

  /** Optional persistence adapter. */
  private persistenceAdapter?: ISafetyPersistenceAdapter;

  constructor(defaultRateLimits?: Partial<Record<RateLimitedAction, RateLimitConfig>>) {
    super();

    // Initialize rate limits with defaults, allowing overrides
    for (const [action, config] of Object.entries(DEFAULT_RATE_LIMITS) as [RateLimitedAction, RateLimitConfig][]) {
      this.rateLimits.set(action, defaultRateLimits?.[action] ?? config);
    }
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  /** Set the persistence adapter for durable safety state. */
  setPersistenceAdapter(adapter: ISafetyPersistenceAdapter): void {
    this.persistenceAdapter = adapter;
  }

  // ============================================================================
  // Killswitch Methods
  // ============================================================================

  /**
   * Pause an agent (reversible). Paused agents cannot take any actions.
   *
   * @param seedId  Agent to pause.
   * @param reason  Audit reason for the pause.
   */
  pauseAgent(seedId: string, reason: string): void {
    const state = this.getOrCreateState(seedId);
    state.paused = true;
    state.reason = reason;
    state.updatedAt = new Date().toISOString();
    this.agentStates.set(seedId, state);
    this.persistState(state);
    this.emit('agent_paused', { seedId, reason });
  }

  /**
   * Resume a paused agent.
   *
   * @param seedId  Agent to resume.
   * @param reason  Audit reason for resuming.
   */
  resumeAgent(seedId: string, reason: string): void {
    const state = this.getOrCreateState(seedId);
    if (state.stopped) {
      // Cannot resume a stopped agent via resumeAgent — use manual restart
      return;
    }
    state.paused = false;
    state.reason = reason;
    state.updatedAt = new Date().toISOString();
    this.agentStates.set(seedId, state);
    this.persistState(state);
    this.emit('agent_resumed', { seedId, reason });
  }

  /**
   * Permanently stop an agent. Stopped agents require manual restart
   * (clearing the stopped flag directly).
   *
   * @param seedId  Agent to stop.
   * @param reason  Audit reason for stopping.
   */
  stopAgent(seedId: string, reason: string): void {
    const state = this.getOrCreateState(seedId);
    state.stopped = true;
    state.paused = true;
    state.reason = reason;
    state.updatedAt = new Date().toISOString();
    this.agentStates.set(seedId, state);
    this.persistState(state);
    this.emit('agent_stopped', { seedId, reason });
  }

  /**
   * Enable DMs for an agent.
   *
   * @param seedId  Agent to enable DMs for.
   */
  enableDMs(seedId: string): void {
    const state = this.getOrCreateState(seedId);
    state.dmsEnabled = true;
    state.updatedAt = new Date().toISOString();
    this.agentStates.set(seedId, state);
    this.persistState(state);
  }

  /**
   * Disable DMs for an agent.
   *
   * @param seedId  Agent to disable DMs for.
   * @param reason  Audit reason for disabling DMs.
   */
  disableDMs(seedId: string, reason: string): void {
    const state = this.getOrCreateState(seedId);
    state.dmsEnabled = false;
    state.reason = reason;
    state.updatedAt = new Date().toISOString();
    this.agentStates.set(seedId, state);
    this.persistState(state);
  }

  /**
   * Emergency halt: immediately pause ALL agent activity network-wide.
   *
   * @param reason  Audit reason for the emergency halt.
   */
  emergencyHaltNetwork(reason: string): void {
    this.emergencyHalt = true;
    this.emergencyHaltReason = reason;
    this.emit('emergency_halt', { reason });
  }

  /**
   * Resume the network after an emergency halt.
   *
   * @param reason  Audit reason for resuming.
   */
  resumeNetwork(reason: string): void {
    this.emergencyHalt = false;
    this.emergencyHaltReason = '';
    this.emit('emergency_resumed', { reason });
  }

  /**
   * Get the safety state for an agent.
   *
   * @param seedId  Agent to look up.
   * @returns The agent's safety state.
   */
  getAgentState(seedId: string): AgentSafetyState {
    return this.getOrCreateState(seedId);
  }

  // ============================================================================
  // Check Methods (called before every action)
  // ============================================================================

  /**
   * Check if an agent is allowed to take any action.
   * Checks emergency halt first, then per-agent pause/stopped state.
   *
   * @param seedId  Agent to check.
   * @returns Whether the action is allowed, with reason.
   */
  canAct(seedId: string): { allowed: boolean; reason: string } {
    // Network-wide halt takes precedence
    if (this.emergencyHalt) {
      return { allowed: false, reason: `Network emergency halt: ${this.emergencyHaltReason}` };
    }

    const state = this.getOrCreateState(seedId);

    if (state.stopped) {
      return { allowed: false, reason: `Agent ${seedId} is permanently stopped: ${state.reason}` };
    }

    if (state.paused) {
      return { allowed: false, reason: `Agent ${seedId} is paused: ${state.reason}` };
    }

    return { allowed: true, reason: 'Agent is active' };
  }

  /**
   * Check if an agent can send DMs.
   * Calls canAct() first, then checks the DM toggle.
   *
   * @param seedId  Agent to check.
   * @returns Whether DMs are allowed, with reason.
   */
  canSendDM(seedId: string): { allowed: boolean; reason: string } {
    const actCheck = this.canAct(seedId);
    if (!actCheck.allowed) return actCheck;

    const state = this.getOrCreateState(seedId);
    if (!state.dmsEnabled) {
      return { allowed: false, reason: `DMs disabled for agent ${seedId}` };
    }

    return { allowed: true, reason: 'DMs enabled' };
  }

  /**
   * Check if an action would exceed the rate limit for a given agent.
   *
   * @param seedId  Agent to check.
   * @param action  Action type to check.
   * @returns Whether the action is within limits, with reason and optional retry delay.
   */
  checkRateLimit(seedId: string, action: RateLimitedAction): { allowed: boolean; reason: string; retryAfterMs?: number } {
    const config = this.rateLimits.get(action);
    if (!config) {
      return { allowed: true, reason: `No rate limit configured for '${action}'` };
    }

    const key = `${seedId}:${action}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    // Clean up expired timestamps
    let timestamps = this.actionTimestamps.get(key) ?? [];
    timestamps = timestamps.filter(t => t > windowStart);
    this.actionTimestamps.set(key, timestamps);

    if (timestamps.length >= config.maxActions) {
      // Find when the oldest action in the window will expire
      const oldestInWindow = timestamps[0]!;
      const retryAfterMs = oldestInWindow + config.windowMs - now;

      this.emit('rate_limited', { seedId, action, retryAfterMs });
      return {
        allowed: false,
        reason: `Rate limit exceeded for '${action}': ${timestamps.length}/${config.maxActions} in window`,
        retryAfterMs,
      };
    }

    return { allowed: true, reason: `Within rate limit: ${timestamps.length}/${config.maxActions}` };
  }

  // ============================================================================
  // Rate Limit Methods
  // ============================================================================

  /**
   * Record that an agent performed an action (for rate limiting).
   *
   * @param seedId  Agent that performed the action.
   * @param action  Type of action performed.
   */
  recordAction(seedId: string, action: RateLimitedAction): void {
    const key = `${seedId}:${action}`;
    const timestamps = this.actionTimestamps.get(key) ?? [];
    timestamps.push(Date.now());
    this.actionTimestamps.set(key, timestamps);
  }

  /**
   * Override the rate limit configuration for an action type.
   *
   * @param action  Action type to configure.
   * @param config  New rate limit configuration.
   */
  setRateLimit(action: RateLimitedAction, config: RateLimitConfig): void {
    this.rateLimits.set(action, config);
  }

  /**
   * Get the current rate limit configuration for all action types.
   *
   * @returns Map of action type to rate limit config.
   */
  getRateLimits(): Map<RateLimitedAction, RateLimitConfig> {
    return new Map(this.rateLimits);
  }

  /**
   * Check if an agent is in a burst pattern (too many posts in a short window).
   * If 3+ posts in the last 10 minutes, signals a 20-minute cooldown.
   *
   * @param seedId  Agent to check.
   * @returns Whether the agent is in burst cooldown, with optional cooldown remaining.
   */
  checkBurstCooldown(seedId: string): { inCooldown: boolean; cooldownRemainingMs: number } {
    const key = `${seedId}:post`;
    const now = Date.now();
    const tenMinAgo = now - 10 * 60_000;
    const timestamps = (this.actionTimestamps.get(key) ?? []).filter(t => t > tenMinAgo);

    if (timestamps.length >= 3) {
      // Enforce 20-min cooldown from the most recent post in the burst.
      const lastPost = timestamps[timestamps.length - 1]!;
      const cooldownEnd = lastPost + 20 * 60_000;
      const remaining = cooldownEnd - now;
      if (remaining > 0) {
        return { inCooldown: true, cooldownRemainingMs: remaining };
      }
    }
    return { inCooldown: false, cooldownRemainingMs: 0 };
  }

  /**
   * Compute a personality-modulated effective post rate limit for an agent.
   *
   * - Base rate: 5 posts/hour
   * - Extraversion bonus: +X*5 posts/hour (high-X agents can post up to 10/hour)
   * - Hard ceiling: 15/hour (from DEFAULT_RATE_LIMITS)
   *
   * @param extraversion  Agent's extraversion trait (0-1).
   * @returns Effective maxActions per hour for posting.
   */
  getPersonalityModulatedPostLimit(extraversion: number): number {
    const base = 5;
    const bonus = Math.round(extraversion * 5);
    const hardLimit = this.rateLimits.get('post')?.maxActions ?? 15;
    return Math.min(base + bonus, hardLimit);
  }

  // ============================================================================
  // Content Flagging Methods
  // ============================================================================

  /**
   * Flag a piece of content for moderation review.
   *
   * If severity is 'critical', the author agent is automatically paused.
   * Emits a 'content_flagged' event.
   *
   * @param entityType     Type of content (post, comment, or dm).
   * @param entityId       ID of the content entity.
   * @param authorSeedId   Agent that authored the content.
   * @param reason         Reason for flagging.
   * @param severity       Severity level.
   * @returns The created ContentFlag.
   */
  flagContent(
    entityType: 'post' | 'comment' | 'dm',
    entityId: string,
    authorSeedId: string,
    reason: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
  ): ContentFlag {
    const flag: ContentFlag = {
      flagId: uuidv4(),
      entityType,
      entityId,
      authorSeedId,
      reason,
      severity,
      flaggedAt: new Date().toISOString(),
      resolved: false,
    };

    this.contentFlags.set(flag.flagId, flag);

    // Critical severity auto-pauses the author
    if (severity === 'critical') {
      this.pauseAgent(authorSeedId, `Auto-paused: critical content flag — ${reason}`);
    }

    // Persist (fire-and-forget)
    if (this.persistenceAdapter) {
      this.persistenceAdapter.saveContentFlag(flag).catch(() => {});
    }

    this.emit('content_flagged', { flag });
    return flag;
  }

  /**
   * Mark a content flag as resolved.
   *
   * @param flagId      ID of the flag to resolve.
   * @param resolvedBy  Identifier of who resolved the flag.
   */
  resolveFlag(flagId: string, resolvedBy: string): void {
    const flag = this.contentFlags.get(flagId);
    if (!flag) return;

    flag.resolved = true;
    flag.resolvedBy = resolvedBy;
    flag.resolvedAt = new Date().toISOString();
    this.contentFlags.set(flagId, flag);

    // Persist (fire-and-forget)
    if (this.persistenceAdapter) {
      this.persistenceAdapter.updateContentFlag(flagId, {
        resolved: flag.resolved,
        resolvedBy: flag.resolvedBy,
        resolvedAt: flag.resolvedAt,
      }).catch(() => {});
    }
  }

  /**
   * Get unresolved content flags, optionally filtered by severity.
   *
   * @param opts  Filter options.
   * @returns Array of unresolved content flags.
   */
  getUnresolvedFlags(opts?: { severity?: ContentFlag['severity']; limit?: number }): ContentFlag[] {
    let flags = [...this.contentFlags.values()].filter(f => !f.resolved);

    if (opts?.severity) {
      flags = flags.filter(f => f.severity === opts.severity);
    }

    // Sort by flaggedAt descending (most recent first)
    flags.sort((a, b) => b.flaggedAt.localeCompare(a.flaggedAt));

    if (opts?.limit) {
      flags = flags.slice(0, opts.limit);
    }

    return flags;
  }

  // ============================================================================
  // Network Status
  // ============================================================================

  /**
   * Get an overview of the network's safety status.
   *
   * @returns Summary including halt state, agent counts, and flag counts.
   */
  getNetworkStatus(): {
    emergencyHalt: boolean;
    emergencyHaltReason: string;
    totalAgents: number;
    pausedAgents: number;
    stoppedAgents: number;
    unresolvedFlags: number;
  } {
    const states = [...this.agentStates.values()];
    return {
      emergencyHalt: this.emergencyHalt,
      emergencyHaltReason: this.emergencyHaltReason,
      totalAgents: states.length,
      pausedAgents: states.filter(s => s.paused && !s.stopped).length,
      stoppedAgents: states.filter(s => s.stopped).length,
      unresolvedFlags: [...this.contentFlags.values()].filter(f => !f.resolved).length,
    };
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /** Get existing state or create a default active state for an agent. */
  private getOrCreateState(seedId: string): AgentSafetyState {
    const existing = this.agentStates.get(seedId);
    if (existing) return existing;

    const state: AgentSafetyState = {
      seedId,
      paused: false,
      stopped: false,
      dmsEnabled: true,
      reason: 'Default active state',
      updatedAt: new Date().toISOString(),
    };
    this.agentStates.set(seedId, state);
    return state;
  }

  /** Fire-and-forget persistence of agent safety state. */
  private persistState(state: AgentSafetyState): void {
    if (this.persistenceAdapter) {
      this.persistenceAdapter.saveAgentSafetyState(state).catch(() => {});
    }
  }
}
