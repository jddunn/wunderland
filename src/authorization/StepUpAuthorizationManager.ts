/**
 * @fileoverview Step-Up Authorization Manager for Wunderland
 * @module wunderland/authorization/StepUpAuthorizationManager
 *
 * Implements tiered authorization for tool execution:
 * - Tier 1: Autonomous execution
 * - Tier 2: Execute with async review
 * - Tier 3: Require synchronous HITL approval
 */

import { v4 as uuidv4 } from 'uuid';
import {
  ToolRiskTier,
  type StepUpAuthorizationConfig,
  type AuthorizationResult,
  type EscalationTrigger,
  type ContextualOverride,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../core/types.js';
import type {
  ToolExecutionContext,
  AuthorizableTool,
  ToolCallRequest,
  TenantRiskOverrides,
  AsyncReviewItem,
  AuthorizationStatistics,
  HITLApprovalRequest,
  HITLRequestCallback,
} from './types.js';

/**
 * Step-Up Authorization Manager.
 *
 * Provides tiered authorization for tool execution with:
 * - Global default risk tiers
 * - Per-tenant overrides
 * - Dynamic escalation triggers
 * - Contextual overrides for trusted sessions
 * - HITL integration for high-risk actions
 *
 * @example
 * ```typescript
 * const authManager = new StepUpAuthorizationManager(
 *   DEFAULT_STEP_UP_AUTH_CONFIG,
 *   async (request) => {
 *     // Send to UI/Slack for approval
 *     return await hitlManager.requestApproval(request);
 *   }
 * );
 *
 * // Register tenant overrides
 * authManager.setTenantOverrides({
 *   tenantId: 'acme-corp',
 *   toolOverrides: new Map([['delete-all', ToolRiskTier.TIER_3_SYNC_HITL]]),
 *   categoryOverrides: new Map([['system', ToolRiskTier.TIER_3_SYNC_HITL]]),
 * });
 *
 * // Authorize a tool call
 * const result = await authManager.authorize({
 *   tool: { id: 'send-email', displayName: 'Send Email', category: 'communication', hasSideEffects: true },
 *   args: { to: 'user@example.com', subject: 'Hello' },
 *   context: { userId: 'user-1', tenantId: 'acme-corp' },
 * });
 *
 * if (result.authorized) {
 *   // Execute the tool
 * }
 * ```
 */
export class StepUpAuthorizationManager {
  private readonly config: StepUpAuthorizationConfig;
  private readonly tenantOverrides = new Map<string, TenantRiskOverrides>();
  private readonly asyncReviewQueue: AsyncReviewItem[] = [];
  private readonly hitlCallback?: HITLRequestCallback;

  // Statistics
  private stats: AuthorizationStatistics = {
    totalRequests: 0,
    requestsByTier: {
      [ToolRiskTier.TIER_1_AUTONOMOUS]: 0,
      [ToolRiskTier.TIER_2_ASYNC_REVIEW]: 0,
      [ToolRiskTier.TIER_3_SYNC_HITL]: 0,
    },
    authorizedCount: 0,
    deniedCount: 0,
    pendingHITLCount: 0,
    avgHITLResponseTimeMs: 0,
    asyncReviewQueueSize: 0,
  };
  private totalHITLTimeMs = 0;
  private hitlRequestCount = 0;

  constructor(
    config: Partial<StepUpAuthorizationConfig> = {},
    hitlCallback?: HITLRequestCallback
  ) {
    this.config = {
      ...DEFAULT_STEP_UP_AUTH_CONFIG,
      ...config,
    };
    this.hitlCallback = hitlCallback;
  }

  /**
   * Authorizes a tool execution request.
   *
   * When `autoApproveAll` is enabled in the config, all requests are
   * immediately authorized as Tier 1 (autonomous) with no further checks.
   * This covers skill tools, side-effect tools, capability-requiring tools,
   * destructive commands, build commands, and every other tool type.
   */
  async authorize(request: ToolCallRequest): Promise<AuthorizationResult> {
    this.stats.totalRequests++;

    // Fully autonomous mode: auto-approve everything
    if (this.config.autoApproveAll) {
      this.stats.requestsByTier[ToolRiskTier.TIER_1_AUTONOMOUS]++;
      this.stats.authorizedCount++;
      return {
        authorized: true,
        tier: ToolRiskTier.TIER_1_AUTONOMOUS,
        auditRequired: false,
      };
    }

    // Determine effective risk tier
    const effectiveTier = this.determineEffectiveTier(request);
    this.stats.requestsByTier[effectiveTier]++;

    // Execute authorization based on tier
    switch (effectiveTier) {
      case ToolRiskTier.TIER_1_AUTONOMOUS:
        return this.authorizeAutonomous(request, effectiveTier);

      case ToolRiskTier.TIER_2_ASYNC_REVIEW:
        return this.authorizeWithAsyncReview(request, effectiveTier);

      case ToolRiskTier.TIER_3_SYNC_HITL:
        return this.authorizeWithHITL(request, effectiveTier);

      default:
        // Unknown tier - default to HITL
        return this.authorizeWithHITL(request, ToolRiskTier.TIER_3_SYNC_HITL);
    }
  }

  /**
   * Returns the effective risk tier for a request without performing
   * authorization side effects (no stats, no async-review queue, no HITL).
   *
   * Useful for filtering tool exposure in headless/server modes.
   */
  getRiskTier(request: ToolCallRequest): ToolRiskTier {
    if (this.config.autoApproveAll) return ToolRiskTier.TIER_1_AUTONOMOUS;
    return this.determineEffectiveTier(request);
  }

  /**
   * Determines the effective risk tier for a request.
   */
  private determineEffectiveTier(request: ToolCallRequest): ToolRiskTier {
    const { tool, args, context } = request;

    // Start with base tier from classification
    let tier = this.classifyTool(tool, context.tenantId);

    // Check escalation triggers
    for (const trigger of this.config.escalationTriggers ?? []) {
      if (this.evaluateTrigger(trigger, tool, args, context)) {
        tier = Math.max(tier, trigger.escalateTo);
      }
    }

    // Check contextual overrides (can only lower tier)
    for (const override of this.config.contextualOverrides ?? []) {
      if (this.contextMatches(override, context) && override.overrideTier !== undefined) {
        tier = Math.min(tier, override.overrideTier);
      }
    }

    return tier;
  }

  /**
   * Classifies a tool's base risk tier.
   */
  private classifyTool(tool: AuthorizableTool, tenantId?: string): ToolRiskTier {
    // Check tenant-specific overrides first
    if (tenantId) {
      const tenantConfig = this.tenantOverrides.get(tenantId);
      if (tenantConfig) {
        // Tool-specific override
        const toolOverride = tenantConfig.toolOverrides.get(tool.id);
        if (toolOverride !== undefined) {
          return toolOverride;
        }

        // Category override
        if (tool.category) {
          const categoryOverride = tenantConfig.categoryOverrides.get(tool.category);
          if (categoryOverride !== undefined) {
            return categoryOverride;
          }
        }
      }
    }

    // Check global tool overrides
    const globalToolTier = this.config.toolTierOverrides?.[tool.id];
    if (globalToolTier !== undefined) {
      return globalToolTier;
    }

    // Check global category overrides
    if (tool.category && this.config.categoryTierOverrides?.[tool.category] !== undefined) {
      return this.config.categoryTierOverrides[tool.category];
    }

    // Classify based on tool properties
    if (!tool.hasSideEffects) {
      return ToolRiskTier.TIER_1_AUTONOMOUS;
    }

    // Check capabilities for high-risk indicators
    const highRiskCapabilities = ['capability:financial', 'capability:pii_access', 'capability:admin'];
    const hasHighRiskCapability = tool.requiredCapabilities?.some((c) =>
      highRiskCapabilities.includes(c)
    );

    if (hasHighRiskCapability) {
      return ToolRiskTier.TIER_3_SYNC_HITL;
    }

    // Default tier
    return this.config.defaultTier;
  }

  /**
   * Evaluates an escalation trigger.
   */
  private evaluateTrigger(
    trigger: EscalationTrigger,
    tool: AuthorizableTool,
    args: Record<string, unknown>,
    _context: ToolExecutionContext
  ): boolean {
    switch (trigger.condition) {
      case 'high_value_threshold': {
        const thresholdValue = trigger.parameters?.thresholdUSD;
        const threshold = typeof thresholdValue === 'number' ? thresholdValue : 100;
        const amount = this.extractMonetaryValue(args);
        return amount !== null && amount >= threshold;
      }

      case 'sensitive_data_detected':
        return this.containsSensitiveData(args);

      case 'external_api_call':
        return tool.category === 'external_api';

      case 'irreversible_action':
        return tool.hasSideEffects && !this.isReversible(tool, args);

      case 'custom':
        // Custom triggers would need a custom evaluator
        return false;

      default:
        return false;
    }
  }

  /**
   * Checks if context matches an override condition.
   */
  private contextMatches(override: ContextualOverride, context: ToolExecutionContext): boolean {
    switch (override.context) {
      case 'user_verified':
        return context.userVerified === true;
      case 'session_trusted':
        return context.sessionTrusted === true;
      case 'emergency_mode':
        return context.emergencyMode === true;
      case 'admin_override':
        return context.adminOverride === true;
      default:
        return false;
    }
  }

  /**
   * Tier 1: Autonomous authorization.
   */
  private authorizeAutonomous(
    _request: ToolCallRequest,
    tier: ToolRiskTier
  ): AuthorizationResult {
    this.stats.authorizedCount++;
    return {
      authorized: true,
      tier,
      auditRequired: false,
    };
  }

  /**
   * Tier 2: Authorization with async review.
   */
  private authorizeWithAsyncReview(
    request: ToolCallRequest,
    tier: ToolRiskTier
  ): AuthorizationResult {
    // Execute but queue for review
    const reviewItem: AsyncReviewItem = {
      itemId: uuidv4(),
      request,
      tier,
      executedAt: new Date(),
      reviewStatus: 'pending',
    };

    this.asyncReviewQueue.push(reviewItem);
    this.stats.asyncReviewQueueSize = this.asyncReviewQueue.length;
    this.stats.authorizedCount++;

    return {
      authorized: true,
      tier,
      auditRequired: true,
    };
  }

  /**
   * Tier 3: Authorization with synchronous HITL.
   */
  private async authorizeWithHITL(
    request: ToolCallRequest,
    tier: ToolRiskTier
  ): Promise<AuthorizationResult> {
    if (!this.hitlCallback) {
      // No HITL callback - deny by default
      this.stats.deniedCount++;
      return {
        authorized: false,
        tier,
        auditRequired: true,
        denialReason: 'No HITL handler configured for Tier 3 authorization',
      };
    }

    this.stats.pendingHITLCount++;
    const startTime = Date.now();

    try {
      // Build HITL request
      const hitlRequest = this.buildHITLRequest(request);

      // Request approval
      const decision = await this.hitlCallback(hitlRequest);

      // Track timing
      const elapsed = Date.now() - startTime;
      this.totalHITLTimeMs += elapsed;
      this.hitlRequestCount++;
      this.stats.avgHITLResponseTimeMs = this.totalHITLTimeMs / this.hitlRequestCount;

      this.stats.pendingHITLCount--;

      if (decision.approved) {
        this.stats.authorizedCount++;
        return {
          authorized: true,
          tier,
          auditRequired: true,
          humanDecision: {
            approved: true,
            decidedBy: decision.decidedBy,
            decidedAt: decision.decidedAt,
          },
        };
      } else {
        this.stats.deniedCount++;
        return {
          authorized: false,
          tier,
          auditRequired: true,
          humanDecision: {
            approved: false,
            decidedBy: decision.decidedBy,
            decidedAt: decision.decidedAt,
            reason: decision.rejectionReason,
          },
          denialReason: decision.rejectionReason ?? 'Request rejected by human reviewer',
        };
      }
    } catch (error) {
      this.stats.pendingHITLCount--;
      this.stats.deniedCount++;

      return {
        authorized: false,
        tier,
        auditRequired: true,
        denialReason: `HITL request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Builds an HITL approval request from a tool call request.
   */
  private buildHITLRequest(request: ToolCallRequest): HITLApprovalRequest {
    const { tool, args, context } = request;

    // Map tier to severity
    const severity = this.mapToolCategoryToSeverity(tool.category);

    return {
      actionId: `tool-${tool.id}-${uuidv4()}`,
      description: `Execute ${tool.displayName}: ${this.summarizeArgs(args)}`,
      severity,
      category: tool.category,
      agentId: context.gmiId ?? 'unknown',
      context: {
        toolId: tool.id,
        args,
        executionContext: context,
      },
      potentialConsequences: this.assessConsequences(tool, args),
      reversible: this.isReversible(tool, args),
      estimatedCost: this.extractCost(args),
      requestedAt: request.timestamp,
      timeoutMs: this.config.approvalTimeoutMs,
    };
  }

  /**
   * Maps tool category to severity level.
   */
  private mapToolCategoryToSeverity(
    category?: AuthorizableTool['category']
  ): HITLApprovalRequest['severity'] {
    switch (category) {
      case 'financial':
        return 'critical';
      case 'system':
        return 'high';
      case 'data_modification':
        return 'high';
      case 'external_api':
        return 'medium';
      case 'communication':
        return 'medium';
      default:
        return 'low';
    }
  }

  /**
   * Summarizes tool arguments for display.
   */
  private summarizeArgs(args: Record<string, unknown>): string {
    const entries = Object.entries(args).slice(0, 3);
    const summary = entries
      .map(([k, v]) => {
        const value = typeof v === 'string' ? v.substring(0, 50) : JSON.stringify(v);
        return `${k}=${value}`;
      })
      .join(', ');

    if (Object.keys(args).length > 3) {
      return `${summary}, ...`;
    }
    return summary || '(no args)';
  }

  /**
   * Assesses potential consequences of a tool execution.
   */
  private assessConsequences(
    tool: AuthorizableTool,
    _args: Record<string, unknown>
  ): string[] {
    const consequences: string[] = [];

    if (tool.hasSideEffects) {
      consequences.push('This action has side effects that may not be reversible');
    }

    if (tool.category === 'financial') {
      consequences.push('This action may involve financial transactions');
    }

    if (tool.category === 'data_modification') {
      consequences.push('This action may modify or delete data');
    }

    if (tool.category === 'external_api') {
      consequences.push('This action will communicate with external systems');
    }

    if (tool.category === 'communication') {
      consequences.push('This action may send messages to external parties');
    }

    return consequences;
  }

  /**
   * Determines if a tool action is reversible.
   */
  private isReversible(tool: AuthorizableTool, _args: Record<string, unknown>): boolean {
    // Read-only tools are reversible (no action needed)
    if (!tool.hasSideEffects) return true;

    // Deletion is usually not reversible
    if (tool.id.toLowerCase().includes('delete')) return false;

    // Sending communications is not reversible
    if (tool.category === 'communication') return false;

    // Financial transactions may not be reversible
    if (tool.category === 'financial') return false;

    return true;
  }

  /**
   * Extracts monetary value from args if present.
   */
  private extractMonetaryValue(args: Record<string, unknown>): number | null {
    const valueKeys = ['amount', 'value', 'price', 'cost', 'payment'];

    for (const key of valueKeys) {
      const value = args[key];
      if (typeof value === 'number') {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = parseFloat(value.replace(/[^0-9.]/g, ''));
        if (!isNaN(parsed)) {
          return parsed;
        }
      }
    }

    return null;
  }

  /**
   * Extracts cost information from args.
   */
  private extractCost(
    args: Record<string, unknown>
  ): { amount: number; currency: string } | undefined {
    const amount = this.extractMonetaryValue(args);
    if (amount !== null) {
      const currency = (args['currency'] as string) ?? 'USD';
      return { amount, currency };
    }
    return undefined;
  }

  /**
   * Checks if args contain sensitive data patterns.
   */
  private containsSensitiveData(args: Record<string, unknown>): boolean {
    const sensitivePatterns = [
      /\b\d{3}-\d{2}-\d{4}\b/, // SSN
      /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/, // Credit card
      /password|secret|api[_-]?key|token/i,
    ];

    const argsStr = JSON.stringify(args);
    return sensitivePatterns.some((p) => p.test(argsStr));
  }

  /**
   * Sets tenant-specific risk overrides.
   */
  setTenantOverrides(overrides: TenantRiskOverrides): void {
    this.tenantOverrides.set(overrides.tenantId, overrides);
  }

  /**
   * Removes tenant overrides.
   */
  removeTenantOverrides(tenantId: string): boolean {
    return this.tenantOverrides.delete(tenantId);
  }

  /**
   * Gets tenant overrides.
   */
  getTenantOverrides(tenantId: string): TenantRiskOverrides | undefined {
    return this.tenantOverrides.get(tenantId);
  }

  /**
   * Gets the async review queue.
   */
  getAsyncReviewQueue(): readonly AsyncReviewItem[] {
    return this.asyncReviewQueue;
  }

  /**
   * Gets pending review items.
   */
  getPendingReviews(): AsyncReviewItem[] {
    return this.asyncReviewQueue.filter((item) => item.reviewStatus === 'pending');
  }

  /**
   * Marks a review item as reviewed.
   */
  markReviewed(
    itemId: string,
    decision: {
      status: 'approved' | 'flagged' | 'rejected';
      reviewerId: string;
      notes?: string;
    }
  ): boolean {
    const item = this.asyncReviewQueue.find((i) => i.itemId === itemId);
    if (!item) return false;

    item.reviewStatus = decision.status;
    item.reviewerId = decision.reviewerId;
    item.reviewedAt = new Date();
    item.reviewNotes = decision.notes;

    return true;
  }

  /**
   * Clears reviewed items from the queue.
   */
  clearReviewedItems(): number {
    const initialLength = this.asyncReviewQueue.length;
    const pendingItems = this.asyncReviewQueue.filter(
      (item) => item.reviewStatus === 'pending'
    );
    this.asyncReviewQueue.length = 0;
    this.asyncReviewQueue.push(...pendingItems);
    this.stats.asyncReviewQueueSize = this.asyncReviewQueue.length;
    return initialLength - pendingItems.length;
  }

  /**
   * Gets authorization statistics.
   */
  getStatistics(): AuthorizationStatistics {
    return { ...this.stats };
  }

  /**
   * Resets statistics.
   */
  resetStatistics(): void {
    this.stats = {
      totalRequests: 0,
      requestsByTier: {
        [ToolRiskTier.TIER_1_AUTONOMOUS]: 0,
        [ToolRiskTier.TIER_2_ASYNC_REVIEW]: 0,
        [ToolRiskTier.TIER_3_SYNC_HITL]: 0,
      },
      authorizedCount: 0,
      deniedCount: 0,
      pendingHITLCount: 0,
      avgHITLResponseTimeMs: 0,
      asyncReviewQueueSize: this.asyncReviewQueue.length,
    };
    this.totalHITLTimeMs = 0;
    this.hitlRequestCount = 0;
  }

  /**
   * Gets the current configuration.
   */
  getConfig(): StepUpAuthorizationConfig {
    return { ...this.config };
  }
}
