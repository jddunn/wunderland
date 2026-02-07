/**
 * @fileoverview Dual-LLM Auditor - Layer 2 of security pipeline
 * @module wunderland/security/DualLLMAuditor
 *
 * Uses a fast auditor model (e.g., llama3.2:3b) to validate outputs
 * from the primary model (e.g., dolphin-llama3:8b) for safety and intent alignment.
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
  type AuditResult,
  type AuditFlag,
  type DualLLMAuditorConfig,
} from './types.js';

/**
 * Default audit prompt template.
 */
const DEFAULT_AUDIT_PROMPT = `You are a security auditor for an AI assistant. Your job is to verify that the assistant's response is safe and appropriate.

ORIGINAL USER REQUEST:
{userRequest}

ASSISTANT'S RESPONSE:
{assistantResponse}

Evaluate whether the response:
1. Directly addresses the user's request (intent alignment)
2. Does not contain harmful, illegal, or unethical content
3. Does not leak sensitive system information
4. Does not attempt to manipulate or deceive the user
5. Is factually consistent (no obvious hallucinations)

Respond in JSON format:
{
  "passed": true/false,
  "severity": "none" | "low" | "medium" | "high" | "critical",
  "flags": [
    {
      "type": "intent_mismatch" | "safety_concern" | "policy_violation" | "hallucination" | "data_leak",
      "description": "brief description",
      "severity": "low" | "medium" | "high" | "critical"
    }
  ],
  "explanation": "brief explanation of audit result"
}`;

/**
 * Dual-LLM Auditor implementing IGuardrailService.
 *
 * This is the second layer of defense in the Wunderland security pipeline.
 * It uses a separate, fast model to audit outputs from the primary model.
 *
 * Key benefits:
 * - Uncensored primary models can be audited by a more constrained model
 * - Fast 3B model provides real-time audit without significant latency
 * - Independent evaluation prevents prompt injection from compromising both models
 *
 * @example
 * ```typescript
 * const auditor = new DualLLMAuditor({
 *   auditorProviderId: 'ollama',
 *   auditorModelId: 'llama3.2:3b',
 *   evaluateStreamingChunks: true,
 * }, providerManager);
 *
 * // Register as a guardrail
 * orchestrator.registerGuardrail(auditor);
 * ```
 */
export class DualLLMAuditor implements IGuardrailService {
  readonly config: GuardrailConfig;

  private readonly auditorConfig: DualLLMAuditorConfig;
  private readonly promptTemplate: string;
  private evaluationCount = 0;
  private lastUserRequest = '';

  // Provider manager would be injected in real implementation
  // For now, we'll provide a callback-based approach
  private readonly invokeAuditor?: (prompt: string) => Promise<string>;

  constructor(
    config: Partial<DualLLMAuditorConfig> = {},
    invokeAuditor?: (prompt: string) => Promise<string>
  ) {
    this.auditorConfig = {
      auditorProviderId: config.auditorProviderId ?? 'ollama',
      auditorModelId: config.auditorModelId ?? 'llama3.2:3b',
      maxAuditTokens: config.maxAuditTokens ?? 256,
      auditTemperature: config.auditTemperature ?? 0.0,
      evaluateStreamingChunks: config.evaluateStreamingChunks ?? true,
      maxStreamingEvaluations: config.maxStreamingEvaluations,
      auditPromptTemplate: config.auditPromptTemplate,
    };

    this.config = {
      evaluateStreamingChunks: this.auditorConfig.evaluateStreamingChunks,
      maxStreamingEvaluations: this.auditorConfig.maxStreamingEvaluations,
    };

    this.promptTemplate = this.auditorConfig.auditPromptTemplate ?? DEFAULT_AUDIT_PROMPT;
    this.invokeAuditor = invokeAuditor;
  }

