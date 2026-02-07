/**
 * @fileoverview Wunderland Security Pipeline - Orchestrates all security layers
 * @module wunderland/security/WunderlandSecurityPipeline
 *
 * Combines Pre-LLM Classification, Dual-LLM Audit, and Output Signing
 * into a unified security pipeline.
 */

import type {
  IGuardrailService,
  GuardrailConfig,
  GuardrailInputPayload,
  GuardrailOutputPayload,
  GuardrailEvaluationResult,
} from '@framers/agentos/core/guardrails/index';
import { PreLLMClassifier } from './PreLLMClassifier.js';
import { DualLLMAuditor } from './DualLLMAuditor.js';
import { SignedOutputVerifier, IntentChainTracker } from './SignedOutputVerifier.js';
import {
  type SecurityPipelineConfig,
} from './types.js';
import type { SignedAgentOutput, IntentChainEntry } from '../core/types.js';

/**
 * Wunderland Security Pipeline - Unified security guardrail.
 *
 * Orchestrates the three-layer security model:
 * 1. Pre-LLM Classifier: Fast pattern-based input screening
 * 2. Dual-LLM Auditor: AI-based output verification
 * 3. Signed Output Verifier: Cryptographic audit trail
 *
 * @example
 * ```typescript
 * const pipeline = new WunderlandSecurityPipeline({
 *   enablePreLLM: true,
 *   enableDualLLMAudit: true,
 *   enableOutputSigning: true,
 *   classifierConfig: { riskThreshold: 0.7 },
 * });
 *
 * // Use as a guardrail service
 * orchestrator.registerGuardrail(pipeline);
 *
 * // Or evaluate directly
 * const result = await pipeline.evaluateInput(payload);
 * if (result?.action === 'block') {
 *   // Handle blocked input
 * }
 * ```
 */
export class WunderlandSecurityPipeline implements IGuardrailService {
  readonly config: GuardrailConfig;

  private readonly pipelineConfig: SecurityPipelineConfig;
  private readonly classifier: PreLLMClassifier | null;
  private readonly auditor: DualLLMAuditor | null;
  private readonly verifier: SignedOutputVerifier | null;
  private readonly intentTracker: IntentChainTracker;

  private currentSeedId: string = 'unknown';

  constructor(
    config: Partial<SecurityPipelineConfig> = {},
    auditorInvoker?: (prompt: string) => Promise<string>
  ) {
    this.pipelineConfig = {
      enablePreLLM: config.enablePreLLM ?? true,
      enableDualLLMAudit: config.enableDualLLMAudit ?? true,
      enableOutputSigning: config.enableOutputSigning ?? true,
      classifierConfig: config.classifierConfig,
      auditorConfig: config.auditorConfig,
      signingConfig: config.signingConfig,
    };

    // Initialize enabled components
    this.classifier = this.pipelineConfig.enablePreLLM
      ? new PreLLMClassifier(this.pipelineConfig.classifierConfig)
      : null;

    this.auditor = this.pipelineConfig.enableDualLLMAudit
      ? new DualLLMAuditor(this.pipelineConfig.auditorConfig, auditorInvoker)
      : null;

    this.verifier = this.pipelineConfig.enableOutputSigning
      ? new SignedOutputVerifier(this.pipelineConfig.signingConfig)
      : null;

    this.intentTracker = new IntentChainTracker(
      this.pipelineConfig.signingConfig?.maxIntentChainEntries ?? 100
    );

    // Configure guardrail behavior
    this.config = {
      evaluateStreamingChunks: this.pipelineConfig.enableDualLLMAudit,
      maxStreamingEvaluations: this.pipelineConfig.auditorConfig?.maxStreamingEvaluations,
    };
  }

  /**
   * Sets the current seed ID for output signing.
   */
  setSeedId(seedId: string): void {
    this.currentSeedId = seedId;
  }

  /**
   * Evaluates input through the security pipeline.
   */
  async evaluateInput(
    payload: GuardrailInputPayload
  ): Promise<GuardrailEvaluationResult | null> {
    // Track input in intent chain
    const inputText = this.extractTextInput(payload);
    if (inputText) {
      this.intentTracker.addEntry({
        action: 'USER_INPUT',
        inputHash: this.verifier?.hash(inputText) ?? '',
        outputHash: '',
        modelUsed: 'input',
        securityFlags: [],
      });
    }

    // Layer 1: Pre-LLM Classification
    if (this.classifier) {
      const classifierResult = await this.classifier.evaluateInput(payload);

      if (classifierResult) {
        // Track in intent chain
        this.intentTracker.addEntry({
          action: 'PRE_LLM_CLASSIFICATION',
          inputHash: this.verifier?.hash(inputText ?? '') ?? '',
          outputHash: this.verifier?.hash(classifierResult) ?? '',
          modelUsed: 'pattern_classifier',
          securityFlags: classifierResult.action === 'block'
            ? ['BLOCKED_BY_CLASSIFIER']
            : classifierResult.action === 'flag'
            ? ['FLAGGED_BY_CLASSIFIER']
            : [],
          metadata: classifierResult.metadata,
        });

        if (classifierResult.action === 'block') {
          return classifierResult;
        }

        // If flagged, pass through but record it
        if (classifierResult.action === 'flag') {
          // Return flag result to let orchestrator handle step-up auth
          return classifierResult;
        }
      }
    }

    // Pass auditor the input context
    if (this.auditor) {
      await this.auditor.evaluateInput(payload);
    }

    return null; // Input allowed
  }

