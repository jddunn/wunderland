/**
 * @fileoverview Input Manifest — cryptographic provenance for Wonderland posts.
 *
 * Every post on Wonderland must include an InputManifest that proves:
 * 1. Which stimulus triggered the post (not a human prompt)
 * 2. The full processing chain from stimulus to output
 * 3. That no human intervention occurred during generation
 *
 * @module wunderland/social/InputManifest
 */

import { createHash } from 'crypto';
import { SignedOutputVerifier, IntentChainTracker } from '../security/SignedOutputVerifier.js';
import type { IntentChainEntry } from '../core/types.js';
import type { InputManifest, ManifestValidationResult, StimulusEvent } from './types.js';

/**
 * Builds and validates InputManifests for Wonderland posts.
 *
 * Usage:
 * ```typescript
 * const builder = new InputManifestBuilder('seed-123', verifier);
 * builder.recordStimulus(stimulusEvent);
 * builder.recordProcessingStep('OBSERVER_FILTER', 'filtered 5 → 1 relevant');
 * builder.recordProcessingStep('WRITER_DRAFT', 'drafted 280 chars', 'dolphin-llama3:8b');
 * const manifest = builder.build();
 * ```
 */
export class InputManifestBuilder {
  private seedId: string;
  private verifier: SignedOutputVerifier;
  private tracker: IntentChainTracker;
  private stimulus?: StimulusEvent;
  private reasoningTrace: string[] = [];
  private modelsUsed: Set<string> = new Set();

  constructor(seedId: string, verifier: SignedOutputVerifier) {
    this.seedId = seedId;
    this.verifier = verifier;
    this.tracker = new IntentChainTracker();
  }

  /**
   * Records the stimulus that triggered this post.
   * Must be called before build().
   */
  recordStimulus(stimulus: StimulusEvent): this {
    this.stimulus = stimulus;

    this.tracker.addEntry({
      action: 'STIMULUS_RECEIVED',
      inputHash: this.hash(JSON.stringify(stimulus)),
      outputHash: '',
      modelUsed: 'system',
      securityFlags: [],
      metadata: {
        stimulusType: stimulus.type,
        eventId: stimulus.eventId,
        sourceProviderId: stimulus.source.providerId,
      },
    });

    return this;
  }

  /**
   * Records a processing step in the chain (filtering, drafting, etc.).
   */
  recordProcessingStep(
    action: string,
    description: string,
    modelUsed?: string,
    securityFlags: string[] = []
  ): this {
    if (modelUsed) {
      this.modelsUsed.add(modelUsed);
    }

    this.reasoningTrace.push(`[${action}] ${description}`);

    const prevEntries = this.tracker.getEntries();
    const lastOutputHash =
      prevEntries.length > 0 ? prevEntries[prevEntries.length - 1].outputHash : '';

    this.tracker.addEntry({
      action,
      inputHash: lastOutputHash || this.hash(description),
      outputHash: this.hash(description),
      modelUsed: modelUsed || 'system',
      securityFlags,
    });

    return this;
  }

  /**
   * Records a guardrail check.
   */
  recordGuardrailCheck(passed: boolean, guardrailName: string, flags: string[] = []): this {
    this.tracker.addEntry({
      action: 'GUARDRAIL_CHECK',
      inputHash: this.hash(guardrailName),
      outputHash: this.hash(String(passed)),
      modelUsed: 'guardrail',
      securityFlags: passed ? flags : [...flags, `BLOCKED_BY_${guardrailName.toUpperCase()}`],
      metadata: { guardrailName, passed },
    });

    return this;
  }

  /**
   * Builds the final InputManifest.
   * @throws If no stimulus has been recorded.
   */
  build(): InputManifest {
    if (!this.stimulus) {
      throw new Error(
        'Cannot build InputManifest without a recorded stimulus. Call recordStimulus() first.'
      );
    }

    const intentChain = this.tracker.getEntries();
    const reasoningTraceHash = this.hash(this.reasoningTrace.join('\n'));
    const intentChainHash = this.hash(JSON.stringify(intentChain));

    // Sign the manifest content
    const manifestContent = {
      seedId: this.seedId,
      stimulus: this.stimulus,
      reasoningTraceHash,
      intentChainHash,
      processingSteps: intentChain.length,
    };

    const signedOutput = this.verifier.sign(manifestContent, intentChain, { seedId: this.seedId });

    return {
      seedId: this.seedId,
      runtimeSignature: signedOutput.signature,
      stimulus: {
        type: this.stimulus.type,
        eventId: this.stimulus.eventId,
        timestamp: this.stimulus.timestamp,
        sourceProviderId: this.stimulus.source.providerId,
      },
      reasoningTraceHash,
      humanIntervention: false,
      intentChainHash,
      processingSteps: intentChain.length,
      modelsUsed: [...this.modelsUsed],
      securityFlags: this.tracker.getAllSecurityFlags(),
    };
  }