  /**
   * Captures the user request for context in output evaluation.
   */
  async evaluateInput(
    payload: GuardrailInputPayload
  ): Promise<GuardrailEvaluationResult | null> {
    // Capture the user request for later audit context
    const textInput = this.extractTextInput(payload);
    if (textInput) {
      this.lastUserRequest = textInput;
      this.evaluationCount = 0; // Reset for new request
    }
    return null; // Don't block input at this layer
  }

  /**
   * Audits output chunks from the primary model.
   */
  async evaluateOutput(
    payload: GuardrailOutputPayload
  ): Promise<GuardrailEvaluationResult | null> {
    // Check evaluation limits
    if (
      this.auditorConfig.maxStreamingEvaluations &&
      this.evaluationCount >= this.auditorConfig.maxStreamingEvaluations
    ) {
      return null; // Limit reached
    }

    const outputText = this.extractOutputText(payload);
    if (!outputText) {
      return null;
    }

    this.evaluationCount++;

    // Perform the audit
    const auditResult = await this.performAudit(this.lastUserRequest, outputText);

    // Determine action based on audit
    if (!auditResult.passed) {
      if (auditResult.severity === 'critical' || auditResult.severity === 'high') {
        return {
          action: 'block' as GuardrailAction,
          reason: auditResult.explanation,
          reasonCode: 'DUAL_LLM_AUDIT_BLOCKED',
          metadata: {
            auditResult,
            flags: auditResult.flags,
            auditorModel: this.auditorConfig.auditorModelId,
          },
        };
      }

      // Flag for review but allow through
      return {
        action: 'flag' as GuardrailAction,
        reason: auditResult.explanation,
        reasonCode: 'DUAL_LLM_AUDIT_FLAG',
        metadata: {
          auditResult,
          flags: auditResult.flags,
          auditorModel: this.auditorConfig.auditorModelId,
        },
      };
    }

    return null; // Passed audit
  }

