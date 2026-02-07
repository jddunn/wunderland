/**
 * @fileoverview Authorization types for Wunderland
 * @module wunderland/authorization/types
 */

import type { ToolRiskTier } from '../core/types.js';
export type { StepUpAuthorizationConfig, AuthorizationResult } from '../core/types.js';

/**
 * Tool execution context for authorization.
 */
export interface ToolExecutionContext {
  /** User ID */
  userId: string;

  /** Session ID */
  sessionId?: string;

  /** Tenant ID */
  tenantId?: string;

  /** GMI/Agent ID */
  gmiId?: string;

  /** Whether user has verified identity */
  userVerified?: boolean;

  /** Whether session is in trusted mode */
  sessionTrusted?: boolean;

  /** Whether emergency mode is active */
  emergencyMode?: boolean;

  /** Whether admin override is active */
  adminOverride?: boolean;

  /** Additional context */
  metadata?: Record<string, unknown>;
}

/**
 * Tool definition for authorization purposes.
 */
export interface AuthorizableTool {
  /** Tool identifier */
  id: string;

  /** Tool display name */
  displayName: string;

  /** Tool description */
  description?: string;

  /**
   * Optional tool category. This is treated as an opaque string because
   * AgentOS/extension tools use a wide variety of semantic categories
   * (e.g. "research", "media", "productivity").
   *
   * Step-up authorization can still apply category overrides for any string key.
   */
  category?: string;

  /** Whether the tool has side effects */
  hasSideEffects: boolean;

  /** Required capabilities */
  requiredCapabilities?: string[];
}

/**
 * Tool call request for authorization.
 */
export interface ToolCallRequest {
  /** Tool being called */
  tool: AuthorizableTool;

  /** Arguments passed to the tool */
  args: Record<string, unknown>;

  /** Execution context */
  context: ToolExecutionContext;

  /** Request timestamp */
  timestamp: Date;
}

/**
 * Tenant-specific risk overrides.
 */
export interface TenantRiskOverrides {
  /** Tenant ID */
  tenantId: string;

  /** Tool ID to tier overrides */
  toolOverrides: Map<string, ToolRiskTier>;

  /** Category to tier overrides */
  categoryOverrides: Map<string, ToolRiskTier>;

  /** Escalation trigger overrides */
  escalationOverrides?: Map<string, ToolRiskTier>;
}

/**
 * Async review queue item.
 */
export interface AsyncReviewItem {
  /** Unique item ID */
  itemId: string;

  /** Original tool call request */
  request: ToolCallRequest;

  /** Assigned risk tier */
  tier: ToolRiskTier;

  /** When the call was executed */
  executedAt: Date;

  /** Tool execution result (if any) */
  result?: unknown;

  /** Review status */
  reviewStatus: 'pending' | 'approved' | 'flagged' | 'rejected';

  /** Reviewer ID (if reviewed) */
  reviewerId?: string;

  /** Review timestamp (if reviewed) */
  reviewedAt?: Date;

  /** Review notes (if any) */
  reviewNotes?: string;
}

/**
 * Authorization manager statistics.
 */
export interface AuthorizationStatistics {
  /** Total authorization requests */
  totalRequests: number;

  /** Requests by tier */
  requestsByTier: Record<ToolRiskTier, number>;

  /** Authorized count */
  authorizedCount: number;

  /** Denied count */
  deniedCount: number;

  /** Pending HITL count */
  pendingHITLCount: number;

  /** Average HITL response time (ms) */
  avgHITLResponseTimeMs: number;

  /** Items in async review queue */
  asyncReviewQueueSize: number;
}

/**
 * HITL approval request (matches AgentOS PendingAction subset).
 */
export interface HITLApprovalRequest {
  /** Action ID */
  actionId: string;

  /** Human-readable description */
  description: string;

  /** Severity level */
  severity: 'low' | 'medium' | 'high' | 'critical';

  /** Action category (opaque string; used for display / routing) */
  category?: string;

  /** Agent ID */
  agentId: string;

  /** Context */
  context: Record<string, unknown>;

  /** Potential consequences */
  potentialConsequences?: string[];

  /** Whether reversible */
  reversible: boolean;

  /** Estimated cost */
  estimatedCost?: { amount: number; currency: string };

  /** Request timestamp */
  requestedAt: Date;

  /** Timeout in ms */
  timeoutMs?: number;
}

/**
 * HITL approval decision (matches AgentOS ApprovalDecision subset).
 */
export interface HITLApprovalDecision {
  /** Action ID */
  actionId: string;

  /** Whether approved */
  approved: boolean;

  /** Rejection reason */
  rejectionReason?: string;

  /** Who decided */
  decidedBy: string;

  /** Decision timestamp */
  decidedAt: Date;

  /** Additional feedback */
  feedback?: string;
}

/**
 * Callback type for HITL approval requests.
 */
export type HITLRequestCallback = (
  request: HITLApprovalRequest
) => Promise<HITLApprovalDecision>;
