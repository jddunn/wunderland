/**
 * @fileoverview Hierarchical Inference Router for Wunderland
 * @module wunderland/inference/HierarchicalInferenceRouter
 *
 * Routes requests between fast router model (e.g., llama3.2:3b) and
 * primary model (e.g., dolphin-llama3:8b) based on complexity analysis.
 */

import type {
  InferenceHierarchyConfig,
  ModelTarget,
  RoutingDecision,
} from '../core/types.js';
import {
  DEFAULT_INFERENCE_HIERARCHY,
} from '../core/types.js';
import type {
  RouterConfig,
  ComplexityAnalysis,
  ComplexityLevel,
  CostEstimate,
  RoutingStatistics,
} from './types.js';

/**
 * Default routing system prompt.
 */
const DEFAULT_ROUTING_SYSTEM_PROMPT = `You are a request router for an AI assistant. Your job is to analyze user requests and determine their complexity.

Classify requests as:
- "simple": Basic questions, greetings, simple lookups, clarifications
- "moderate": Multi-step tasks, code review, summarization, analysis
- "complex": Creative writing, complex reasoning, code generation, research

Respond with JSON: {"complexity": "simple|moderate|complex", "reasoning": "brief explanation", "requiresTools": true/false}`;

/**
 * Simple in-memory cache for routing decisions.
 */
class RoutingCache {
  private cache = new Map<string, { decision: RoutingDecision; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 60000) {
    this.ttlMs = ttlMs;
  }

