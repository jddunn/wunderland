/**
 * @fileoverview Inference types for Wunderland
 * @module wunderland/inference/types
 */

import type { ModelTarget, InferenceHierarchyConfig } from '../core/types.js';
export type { RoutingDecision } from '../core/types.js';

/**
 * Input complexity classification.
 */
export type ComplexityLevel = 'simple' | 'moderate' | 'complex';

/**
 * Result of complexity analysis.
 */
export interface ComplexityAnalysis {
  /** Complexity level */
  level: ComplexityLevel;

  /** Confidence in the classification (0-1) */
  confidence: number;

  /** Reasons for the classification */
  reasons: string[];

  /** Estimated tokens needed */
  estimatedTokens: number;

  /** Whether tools are likely needed */
  requiresTools: boolean;

  /** Whether multi-turn reasoning is expected */
  requiresMultiTurn: boolean;
}

/**
 * Cost estimation for inference.
 */
export interface CostEstimate {
  /** Estimated input tokens */
  inputTokens: number;

  /** Estimated output tokens */
  outputTokens: number;

  /** Estimated cost in USD */
  costUSD: number;

  /** Model used for estimate */
  model: string;

  /** Cost tier */
  tier: 'low' | 'medium' | 'high';
}

/**
 * Routing prompt template.
 */
export interface RoutingPromptTemplate {
  /** Template name */
  name: string;

  /** System prompt for the router */
  systemPrompt: string;

  /** User prompt template (with {input} placeholder) */
  userPromptTemplate: string;

  /** Expected output schema */
  outputSchema: {
    type: 'json';
    properties: Record<string, unknown>;
  };
}

/**
 * Router configuration options.
 */
export interface RouterConfig {
  /** Inference hierarchy configuration */
  hierarchy: InferenceHierarchyConfig;

  /** Enable caching of routing decisions */
  enableCaching?: boolean;

  /** Cache TTL in milliseconds */
  cacheTTLMs?: number;

  /** Custom routing prompt template */
  routingPrompt?: RoutingPromptTemplate;

  /** Complexity threshold for routing to primary model */
  complexityThreshold?: number;

  /** Cost threshold for requiring approval */
  costApprovalThreshold?: number;

  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Model invocation result.
 */
export interface ModelInvocationResult {
  /** Response text */
  text: string;

  /** Model that was used */
  model: ModelTarget;

  /** Token usage */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  /** Latency in milliseconds */
  latencyMs: number;

  /** Whether the response was from cache */
  cached: boolean;
}

/**
 * Routing statistics.
 */
export interface RoutingStatistics {
  /** Total requests routed */
  totalRequests: number;

  /** Requests routed to router model */
  routerModelRequests: number;

  /** Requests routed to primary model */
  primaryModelRequests: number;

  /** Requests that used fallback */
  fallbackRequests: number;

  /** Average routing latency (ms) */
  avgRoutingLatencyMs: number;

  /** Cache hit rate (0-1) */
  cacheHitRate: number;

  /** Breakdown by complexity */
  complexityBreakdown: Record<ComplexityLevel, number>;
}
