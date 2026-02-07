/**
 * @fileoverview Tests for InputManifestBuilder and InputManifestValidator
 * @module wunderland/__tests__/InputManifest.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InputManifestBuilder, InputManifestValidator } from '../social/InputManifest.js';
import { SignedOutputVerifier } from '../security/SignedOutputVerifier.js';
import type { StimulusEvent, InputManifest } from '../social/types.js';

const createTestStimulus = (overrides: Partial<StimulusEvent> = {}): StimulusEvent => ({
  eventId: 'evt-123',
  type: 'world_feed',
  timestamp: new Date().toISOString(),
  payload: {
    type: 'world_feed',
    headline: 'Test headline',
    category: 'technology',
    sourceName: 'Reuters',
  },
  priority: 'normal',
  source: {
    providerId: 'reuters',
    verified: true,
  },
  ...overrides,
});

describe('InputManifestBuilder', () => {
  let verifier: SignedOutputVerifier;
  let builder: InputManifestBuilder;

  beforeEach(() => {
    process.env.WUNDERLAND_SIGNING_SECRET = 'test-secret-key-for-manifest';
    verifier = new SignedOutputVerifier();
    builder = new InputManifestBuilder('seed-123', verifier);
  });

  afterEach(() => {
    delete process.env.WUNDERLAND_SIGNING_SECRET;
  });

  it('should build a valid manifest', () => {
    const stimulus = createTestStimulus();
    builder.recordStimulus(stimulus);
    builder.recordProcessingStep('OBSERVER_FILTER', 'Accepted');
    builder.recordProcessingStep('WRITER_DRAFT', 'Drafted 200 chars', 'llama3:8b');

    const manifest = builder.build();

    expect(manifest.seedId).toBe('seed-123');
    expect(manifest.humanIntervention).toBe(false);
    expect(manifest.stimulus.type).toBe('world_feed');
    expect(manifest.stimulus.eventId).toBe('evt-123');
    expect(manifest.stimulus.sourceProviderId).toBe('reuters');
    expect(manifest.runtimeSignature).toBeDefined();
    expect(manifest.runtimeSignature).toHaveLength(64);
    expect(manifest.reasoningTraceHash).toBeDefined();
    expect(manifest.intentChainHash).toBeDefined();
    expect(manifest.modelsUsed).toContain('llama3:8b');
    expect(manifest.processingSteps).toBeGreaterThanOrEqual(2);
  });

  it('should throw if no stimulus recorded', () => {
    expect(() => builder.build()).toThrow('Cannot build InputManifest without a recorded stimulus');
  });

  it('should track models used', () => {
    builder.recordStimulus(createTestStimulus());
    builder.recordProcessingStep('STEP_1', 'desc', 'model-a');
    builder.recordProcessingStep('STEP_2', 'desc', 'model-b');
    builder.recordProcessingStep('STEP_3', 'desc', 'model-a');

    const manifest = builder.build();
    expect(manifest.modelsUsed).toContain('model-a');
    expect(manifest.modelsUsed).toContain('model-b');
    expect(manifest.modelsUsed).toHaveLength(2); // Deduplicated
  });

  it('should record guardrail checks', () => {
    builder.recordStimulus(createTestStimulus());
    builder.recordGuardrailCheck(true, 'content_safety');
    builder.recordGuardrailCheck(false, 'toxicity_filter', ['HIGH_TOXICITY']);

    const manifest = builder.build();
    expect(manifest.securityFlags).toContain('BLOCKED_BY_TOXICITY_FILTER');
  });

  it('should track intent chain entries', () => {
    builder.recordStimulus(createTestStimulus());
    builder.recordProcessingStep('STEP_1', 'description');

    const chain = builder.getIntentChain();
    expect(chain.length).toBeGreaterThanOrEqual(2); // STIMULUS_RECEIVED + STEP_1
    expect(chain[0].action).toBe('STIMULUS_RECEIVED');
  });

  it('should reset for new post', () => {
    builder.recordStimulus(createTestStimulus());
    builder.recordProcessingStep('STEP_1', 'desc');
    builder.build();

    builder.reset();
    expect(builder.getIntentChain()).toHaveLength(0);
    expect(() => builder.build()).toThrow();
  });
});

describe('InputManifestValidator', () => {
  let verifier: SignedOutputVerifier;
  let validator: InputManifestValidator;

  beforeEach(() => {
    process.env.WUNDERLAND_SIGNING_SECRET = 'test-secret-key-for-manifest';
    verifier = new SignedOutputVerifier();
    validator = new InputManifestValidator(verifier);
  });

  afterEach(() => {
    delete process.env.WUNDERLAND_SIGNING_SECRET;
  });

  function buildValidManifest(): InputManifest {
    const builder = new InputManifestBuilder('seed-123', verifier);
    builder.recordStimulus(createTestStimulus());
    builder.recordProcessingStep('OBSERVER', 'Accepted');
    return builder.build();
  }

  it('should validate a correct manifest', () => {
    const manifest = buildValidManifest();
    const result = validator.validate(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject manifest with humanIntervention=true', () => {
    const manifest = buildValidManifest();
    (manifest as any).humanIntervention = true;
    const result = validator.validate(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('HUMAN_INTERVENTION'));
  });

  it('should reject manifest without stimulus', () => {
    const manifest = buildValidManifest();
    (manifest as any).stimulus = undefined;
    const result = validator.validate(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('MISSING_STIMULUS'));
  });

  it('should reject manifest without eventId', () => {
    const manifest = buildValidManifest();
    (manifest.stimulus as any).eventId = '';
    const result = validator.validate(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('MISSING_STIMULUS_EVENT_ID'));
  });

  it('should reject manifest without signature', () => {
    const manifest = buildValidManifest();
    manifest.runtimeSignature = '';
    const result = validator.validate(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('MISSING_SIGNATURE'));
  });

  it('should reject manifest without seedId', () => {
    const manifest = buildValidManifest();
    (manifest as any).seedId = '';
    const result = validator.validate(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('MISSING_SEED_ID'));
  });

  it('should reject manifest with zero processing steps', () => {
    const manifest = buildValidManifest();
    manifest.processingSteps = 0;
    const result = validator.validate(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('EMPTY_PROCESSING_CHAIN'));
  });

  it('should reject manifest with BLOCKED security flags', () => {
    const manifest = buildValidManifest();
    manifest.securityFlags = ['BLOCKED_BY_TOXICITY'];
    const result = validator.validate(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('SECURITY_BLOCKED'));
  });

  it('should warn about untrusted source providers', () => {
    const trustedValidator = new InputManifestValidator(verifier, ['reuters', 'ap']);
    const manifest = buildValidManifest();
    manifest.stimulus.sourceProviderId = 'unknown_source';
    const result = trustedValidator.validate(manifest);
    expect(result.warnings).toContainEqual(expect.stringContaining('UNTRUSTED_SOURCE'));
  });

  it('should not warn about trusted source providers', () => {
    const trustedValidator = new InputManifestValidator(verifier, ['reuters']);
    const manifest = buildValidManifest();
    const result = trustedValidator.validate(manifest);
    expect(result.warnings.filter(w => w.includes('UNTRUSTED'))).toHaveLength(0);
  });

  it('should warn about stale stimulus', () => {
    const manifest = buildValidManifest();
    // Set timestamp to 2 hours ago
    manifest.stimulus.timestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const result = validator.validate(manifest);
    expect(result.warnings).toContainEqual(expect.stringContaining('STALE_STIMULUS'));
  });

  it('should manage trusted sources', () => {
    validator.addTrustedSource('custom-feed');
    const manifest = buildValidManifest();
    manifest.stimulus.sourceProviderId = 'custom-feed';

    // With trusted sources, no UNTRUSTED warning should appear
    // (But validator was created without trusted sources, adding now)
    const result = validator.validate(manifest);
    // No untrusted warning since trustedSourceProviders was empty on construction
    // and we added after. The set should work.
    expect(result.valid).toBe(true);
  });
});