  get(key: string): RoutingDecision | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.decision;
  }

  set(key: string, decision: RoutingDecision): void {
    this.cache.set(key, {
      decision,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Hierarchical Inference Router for Wunderland.
 *
 * Routes requests to appropriate models based on complexity:
 * - Simple queries → Router model (fast, cheap)
 * - Complex queries → Primary model (powerful, slower)
 * - Audit operations → Auditor model (separate from primary)
 *
 * @example
 * ```typescript
 * const router = new HierarchicalInferenceRouter({
 *   hierarchy: {
 *     routerModel: { providerId: 'ollama', modelId: 'llama3.2:3b', role: 'router' },
 *     primaryModel: { providerId: 'ollama', modelId: 'dolphin-llama3:8b', role: 'primary' },
 *     auditorModel: { providerId: 'ollama', modelId: 'llama3.2:3b', role: 'auditor' },
 *   },
 * }, invokeModel);
 *
 * const decision = await router.route('Write a poem about AI');
 * console.log(decision.targetModel.modelId); // 'dolphin-llama3:8b'
 * ```
 */
export class HierarchicalInferenceRouter {
  private readonly config: RouterConfig;
  private readonly hierarchy: InferenceHierarchyConfig;
  private readonly cache: RoutingCache | null;
  private readonly invokeModel?: (
    model: ModelTarget,
    prompt: string,
    systemPrompt?: string
  ) => Promise<string>;

  // Statistics
  private stats: RoutingStatistics = {
    totalRequests: 0,
    routerModelRequests: 0,
    primaryModelRequests: 0,
    fallbackRequests: 0,
    avgRoutingLatencyMs: 0,
    cacheHitRate: 0,
    complexityBreakdown: { simple: 0, moderate: 0, complex: 0 },
  };
  private cacheHits = 0;
  private totalLatencyMs = 0;

  constructor(
    config: Partial<RouterConfig> = {},
    invokeModel?: (model: ModelTarget, prompt: string, systemPrompt?: string) => Promise<string>
  ) {
    this.hierarchy = config.hierarchy ?? DEFAULT_INFERENCE_HIERARCHY;
    this.config = {
      hierarchy: this.hierarchy,
      enableCaching: config.enableCaching ?? true,
      cacheTTLMs: config.cacheTTLMs ?? 60000,
      complexityThreshold: config.complexityThreshold ?? 0.5,
      costApprovalThreshold: config.costApprovalThreshold ?? 0.1,
      debug: config.debug ?? false,
    };

    this.cache = this.config.enableCaching
      ? new RoutingCache(this.config.cacheTTLMs)
      : null;

    this.invokeModel = invokeModel;
  }

  /**
   * Routes a request to the appropriate model.
   */
  async route(input: string): Promise<RoutingDecision> {
    const startTime = Date.now();
    this.stats.totalRequests++;

    // Check cache first
    const cacheKey = this.generateCacheKey(input);
    if (this.cache) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.cacheHits++;
        this.updateStats(startTime, cached);
        if (this.config.debug) {
          console.log('[Router] Cache hit for:', input.substring(0, 50));
        }
        return cached;
      }
    }

    // Analyze complexity
    const analysis = await this.analyzeComplexity(input);

    // Make routing decision
    const decision = this.makeRoutingDecision(analysis, input);

    // Cache the decision
    if (this.cache) {
      this.cache.set(cacheKey, decision);
    }

    this.updateStats(startTime, decision);

    if (this.config.debug) {
      console.log('[Router] Decision:', {
        input: input.substring(0, 50),
        complexity: analysis.level,
        target: decision.targetModel.modelId,
        confidence: decision.confidence,
      });
    }

    return decision;
  }

  /**
   * Analyzes the complexity of an input.
   */
  async analyzeComplexity(input: string): Promise<ComplexityAnalysis> {
    // Try LLM-based analysis first
    if (this.invokeModel) {
      try {
        const analysis = await this.llmComplexityAnalysis(input);
        return analysis;
      } catch (error) {
        if (this.config.debug) {
          console.warn('[Router] LLM analysis failed, using heuristic:', error);
        }
      }
    }

    // Fallback to heuristic analysis
    return this.heuristicComplexityAnalysis(input);
  }

  /**
   * LLM-based complexity analysis using the router model.
   */
  private async llmComplexityAnalysis(input: string): Promise<ComplexityAnalysis> {
    const prompt = `Analyze this request:\n\n${input}`;
    const systemPrompt = this.config.routingPrompt?.systemPrompt ?? DEFAULT_ROUTING_SYSTEM_PROMPT;

    const response = await this.invokeModel!(
      this.hierarchy.routerModel,
      prompt,
      systemPrompt
    );

    // Parse JSON response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const level = this.normalizeComplexity(parsed.complexity);

    return {
      level,
      confidence: 0.85,
      reasons: [parsed.reasoning ?? 'LLM classification'],
      estimatedTokens: this.estimateTokens(input, level),
      requiresTools: Boolean(parsed.requiresTools),
      requiresMultiTurn: level === 'complex',
    };
  }

  /**
   * Heuristic-based complexity analysis.
   */
  private heuristicComplexityAnalysis(input: string): ComplexityAnalysis {
    const reasons: string[] = [];
    let score = 0;

    // Length analysis
    const wordCount = input.split(/\s+/).length;
    if (wordCount < 10) {
      reasons.push('Short input');
    } else if (wordCount > 100) {
      score += 0.3;
      reasons.push('Long input');
    }

    // Question patterns
    if (/^(hi|hello|hey|thanks|thank you)/i.test(input)) {
      reasons.push('Greeting/closing');
    } else if (/^(what|who|when|where|why|how)\s/i.test(input)) {
      score += 0.1;
      reasons.push('Question format');
    }

    // Complex task indicators
    const complexIndicators = [
      { pattern: /write\s+(a\s+)?(poem|story|essay|article|blog)/i, weight: 0.4, reason: 'Creative writing' },
      { pattern: /create\s+(a\s+)?(function|class|component|api|app)/i, weight: 0.4, reason: 'Code generation' },
      { pattern: /analyze|compare|contrast|evaluate/i, weight: 0.3, reason: 'Analysis task' },
      { pattern: /implement|build|develop|design/i, weight: 0.3, reason: 'Implementation task' },
      { pattern: /explain\s+(in\s+detail|thoroughly|step\s+by\s+step)/i, weight: 0.2, reason: 'Detailed explanation' },
      { pattern: /refactor|optimize|improve/i, weight: 0.3, reason: 'Code optimization' },
      { pattern: /debug|fix|solve/i, weight: 0.2, reason: 'Problem solving' },
    ];

    for (const { pattern, weight, reason } of complexIndicators) {
      if (pattern.test(input)) {
        score += weight;
        reasons.push(reason);
      }
    }

    // Code detection
    if (/```|function\s+\w+|class\s+\w+|import\s+\w+|const\s+\w+\s*=/i.test(input)) {
      score += 0.2;
      reasons.push('Contains code');
    }

    // Tool indicators
    const requiresTools = /search|look\s*up|find|fetch|calculate|run|execute/i.test(input);
    if (requiresTools) {
      score += 0.1;
      reasons.push('May require tools');
    }

    // Determine level
    let level: ComplexityLevel;
    if (score < 0.2) {
      level = 'simple';
    } else if (score < 0.5) {
      level = 'moderate';
    } else {
      level = 'complex';
    }

    return {
      level,
      confidence: 0.7,
      reasons: reasons.length > 0 ? reasons : ['Default classification'],
      estimatedTokens: this.estimateTokens(input, level),
      requiresTools,
      requiresMultiTurn: level === 'complex',
    };
  }

  /**
   * Makes the final routing decision based on complexity analysis.
   */
  private makeRoutingDecision(
    analysis: ComplexityAnalysis,
    _input: string
  ): RoutingDecision {
    let targetModel: ModelTarget;
    let routingReason: string;

    if (analysis.level === 'simple') {
      targetModel = this.hierarchy.routerModel;
      routingReason = 'Simple query - using fast router model';
      this.stats.routerModelRequests++;
    } else if (analysis.level === 'moderate') {
      // Moderate complexity - use primary but might not need full power
      targetModel = this.hierarchy.primaryModel;
      routingReason = 'Moderate complexity - using primary model';
      this.stats.primaryModelRequests++;
    } else {
      targetModel = this.hierarchy.primaryModel;
      routingReason = 'Complex query - using primary model with full context';
      this.stats.primaryModelRequests++;
    }

    const costEstimate = this.estimateCost(analysis.estimatedTokens, targetModel);

    return {
      targetModel,
      routingReason,
      complexity: analysis.level,
      estimatedCost: costEstimate.costUSD,
      requiresAudit: analysis.level !== 'simple' || analysis.requiresTools,
      confidence: analysis.confidence,
    };
  }

  /**
   * Normalizes complexity string to valid level.
   */
  private normalizeComplexity(complexity: string): ComplexityLevel {
    const lower = complexity?.toLowerCase();
    if (lower === 'simple' || lower === 'easy' || lower === 'basic') {
      return 'simple';
    }
    if (lower === 'moderate' || lower === 'medium' || lower === 'intermediate') {
      return 'moderate';
    }
    return 'complex';
  }

  /**
   * Estimates token count for a request.
   */
  private estimateTokens(input: string, complexity: ComplexityLevel): number {
    const inputTokens = Math.ceil(input.length / 4); // Rough estimate

    const outputMultipliers: Record<ComplexityLevel, number> = {
      simple: 0.5,
      moderate: 1.5,
      complex: 3,
    };

    const estimatedOutput = inputTokens * outputMultipliers[complexity];
    return inputTokens + Math.ceil(estimatedOutput);
  }

  /**
   * Estimates cost for inference.
   */
  private estimateCost(tokens: number, model: ModelTarget): CostEstimate {
    // Cost estimates per 1K tokens (approximate for local models)
    const costPerKToken: Record<string, number> = {
      'llama3.2:3b': 0.00001,
      'dolphin-llama3:8b': 0.00005,
      'gpt-4': 0.03,
      'claude-3': 0.015,
    };

    const costRate = costPerKToken[model.modelId] ?? 0.0001;
    const costUSD = (tokens / 1000) * costRate;

    let tier: CostEstimate['tier'] = 'low';
    if (costUSD > 0.01) tier = 'high';
    else if (costUSD > 0.001) tier = 'medium';

    return {
      inputTokens: Math.ceil(tokens * 0.4),
      outputTokens: Math.ceil(tokens * 0.6),
      costUSD,
      model: model.modelId,
      tier,
    };
  }

  /**
   * Generates a cache key for the input.
   */
  private generateCacheKey(input: string): string {
    // Simple hash based on normalized input
    const normalized = input.toLowerCase().trim().substring(0, 200);
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `route_${hash}`;
  }

  /**
   * Updates routing statistics.
   */
  private updateStats(startTime: number, decision: RoutingDecision): void {
    const latency = Date.now() - startTime;
    this.totalLatencyMs += latency;
    this.stats.avgRoutingLatencyMs = this.totalLatencyMs / this.stats.totalRequests;
    this.stats.cacheHitRate = this.cacheHits / this.stats.totalRequests;
    this.stats.complexityBreakdown[decision.complexity]++;
  }

  /**
   * Gets the current routing statistics.
   */
  getStatistics(): RoutingStatistics {
    return { ...this.stats };
  }

  /**
   * Resets statistics.
   */
  resetStatistics(): void {
    this.stats = {
      totalRequests: 0,
      routerModelRequests: 0,
      primaryModelRequests: 0,
      fallbackRequests: 0,
      avgRoutingLatencyMs: 0,
      cacheHitRate: 0,
      complexityBreakdown: { simple: 0, moderate: 0, complex: 0 },
    };
    this.cacheHits = 0;
    this.totalLatencyMs = 0;
  }

  /**
   * Clears the routing cache.
   */
  clearCache(): void {
    this.cache?.clear();
  }

  /**
   * Gets the current hierarchy configuration.
   */
  getHierarchy(): InferenceHierarchyConfig {
    return { ...this.hierarchy };
  }

  /**
   * Updates the hierarchy configuration.
   */
  updateHierarchy(updates: Partial<InferenceHierarchyConfig>): void {
    Object.assign(this.hierarchy, updates);
    this.clearCache(); // Invalidate cache on config change
  }
}
