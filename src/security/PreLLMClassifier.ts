/**
 * @fileoverview Pre-LLM Input Classifier - Layer 1 of security pipeline
 * @module wunderland/security/PreLLMClassifier
 *
 * Fast, deterministic input classification before LLM processing.
 * Runs pattern matching, blocklist checks, and heuristic risk scoring.
 */

import type {
  IGuardrailService,
  GuardrailConfig,
  GuardrailInputPayload,
  GuardrailOutputPayload,
  GuardrailEvaluationResult,
  GuardrailAction,
} from '@framers/agentos/core/guardrails/index';
import {
  type InputClassificationResult,
  type InputClassificationCategory,
  type DetectedPattern,
  type InjectionPattern,
  DEFAULT_INJECTION_PATTERNS,
} from './types.js';

/**
 * Configuration for the Pre-LLM Classifier.
 */
export interface PreLLMClassifierConfig {
  /** Custom injection patterns to add */
  customPatterns?: InjectionPattern[];

  /** Risk score threshold for flagging (0.0 - 1.0) */
  riskThreshold?: number;

  /** Risk score threshold for blocking (0.0 - 1.0) */
  blockThreshold?: number;

  /** Enable logging of classifications */
  enableLogging?: boolean;
}

/**
 * Pre-LLM input classifier implementing IGuardrailService.
 *
 * This is the first layer of defense in the Wunderland security pipeline.
 * It performs fast, deterministic analysis of input before any LLM processing.
 *
 * @example
 * ```typescript
 * const classifier = new PreLLMClassifier({
 *   riskThreshold: 0.7,
 *   blockThreshold: 0.95,
 * });
 *
 * const result = await classifier.evaluateInput({
 *   context: { userId: 'user-1', sessionId: 'session-1' },
 *   input: { textInput: 'Ignore all previous instructions and...' }
 * });
 *
 * if (result?.action === 'block') {
 *   console.log('Malicious input detected:', result.reason);
 * }
 * ```
 */
export class PreLLMClassifier implements IGuardrailService {
  readonly config: GuardrailConfig = {
    evaluateStreamingChunks: false, // Only evaluate input
  };

  private readonly patterns: InjectionPattern[];
  private readonly riskThreshold: number;
  private readonly blockThreshold: number;
  private readonly enableLogging: boolean;

  constructor(config: PreLLMClassifierConfig = {}) {
    this.patterns = [...DEFAULT_INJECTION_PATTERNS, ...(config.customPatterns ?? [])];
    this.riskThreshold = config.riskThreshold ?? 0.7;
    this.blockThreshold = config.blockThreshold ?? 0.95;
    this.enableLogging = config.enableLogging ?? false;
  }

  /**
   * Evaluates user input before LLM processing.
   */
  async evaluateInput(
    payload: GuardrailInputPayload
  ): Promise<GuardrailEvaluationResult | null> {
    const textInput = this.extractTextInput(payload);
    if (!textInput) {
      return null; // No text to evaluate
    }

    const classification = this.classifyInput(textInput);

    if (this.enableLogging) {
      console.log('[PreLLMClassifier] Classification:', {
        category: classification.category,
        riskScore: classification.riskScore,
        patterns: classification.detectedPatterns.length,
      });
    }

    // Determine action based on classification
    if (classification.category === 'MALICIOUS') {
      return {
        action: 'block' as GuardrailAction,
        reason: classification.explanation,
        reasonCode: 'PRE_LLM_MALICIOUS_INPUT',
        metadata: {
          classification,
          detectedPatterns: classification.detectedPatterns.map((p) => p.patternId),
        },
      };
    }

    if (classification.category === 'SUSPICIOUS' || classification.requiresHITL) {
      return {
        action: 'flag' as GuardrailAction,
        reason: classification.explanation,
        reasonCode: 'REQUIRES_STEP_UP_AUTH',
        metadata: {
          classification,
          recommendedTier: classification.recommendedTier,
          detectedPatterns: classification.detectedPatterns.map((p) => p.patternId),
        },
      };
    }

    // Safe input - allow through
    return null;
  }

  /**
   * Output evaluation not implemented for this classifier.
   */
  async evaluateOutput(
    _payload: GuardrailOutputPayload
  ): Promise<GuardrailEvaluationResult | null> {
    // Pre-LLM classifier only evaluates input
    return null;
  }

  /**
   * Classifies input text for security risks.
   */
  classifyInput(text: string): InputClassificationResult {
    const detectedPatterns = this.detectPatterns(text);
    const riskScore = this.calculateRiskScore(detectedPatterns, text);
    const category = this.determineCategory(riskScore);
    const requiresHITL = this.shouldRequireHITL(detectedPatterns, riskScore);

    return {
      category,
      riskScore,
      detectedPatterns,
      requiresHITL,
      recommendedTier: requiresHITL ? 3 : undefined,
      explanation: this.generateExplanation(category, detectedPatterns, riskScore),
    };
  }