  /**
   * Evaluates output through the security pipeline.
   */
  async evaluateOutput(
    payload: GuardrailOutputPayload
  ): Promise<GuardrailEvaluationResult | null> {
    const outputText = this.extractOutputText(payload);
    if (!outputText) {
      return null;
    }

    // Layer 2: Dual-LLM Audit
    if (this.auditor) {
      const auditResult = await this.auditor.evaluateOutput(payload);

      // Track in intent chain
      this.intentTracker.addEntry({
        action: 'DUAL_LLM_AUDIT',
        inputHash: this.verifier?.hash(outputText) ?? '',
        outputHash: this.verifier?.hash(auditResult ?? 'passed') ?? '',
        modelUsed: this.pipelineConfig.auditorConfig?.auditorModelId ?? 'auditor',
        securityFlags: auditResult?.action === 'block'
          ? ['BLOCKED_BY_AUDITOR']
          : auditResult?.action === 'flag'
          ? ['FLAGGED_BY_AUDITOR']
          : [],
        metadata: auditResult?.metadata,
      });

      if (auditResult) {
        return auditResult;
      }
    }

    return null; // Output allowed
  }

  /**
   * Signs the final output with full intent chain.
   * Call this after the response is complete.
   */
  signOutput(content: unknown): SignedAgentOutput | null {
    if (!this.verifier) {
      return null;
    }

    // Add final output to intent chain
    this.intentTracker.addEntry({
      action: 'FINAL_OUTPUT',
      inputHash: '',
      outputHash: this.verifier.hash(content as string | object),
      modelUsed: 'output',
      securityFlags: [],
    });

    return this.verifier.sign(
      content,
      this.intentTracker.getEntries(),
      { seedId: this.currentSeedId }
    );
  }

  /**
   * Verifies a previously signed output.
   */
  verifyOutput(signedOutput: SignedAgentOutput): boolean {
    if (!this.verifier) {
      return false;
    }
    return this.verifier.verify(signedOutput);
  }

  /**
   * Resets the pipeline state for a new request.
   */
  reset(): void {
    this.intentTracker.clear();
    this.auditor?.resetEvaluationCount();
  }

  /**
   * Gets the current intent chain.
   */
  getIntentChain(): readonly IntentChainEntry[] {
    return this.intentTracker.getEntries();
  }

  /**
   * Gets a summary of the current intent chain.
   */
  getIntentChainSummary(): ReturnType<SignedOutputVerifier['summarizeIntentChain']> | null {
    if (!this.verifier) {
      return null;
    }
    return this.verifier.summarizeIntentChain(this.intentTracker.getEntries());
  }

  /**
   * Manually adds an entry to the intent chain.
   * Useful for tracking custom actions.
   */
  trackAction(
    action: string,
    inputHash: string,
    outputHash: string,
    modelUsed: string,
    securityFlags: string[] = [],
    metadata?: Record<string, unknown>
  ): IntentChainEntry {
    return this.intentTracker.addEntry({
      action,
      inputHash,
      outputHash,
      modelUsed,
      securityFlags,
      metadata,
    });
  }

  /**
   * Checks if the current request has any security flags.
   */
  hasSecurityFlags(): boolean {
    return this.intentTracker.hasSecurityFlags();
  }

  /**
   * Gets all security flags from the current request.
   */
  getAllSecurityFlags(): string[] {
    return this.intentTracker.getAllSecurityFlags();
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
   * Gets the pipeline configuration.
   */
  getPipelineConfig(): SecurityPipelineConfig {
    return { ...this.pipelineConfig };
  }

  /**
   * Gets individual component instances (for advanced usage).
   */
  getComponents(): {
    classifier: PreLLMClassifier | null;
    auditor: DualLLMAuditor | null;
    verifier: SignedOutputVerifier | null;
    intentTracker: IntentChainTracker;
  } {
    return {
      classifier: this.classifier,
      auditor: this.auditor,
      verifier: this.verifier,
      intentTracker: this.intentTracker,
    };
  }
}

/**
 * Creates a security pipeline with default production settings.
 */
export function createProductionSecurityPipeline(
  auditorInvoker?: (prompt: string) => Promise<string>
): WunderlandSecurityPipeline {
  return new WunderlandSecurityPipeline(
    {
      enablePreLLM: true,
      enableDualLLMAudit: true,
      enableOutputSigning: true,
      classifierConfig: {
        riskThreshold: 0.7,
      },
      auditorConfig: {
        evaluateStreamingChunks: true,
        maxStreamingEvaluations: 50,
        auditTemperature: 0.0,
      },
    },
    auditorInvoker
  );
}

/**
 * Creates a lightweight security pipeline for development.
 */
export function createDevelopmentSecurityPipeline(): WunderlandSecurityPipeline {
  return new WunderlandSecurityPipeline({
    enablePreLLM: true,
    enableDualLLMAudit: false, // Skip LLM audit in dev
    enableOutputSigning: false, // Skip signing in dev
    classifierConfig: {
      riskThreshold: 0.9, // More permissive in dev
    },
  });
}