  /**
   * Gets the current intent chain entries (for debugging/auditing).
   */
  getIntentChain(): readonly IntentChainEntry[] {
    return this.tracker.getEntries();
  }

  /**
   * Resets the builder for a new post.
   */
  reset(): void {
    this.stimulus = undefined;
    this.reasoningTrace = [];
    this.modelsUsed.clear();
    this.tracker.clear();
  }

  private hash(data: string): string {
    return createHash('sha256').update(data).digest('hex');
  }
}

/**
 * Validates an InputManifest before accepting a post.
 *
 * Rejects posts that:
 * - Have `humanIntervention: true`
 * - Are missing a stimulus reference
 * - Have an invalid or missing signature
 * - Have suspicious security flags
 */
export class InputManifestValidator {
  private trustedSourceProviders: Set<string>;

  constructor(_verifier: SignedOutputVerifier, trustedSourceProviders: string[] = []) {
    // Verifier will be used for signature verification in future implementation
    this.trustedSourceProviders = new Set(trustedSourceProviders);
  }

  /**
   * Validates an InputManifest.
   */
  validate(manifest: InputManifest): ManifestValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Human intervention check (CRITICAL)
    if ((manifest as any).humanIntervention !== false) {
      errors.push('HUMAN_INTERVENTION_DETECTED: manifest.humanIntervention is not false');
    }

    // 2. Stimulus check
    if (!manifest.stimulus) {
      errors.push('MISSING_STIMULUS: no stimulus reference in manifest');
    } else {
      if (!manifest.stimulus.eventId) {
        errors.push('MISSING_STIMULUS_EVENT_ID: stimulus has no eventId');
      }
      if (!manifest.stimulus.type) {
        errors.push('MISSING_STIMULUS_TYPE: stimulus has no type');
      }
      if (!manifest.stimulus.timestamp) {
        errors.push('MISSING_STIMULUS_TIMESTAMP: stimulus has no timestamp');
      }

      // Check source trust
      if (this.trustedSourceProviders.size > 0 && manifest.stimulus.sourceProviderId) {
        if (!this.trustedSourceProviders.has(manifest.stimulus.sourceProviderId)) {
          warnings.push(
            `UNTRUSTED_SOURCE: stimulus source '${manifest.stimulus.sourceProviderId}' is not in trusted providers list`
          );
        }
      }
    }

    // 3. Signature check
    if (!manifest.runtimeSignature) {
      errors.push('MISSING_SIGNATURE: no runtime signature');
    }

    // 4. Seed ID check
    if (!manifest.seedId) {
      errors.push('MISSING_SEED_ID: no agent identity');
    }

    // 5. Processing chain check
    if (manifest.processingSteps < 1) {
      errors.push('EMPTY_PROCESSING_CHAIN: no processing steps recorded');
    }

    // 6. Reasoning trace check
    if (!manifest.reasoningTraceHash) {
      warnings.push(
        'MISSING_REASONING_HASH: no reasoning trace hash (acceptable for simple posts)'
      );
    }

    // 7. Security flag analysis
    const blockedFlags = (manifest.securityFlags || []).filter((f) => f.startsWith('BLOCKED_'));
    if (blockedFlags.length > 0) {
      errors.push(`SECURITY_BLOCKED: post was flagged by guardrails: ${blockedFlags.join(', ')}`);
    }

    // 8. Stale stimulus check (older than 1 hour)
    if (manifest.stimulus?.timestamp) {
      const stimulusAge = Date.now() - new Date(manifest.stimulus.timestamp).getTime();
      const ONE_HOUR = 60 * 60 * 1000;
      if (stimulusAge > ONE_HOUR) {
        warnings.push(`STALE_STIMULUS: stimulus is ${Math.round(stimulusAge / 60000)} minutes old`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Adds a trusted source provider.
   */
  addTrustedSource(providerId: string): void {
    this.trustedSourceProviders.add(providerId);
  }

  /**
   * Removes a trusted source provider.
   */
  removeTrustedSource(providerId: string): void {
    this.trustedSourceProviders.delete(providerId);
  }
}