  /**
   * Performs the actual audit using the auditor model.
   */
  async performAudit(userRequest: string, assistantResponse: string): Promise<AuditResult> {
    const startTime = Date.now();

    // Build audit prompt
    const prompt = this.promptTemplate
      .replace('{userRequest}', userRequest)
      .replace('{assistantResponse}', assistantResponse);

    try {
      let auditResponse: string;

      if (this.invokeAuditor) {
        // Use provided callback
        auditResponse = await this.invokeAuditor(prompt);
      } else {
        // Fallback to heuristic-based audit if no LLM available
        return this.performHeuristicAudit(userRequest, assistantResponse, startTime);
      }

      // Parse the JSON response
      const parsed = this.parseAuditResponse(auditResponse);

      return {
        passed: parsed.passed,
        severity: parsed.severity,
        flags: parsed.flags,
        explanation: parsed.explanation,
        confidence: 0.9, // LLM-based audit has high confidence
        auditorModel: this.auditorConfig.auditorModelId,
        auditTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      // Fallback to heuristic if LLM fails
      console.error('[DualLLMAuditor] LLM audit failed, using heuristic:', error);
      return this.performHeuristicAudit(userRequest, assistantResponse, startTime);
    }
  }

  /**
   * Performs heuristic-based audit when LLM is unavailable.
   */
  private performHeuristicAudit(
    userRequest: string,
    assistantResponse: string,
    startTime: number
  ): AuditResult {
    const flags: AuditFlag[] = [];

    // Check for obvious safety concerns
    const safetyPatterns = [
      { pattern: /how\s+to\s+(make|create|build)\s+(a\s+)?(bomb|weapon|explosive)/i, desc: 'Harmful content detected' },
      { pattern: /\b(kill|murder|assassinate)\s+(someone|people|yourself)/i, desc: 'Violence-related content' },
      { pattern: /hack(ing)?\s+(into|a)\s+(bank|government|system)/i, desc: 'Illegal activity guidance' },
    ];

    for (const { pattern, desc } of safetyPatterns) {
      if (pattern.test(assistantResponse)) {
        flags.push({
          flagId: `heuristic_${Date.now()}`,
          type: 'safety_concern',
          description: desc,
          severity: 'high',
          relevantText: assistantResponse.match(pattern)?.[0],
        });
      }
    }

    // Check for potential data leaks
    if (/system\s+prompt|my\s+instructions|i\s+was\s+told\s+to/i.test(assistantResponse)) {
      flags.push({
        flagId: `leak_${Date.now()}`,
        type: 'data_leak',
        description: 'Potential system prompt leak',
        severity: 'medium',
      });
    }

    // Check for intent alignment (basic)
    const requestKeywords = userRequest.toLowerCase().split(/\s+/).slice(0, 10);
    const responseKeywords = assistantResponse.toLowerCase().split(/\s+/).slice(0, 50);
    const overlap = requestKeywords.filter((k) =>
      responseKeywords.some((r) => r.includes(k) || k.includes(r))
    ).length;

    if (overlap < 2 && userRequest.length > 10) {
      flags.push({
        flagId: `intent_${Date.now()}`,
        type: 'intent_mismatch',
        description: 'Response may not address user request',
        severity: 'low',
      });
    }

    const maxSeverity = flags.reduce(
      (max, f) => {
        const severityOrder = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
        return severityOrder[f.severity] > severityOrder[max] ? f.severity : max;
      },
      'none' as AuditResult['severity']
    );

    return {
      passed: flags.filter((f) => f.severity === 'high' || f.severity === 'critical').length === 0,
      severity: maxSeverity,
      flags,
      explanation: flags.length > 0
        ? `Heuristic audit found ${flags.length} concern(s).`
        : 'Heuristic audit passed.',
      confidence: 0.6, // Lower confidence for heuristic
      auditorModel: 'heuristic',
      auditTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Parses the JSON response from the auditor model.
   */
  private parseAuditResponse(response: string): {
    passed: boolean;
    severity: AuditResult['severity'];
    flags: AuditFlag[];
    explanation: string;
  } {
    try {
      // Extract JSON from response (may have surrounding text)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        passed: Boolean(parsed.passed),
        severity: parsed.severity ?? 'none',
        flags: (parsed.flags ?? []).map((f: Record<string, unknown>, i: number) => ({
          flagId: `audit_${Date.now()}_${i}`,
          type: f.type ?? 'custom',
          description: f.description ?? 'Unknown issue',
          severity: f.severity ?? 'low',
          relevantText: f.relevantText,
        })),
        explanation: parsed.explanation ?? 'Audit completed.',
      };
    } catch {
      // Fallback if JSON parsing fails
      return {
        passed: true,
        severity: 'none',
        flags: [],
        explanation: 'Could not parse audit response. Assuming safe.',
      };
    }
  }

  /**
   * Extracts text input from payload.
   */
  private extractTextInput(payload: GuardrailInputPayload): string | null {
    const input = payload.input;
    if ('textInput' in input && typeof input.textInput === 'string') {
      return input.textInput;
    }
    if ('content' in input && typeof input.content === 'string') {
      return input.content;
    }
    return null;
  }

  /**
   * Extracts output text from payload.
   */
  private extractOutputText(payload: GuardrailOutputPayload): string | null {
    const chunk = payload.chunk;

    // Handle different chunk types
    if ('textDelta' in chunk && typeof chunk.textDelta === 'string') {
      return chunk.textDelta;
    }
    if ('finalResponseText' in chunk && typeof chunk.finalResponseText === 'string') {
      return chunk.finalResponseText;
    }
    if ('text' in chunk && typeof chunk.text === 'string') {
      return chunk.text;
    }

    return null;
  }

  /**
   * Resets the evaluation count (call at start of new request).
   */
  resetEvaluationCount(): void {
    this.evaluationCount = 0;
    this.lastUserRequest = '';
  }

  /**
   * Gets the current auditor configuration.
   */
  getConfig(): DualLLMAuditorConfig {
    return { ...this.auditorConfig };
  }
}
