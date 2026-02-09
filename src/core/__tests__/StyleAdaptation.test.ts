/**
 * @fileoverview Tests for StyleAdaptationEngine — user communication style learning
 * @module wunderland/core/__tests__/StyleAdaptation.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  StyleAdaptationEngine,
  type CommunicationStyleProfile,
} from '../StyleAdaptation.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_PROFILE_RESPONSE = {
  formality: 0.3,
  verbosity: 0.6,
  technicality: 0.8,
  emotionalTone: 0.4,
  structurePreference: 'mixed',
  humorTolerance: 0.5,
};

function createMockInvoker(response?: Record<string, unknown>) {
  return vi.fn(async (_prompt: string) =>
    JSON.stringify(response ?? MOCK_PROFILE_RESPONSE)
  );
}

function createFailingInvoker() {
  return vi.fn(async (_prompt: string) => {
    throw new Error('LLM unavailable');
  });
}

// ── Constructor with defaults ───────────────────────────────────────────────

describe('StyleAdaptationEngine constructor', () => {
  it('should construct with defaults without errors', () => {
    const engine = new StyleAdaptationEngine({
      invoker: createMockInvoker(),
    });
    expect(engine).toBeDefined();
  });

  it('should construct with custom config', () => {
    const engine = new StyleAdaptationEngine({
      invoker: createMockInvoker(),
      minSampleSize: 3,
      maxMessageHistory: 100,
      reanalyzeEvery: 5,
    });
    expect(engine).toBeDefined();
  });
});

// ── ingestUserMessage ───────────────────────────────────────────────────────

describe('StyleAdaptationEngine.ingestUserMessage', () => {
  it('should store messages in buffer', async () => {
    const invoker = createMockInvoker();
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 10 });

    await engine.ingestUserMessage('user-1', 'Hello there');
    await engine.ingestUserMessage('user-1', 'How are you?');

    // Profile should not be generated yet (need minSampleSize = 10)
    expect(engine.getProfile('user-1')).toBeUndefined();
    expect(invoker).not.toHaveBeenCalled();
  });

  it('should ignore empty messages', async () => {
    const invoker = createMockInvoker();
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 2 });

    await engine.ingestUserMessage('user-1', '');
    await engine.ingestUserMessage('user-1', '   ');

    expect(engine.getProfile('user-1')).toBeUndefined();
    expect(invoker).not.toHaveBeenCalled();
  });
});

// ── Profile generation ──────────────────────────────────────────────────────

describe('StyleAdaptationEngine profile generation', () => {
  it('should be undefined until minSampleSize messages ingested', async () => {
    const invoker = createMockInvoker();
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 5 });

    for (let i = 0; i < 4; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }
    expect(engine.getProfile('user-1')).toBeUndefined();
  });

  it('should generate profile after minSampleSize messages', async () => {
    const invoker = createMockInvoker();
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 5 });

    for (let i = 0; i < 5; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }

    const profile = engine.getProfile('user-1');
    expect(profile).toBeDefined();
    expect(invoker).toHaveBeenCalledOnce();
  });

  it('should parse LLM profile JSON correctly', async () => {
    const invoker = createMockInvoker({
      formality: 0.2,
      verbosity: 0.9,
      technicality: 0.7,
      emotionalTone: 0.8,
      structurePreference: 'bullets',
      humorTolerance: 0.6,
    });
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 3 });

    for (let i = 0; i < 3; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }

    const profile = engine.getProfile('user-1');
    expect(profile).toBeDefined();
    expect(profile!.formality).toBe(0.2);
    expect(profile!.verbosity).toBe(0.9);
    expect(profile!.technicality).toBe(0.7);
    expect(profile!.emotionalTone).toBe(0.8);
    expect(profile!.structurePreference).toBe('bullets');
    expect(profile!.humorTolerance).toBe(0.6);
  });

  it('should not generate profile if LLM call fails', async () => {
    const invoker = createFailingInvoker();
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 3 });

    for (let i = 0; i < 3; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }

    // Failed LLM call means no profile
    expect(engine.getProfile('user-1')).toBeUndefined();
  });
});

// ── generateStyleInstruction ────────────────────────────────────────────────

describe('StyleAdaptationEngine.generateStyleInstruction', () => {
  it('should return empty string when no profile exists', () => {
    const engine = new StyleAdaptationEngine({ invoker: createMockInvoker() });
    expect(engine.generateStyleInstruction('user-1')).toBe('');
  });

  it('should return non-empty string for valid profile', async () => {
    const invoker = createMockInvoker();
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 3 });

    for (let i = 0; i < 3; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }

    const instruction = engine.generateStyleInstruction('user-1');
    expect(instruction).toBeTruthy();
    expect(instruction.length).toBeGreaterThan(0);
  });

  it('should mention formality in instruction', async () => {
    const invoker = createMockInvoker({ ...MOCK_PROFILE_RESPONSE, formality: 0.1 });
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 3 });

    for (let i = 0; i < 3; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }

    const instruction = engine.generateStyleInstruction('user-1');
    expect(instruction.toLowerCase()).toContain('casual');
  });

  it('should mention formal tone for high formality', async () => {
    const invoker = createMockInvoker({ ...MOCK_PROFILE_RESPONSE, formality: 0.9 });
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 3 });

    for (let i = 0; i < 3; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }

    const instruction = engine.generateStyleInstruction('user-1');
    expect(instruction.toLowerCase()).toContain('formal');
  });
});

// ── harmonizeWithPersonality ────────────────────────────────────────────────

describe('StyleAdaptationEngine.harmonizeWithPersonality', () => {
  const TRAITS = {
    honesty: 0.8,
    emotionality: 0.5,
    extraversion: 0.7,
    agreeableness: 0.6,
    conscientiousness: 0.5,
    openness: 0.8,
  };

  it('should return empty string when no profile exists', () => {
    const engine = new StyleAdaptationEngine({ invoker: createMockInvoker() });
    expect(engine.harmonizeWithPersonality('user-1', TRAITS)).toBe('');
  });

  it('should return blended instruction for valid profile', async () => {
    const invoker = createMockInvoker();
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 3 });

    for (let i = 0; i < 3; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }

    const instruction = engine.harmonizeWithPersonality('user-1', TRAITS);
    expect(instruction).toBeTruthy();
    expect(instruction.length).toBeGreaterThan(0);
  });

  it('should include tension notes when user and agent styles diverge significantly', async () => {
    // Very formal user style + very extraverted (casual) agent
    const invoker = createMockInvoker({ ...MOCK_PROFILE_RESPONSE, formality: 0.95 });
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 3 });

    for (let i = 0; i < 3; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }

    const casualAgentTraits = {
      honesty: 0.5,
      emotionality: 0.3,
      extraversion: 0.95,  // High extraversion => casual agent
      agreeableness: 0.5,
      conscientiousness: 0.1, // Low conscientiousness => less formal
      openness: 0.5,
    };

    const instruction = engine.harmonizeWithPersonality('user-1', casualAgentTraits);
    // When user is very formal but agent is casual, expect a "Note:" about tension
    expect(instruction.toLowerCase()).toContain('note');
  });
});

// ── loadProfile / clearProfile ──────────────────────────────────────────────

describe('StyleAdaptationEngine.loadProfile and clearProfile', () => {
  it('loadProfile should store a profile directly', () => {
    const engine = new StyleAdaptationEngine({ invoker: createMockInvoker() });

    const profile: CommunicationStyleProfile = {
      formality: 0.5,
      verbosity: 0.5,
      technicality: 0.5,
      emotionalTone: 0.5,
      structurePreference: 'mixed',
      humorTolerance: 0.5,
      sampleSize: 20,
      confidence: 0.8,
      lastUpdatedAt: new Date().toISOString(),
    };

    engine.loadProfile('user-1', profile);
    expect(engine.getProfile('user-1')).toBeDefined();
    expect(engine.getProfile('user-1')!.formality).toBe(0.5);
  });

  it('clearProfile should remove profile and buffer', async () => {
    const invoker = createMockInvoker();
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 3 });

    for (let i = 0; i < 3; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }
    expect(engine.getProfile('user-1')).toBeDefined();

    engine.clearProfile('user-1');
    expect(engine.getProfile('user-1')).toBeUndefined();
    expect(engine.generateStyleInstruction('user-1')).toBe('');
  });

  it('clearProfile on nonexistent user should not throw', () => {
    const engine = new StyleAdaptationEngine({ invoker: createMockInvoker() });
    expect(() => engine.clearProfile('nonexistent')).not.toThrow();
  });
});

// ── Confidence increases with sample size ───────────────────────────────────

describe('StyleAdaptationEngine confidence', () => {
  it('confidence should increase with more messages', async () => {
    const invoker = createMockInvoker();
    const engine = new StyleAdaptationEngine({
      invoker,
      minSampleSize: 3,
      reanalyzeEvery: 5,
    });

    // First analysis at 3 messages
    for (let i = 0; i < 3; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }
    const firstProfile = engine.getProfile('user-1');
    expect(firstProfile).toBeDefined();
    const firstConfidence = firstProfile!.confidence;

    // More messages, triggers re-analysis at 3 + 5 = 8 messages
    for (let i = 3; i < 8; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }
    const secondProfile = engine.getProfile('user-1');
    expect(secondProfile).toBeDefined();
    const secondConfidence = secondProfile!.confidence;

    // Confidence should be higher with more messages (exponential approach)
    expect(secondConfidence).toBeGreaterThan(firstConfidence);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('StyleAdaptationEngine edge cases', () => {
  it('should handle multiple users independently', async () => {
    const invoker = createMockInvoker();
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 3 });

    for (let i = 0; i < 3; i++) {
      await engine.ingestUserMessage('user-1', `User 1 message ${i}`);
    }

    // User 2 has no profile yet
    expect(engine.getProfile('user-2')).toBeUndefined();
    // User 1 should have profile
    expect(engine.getProfile('user-1')).toBeDefined();
  });

  it('should respect maxMessageHistory limit', async () => {
    const invoker = createMockInvoker();
    const engine = new StyleAdaptationEngine({
      invoker,
      minSampleSize: 3,
      maxMessageHistory: 5,
    });

    // Ingest more than maxMessageHistory messages
    for (let i = 0; i < 10; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }

    // Engine should still work correctly; just the buffer is capped
    const profile = engine.getProfile('user-1');
    expect(profile).toBeDefined();
  });

  it('should validate structurePreference to known values', async () => {
    const invoker = createMockInvoker({
      ...MOCK_PROFILE_RESPONSE,
      structurePreference: 'invalid-value',
    });
    const engine = new StyleAdaptationEngine({ invoker, minSampleSize: 3 });

    for (let i = 0; i < 3; i++) {
      await engine.ingestUserMessage('user-1', `Message ${i}`);
    }

    const profile = engine.getProfile('user-1');
    expect(profile).toBeDefined();
    // Invalid value should default to 'mixed'
    expect(profile!.structurePreference).toBe('mixed');
  });
});