  /**
   * Detects patterns in the input text.
   */
  private detectPatterns(text: string): DetectedPattern[] {
    const detected: DetectedPattern[] = [];

    for (const pattern of this.patterns) {
      const matches = text.matchAll(new RegExp(pattern.regex, 'gi'));

      for (const match of matches) {
        if (match.index === undefined) continue;

        detected.push({
          patternId: pattern.id,
          type: this.inferPatternType(pattern),
          matchedText: match[0],
          confidence: pattern.baseRiskScore,
          startIndex: match.index,
          endIndex: match.index + match[0].length,
        });
      }
    }

    return detected;
  }

  /**
   * Infers pattern type from pattern definition.
   */
  private inferPatternType(
    pattern: InjectionPattern
  ): DetectedPattern['type'] {
    if (pattern.id.includes('injection')) return 'injection';
    if (pattern.id.includes('jailbreak')) return 'jailbreak';
    if (pattern.id.includes('command')) return 'command';
    if (pattern.id.includes('sql')) return 'injection';
    return 'custom';
  }

  /**
   * Calculates overall risk score from detected patterns.
   */
  private calculateRiskScore(
    patterns: DetectedPattern[],
    text: string
  ): number {
    if (patterns.length === 0) {
      return this.calculateBaselineRisk(text);
    }

    // Combine pattern scores with diminishing returns
    const sortedScores = patterns
      .map((p) => p.confidence)
      .sort((a, b) => b - a);

    let combinedScore = sortedScores[0];
    for (let i = 1; i < sortedScores.length; i++) {
      // Each additional pattern adds diminishing risk
      combinedScore += sortedScores[i] * (1 - combinedScore) * 0.5;
    }

    // Add baseline risk from text characteristics
    const baselineRisk = this.calculateBaselineRisk(text);
    combinedScore = Math.max(combinedScore, baselineRisk);

    return Math.min(1.0, combinedScore);
  }

  /**
   * Calculates baseline risk from text characteristics.
   */
  private calculateBaselineRisk(text: string): number {
    let risk = 0;

    // Long inputs have slightly higher risk
    if (text.length > 5000) risk += 0.1;
    if (text.length > 10000) risk += 0.1;

    // Unusual character ratios
    const specialCharRatio =
      (text.match(/[^a-zA-Z0-9\s.,!?'"()-]/g)?.length ?? 0) / text.length;
    if (specialCharRatio > 0.3) risk += 0.2;

    // Contains code-like structures
    if (/function|class|import|export|require|eval|exec/i.test(text)) {
      risk += 0.1;
    }

    // Contains system-like keywords
    if (/system|admin|root|sudo|password|credentials/i.test(text)) {
      risk += 0.15;
    }

    return Math.min(0.5, risk); // Baseline risk capped at 0.5
  }

  /**
   * Determines category based on risk score.
   */
  private determineCategory(riskScore: number): InputClassificationCategory {
    if (riskScore >= this.blockThreshold) return 'MALICIOUS';
    if (riskScore >= this.riskThreshold) return 'SUSPICIOUS';
    if (riskScore >= 0.3) return 'REQUIRES_REVIEW';
    return 'SAFE';
  }

  /**
   * Determines if HITL review is required.
   */
  private shouldRequireHITL(
    patterns: DetectedPattern[],
    riskScore: number
  ): boolean {
    // High-risk patterns always require HITL
    const hasHighRiskPattern = patterns.some(
      (p) =>
        p.type === 'injection' ||
        p.type === 'jailbreak' ||
        p.confidence >= 0.8
    );

    return hasHighRiskPattern || riskScore >= this.riskThreshold;
  }

  /**
   * Generates human-readable explanation.
   */
  private generateExplanation(
    category: InputClassificationCategory,
    patterns: DetectedPattern[],
    riskScore: number
  ): string {
    if (category === 'SAFE') {
      return 'Input passed security screening.';
    }

    const patternTypes = [...new Set(patterns.map((p) => p.type))];
    const typeList = patternTypes.join(', ');

    if (category === 'MALICIOUS') {
      return `High-risk input detected. Patterns found: ${typeList}. Risk score: ${riskScore.toFixed(2)}.`;
    }

    if (category === 'SUSPICIOUS') {
      return `Suspicious patterns detected: ${typeList}. Risk score: ${riskScore.toFixed(2)}. Review recommended.`;
    }

    return `Minor concerns detected. Risk score: ${riskScore.toFixed(2)}.`;
  }

  /**
   * Extracts text input from payload.
   */
  private extractTextInput(payload: GuardrailInputPayload): string | null {
    const input = payload.input;

    // Handle different input formats
    if ('textInput' in input && typeof input.textInput === 'string') {
      return input.textInput;
    }

    if ('content' in input && typeof input.content === 'string') {
      return input.content;
    }

    return null;
  }

  /**
   * Adds a custom pattern at runtime.
   */
  addPattern(pattern: InjectionPattern): void {
    this.patterns.push(pattern);
  }

  /**
   * Removes a pattern by ID.
   */
  removePattern(patternId: string): boolean {
    const index = this.patterns.findIndex((p) => p.id === patternId);
    if (index >= 0) {
      this.patterns.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Gets all active patterns.
   */
  getPatterns(): readonly InjectionPattern[] {
    return this.patterns;
  }
}
