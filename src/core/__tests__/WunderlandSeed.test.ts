/**
 * @fileoverview Tests for WunderlandSeed — HEXACO-based adaptive AI agent persona
 * @module wunderland/core/__tests__/WunderlandSeed.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createWunderlandSeed,
  createDefaultWunderlandSeed,
  updateSeedTraits,
  HEXACO_PRESETS,
  type IWunderlandSeed,
} from '../WunderlandSeed.js';
import {
  type HEXACOTraits,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_STEP_UP_AUTH_CONFIG,
  normalizeHEXACOTraits,
} from '../types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Returns a full WunderlandSeedConfig with the given HEXACO trait overrides. */
function makeConfig(traitOverrides?: Partial<HEXACOTraits>) {
  const baseTraits: HEXACOTraits = {
    honesty_humility: 0.5,
    emotionality: 0.5,
    extraversion: 0.5,
    agreeableness: 0.5,
    conscientiousness: 0.5,
    openness: 0.5,
  };

  return {
    seedId: 'test-seed-001',
    name: 'Test Agent',
    description: 'A test agent for unit tests',
    hexacoTraits: { ...baseTraits, ...traitOverrides },
    securityProfile: DEFAULT_SECURITY_PROFILE,
    inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
    stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
  };
}

const HEXACO_KEYS: (keyof HEXACOTraits)[] = [
  'honesty_humility',
  'emotionality',
  'extraversion',
  'agreeableness',
  'conscientiousness',
  'openness',
];

// ── createWunderlandSeed ────────────────────────────────────────────────────

describe('createWunderlandSeed', () => {
  let seed: IWunderlandSeed;

  beforeEach(() => {
    seed = createWunderlandSeed(makeConfig());
  });

  it('should create a seed with all required fields populated', () => {
    expect(seed).toBeDefined();
    expect(seed.seedId).toBeDefined();
    expect(seed.name).toBeDefined();
    expect(seed.description).toBeDefined();
    expect(seed.hexacoTraits).toBeDefined();
    expect(seed.securityProfile).toBeDefined();
    expect(seed.inferenceHierarchy).toBeDefined();
    expect(seed.stepUpAuthConfig).toBeDefined();
    expect(seed.baseSystemPrompt).toBeDefined();
    expect(seed.personalityTraits).toBeDefined();
    expect(seed.moodAdaptation).toBeDefined();
    expect(seed.version).toBeDefined();
  });

  it('should set seedId, name, and description from config', () => {
    const config = makeConfig();
    expect(seed.seedId).toBe(config.seedId);
    expect(seed.id).toBe(config.seedId);
    expect(seed.name).toBe(config.name);
    expect(seed.description).toBe(config.description);
  });

  it('should set version to 1.0.0', () => {
    expect(seed.version).toBe('1.0.0');
  });

  // ── HEXACO normalization ────────────────────────────────────────────────

  it('should normalize HEXACO traits (clamps to 0-1 range)', () => {
    const outOfRangeSeed = createWunderlandSeed(
      makeConfig({
        honesty_humility: -0.5,
        emotionality: 1.5,
        extraversion: 2.0,
        agreeableness: -1.0,
        conscientiousness: 0.5,
        openness: 0.5,
      }),
    );

    expect(outOfRangeSeed.hexacoTraits.honesty_humility).toBe(0);
    expect(outOfRangeSeed.hexacoTraits.emotionality).toBe(1);
    expect(outOfRangeSeed.hexacoTraits.extraversion).toBe(1);
    expect(outOfRangeSeed.hexacoTraits.agreeableness).toBe(0);
    expect(outOfRangeSeed.hexacoTraits.conscientiousness).toBe(0.5);
    expect(outOfRangeSeed.hexacoTraits.openness).toBe(0.5);
  });

  it('should preserve valid HEXACO trait values unchanged', () => {
    const traits: HEXACOTraits = {
      honesty_humility: 0.3,
      emotionality: 0.7,
      extraversion: 0.1,
      agreeableness: 0.9,
      conscientiousness: 0.4,
      openness: 0.6,
    };
    const s = createWunderlandSeed(makeConfig(traits));

    for (const key of HEXACO_KEYS) {
      expect(s.hexacoTraits[key]).toBe(traits[key]);
    }
  });

  // ── System prompt ──────────────────────────────────────────────────────

  it('should generate a system prompt containing the agent name', () => {
    expect(typeof seed.baseSystemPrompt).toBe('string');
    expect(seed.baseSystemPrompt as string).toContain('Test Agent');
  });

  it('should include personality guidelines for extreme trait values', () => {
    const highOpennessSeed = createWunderlandSeed(
      makeConfig({ openness: 0.9 }),
    );
    const prompt = highOpennessSeed.baseSystemPrompt as string;
    expect(prompt.toLowerCase()).toContain('creative');
  });

  it('should incorporate baseSystemPrompt from config when provided', () => {
    const config = {
      ...makeConfig(),
      baseSystemPrompt: 'Custom instructions: always respond in JSON.',
    };
    const s = createWunderlandSeed(config);
    expect(s.baseSystemPrompt as string).toContain(
      'Custom instructions: always respond in JSON.',
    );
  });

  // ── Personality traits mapping ─────────────────────────────────────────

  it('should map HEXACO traits to personality traits with derived fields', () => {
    const pt = seed.personalityTraits!;
    expect(pt).toHaveProperty('humor_level');
    expect(pt).toHaveProperty('formality_level');
    expect(pt).toHaveProperty('verbosity_level');
    expect(pt).toHaveProperty('assertiveness_level');
    expect(pt).toHaveProperty('empathy_level');
    expect(pt).toHaveProperty('creativity_level');
    expect(pt).toHaveProperty('detail_orientation');
    expect(pt).toHaveProperty('risk_tolerance');
  });

  it('should include direct HEXACO mappings in personality traits', () => {
    const pt = seed.personalityTraits!;
    expect(pt.hexaco_honesty_humility).toBe(seed.hexacoTraits.honesty_humility);
    expect(pt.hexaco_emotionality).toBe(seed.hexacoTraits.emotionality);
    expect(pt.hexaco_extraversion).toBe(seed.hexacoTraits.extraversion);
    expect(pt.hexaco_agreeableness).toBe(seed.hexacoTraits.agreeableness);
    expect(pt.hexaco_conscientiousness).toBe(seed.hexacoTraits.conscientiousness);
    expect(pt.hexaco_openness).toBe(seed.hexacoTraits.openness);
  });

  it('should compute humor_level from extraversion and openness', () => {
    const traits: HEXACOTraits = {
      honesty_humility: 0.5,
      emotionality: 0.5,
      extraversion: 0.8,
      agreeableness: 0.5,
      conscientiousness: 0.5,
      openness: 0.6,
    };
    const s = createWunderlandSeed(makeConfig(traits));
    const expected = traits.extraversion * 0.5 + traits.openness * 0.3;
    expect(s.personalityTraits!.humor_level).toBeCloseTo(expected);
  });

  it('should compute formality_level from conscientiousness and extraversion', () => {
    const traits: HEXACOTraits = {
      honesty_humility: 0.5,
      emotionality: 0.5,
      extraversion: 0.3,
      agreeableness: 0.5,
      conscientiousness: 0.9,
      openness: 0.5,
    };
    const s = createWunderlandSeed(makeConfig(traits));
    const expected =
      traits.conscientiousness * 0.6 + (1 - traits.extraversion) * 0.2;
    expect(s.personalityTraits!.formality_level).toBeCloseTo(expected);
  });

  // ── Mood adaptation config ─────────────────────────────────────────────

  it('should map HEXACO traits to mood adaptation config', () => {
    const mood = seed.moodAdaptation!;
    expect(mood.enabled).toBe(true);
    expect(mood.sensitivityFactor).toBeDefined();
    expect(mood.defaultMood).toBeDefined();
    expect(mood.allowedMoods).toBeDefined();
    expect(mood.moodPrompts).toBeDefined();
  });

  it('should compute sensitivityFactor from emotionality', () => {
    const highEmo = createWunderlandSeed(makeConfig({ emotionality: 1.0 }));
    expect(highEmo.moodAdaptation!.sensitivityFactor).toBeCloseTo(1.0);

    const lowEmo = createWunderlandSeed(makeConfig({ emotionality: 0.0 }));
    expect(lowEmo.moodAdaptation!.sensitivityFactor).toBeCloseTo(0.3);

    const midEmo = createWunderlandSeed(makeConfig({ emotionality: 0.5 }));
    expect(midEmo.moodAdaptation!.sensitivityFactor).toBeCloseTo(0.65);
  });

  // ── Default mood determination ─────────────────────────────────────────

  it('should set default mood to CREATIVE for high extraversion (>0.7)', () => {
    const s = createWunderlandSeed(
      makeConfig({ extraversion: 0.8, conscientiousness: 0.3 }),
    );
    expect(s.moodAdaptation!.defaultMood).toBe('CREATIVE');
  });

  it('should set default mood to FOCUSED for high conscientiousness (>0.7) when extraversion <=0.7', () => {
    const s = createWunderlandSeed(
      makeConfig({ extraversion: 0.5, conscientiousness: 0.9 }),
    );
    expect(s.moodAdaptation!.defaultMood).toBe('FOCUSED');
  });

  it('should set default mood to EMPATHETIC for high agreeableness (>0.7) when extraversion and conscientiousness <=0.7', () => {
    const s = createWunderlandSeed(
      makeConfig({
        extraversion: 0.5,
        conscientiousness: 0.5,
        agreeableness: 0.85,
      }),
    );
    expect(s.moodAdaptation!.defaultMood).toBe('EMPATHETIC');
  });

  it('should set default mood to CURIOUS for high openness (>0.7) when other leading traits <=0.7', () => {
    const s = createWunderlandSeed(
      makeConfig({
        extraversion: 0.5,
        conscientiousness: 0.5,
        agreeableness: 0.5,
        openness: 0.9,
      }),
    );
    expect(s.moodAdaptation!.defaultMood).toBe('CURIOUS');
  });

  it('should set default mood to NEUTRAL for balanced traits (all <=0.7)', () => {
    const s = createWunderlandSeed(
      makeConfig({
        extraversion: 0.5,
        conscientiousness: 0.5,
        agreeableness: 0.5,
        openness: 0.5,
      }),
    );
    expect(s.moodAdaptation!.defaultMood).toBe('NEUTRAL');
  });

  it('should prioritize extraversion over conscientiousness for default mood', () => {
    const s = createWunderlandSeed(
      makeConfig({ extraversion: 0.8, conscientiousness: 0.9 }),
    );
    expect(s.moodAdaptation!.defaultMood).toBe('CREATIVE');
  });

  it('should prioritize conscientiousness over agreeableness for default mood', () => {
    const s = createWunderlandSeed(
      makeConfig({
        extraversion: 0.5,
        conscientiousness: 0.8,
        agreeableness: 0.9,
      }),
    );
    expect(s.moodAdaptation!.defaultMood).toBe('FOCUSED');
  });

  // ── Allowed moods modifications ────────────────────────────────────────

  it('should include base allowed moods for all seeds', () => {
    const baseMoods = [
      'NEUTRAL',
      'FOCUSED',
      'EMPATHETIC',
      'CURIOUS',
      'ANALYTICAL',
      'CREATIVE',
    ];
    for (const mood of baseMoods) {
      expect(seed.moodAdaptation!.allowedMoods).toContain(mood);
    }
  });

  it('should add ASSERTIVE to allowed moods when honesty_humility < 0.5', () => {
    const s = createWunderlandSeed(makeConfig({ honesty_humility: 0.3 }));
    expect(s.moodAdaptation!.allowedMoods).toContain('ASSERTIVE');
  });

  it('should NOT add ASSERTIVE when honesty_humility >= 0.5', () => {
    const s = createWunderlandSeed(makeConfig({ honesty_humility: 0.7 }));
    expect(s.moodAdaptation!.allowedMoods).not.toContain('ASSERTIVE');
  });

  it('should add FRUSTRATED to allowed moods when emotionality > 0.7', () => {
    const s = createWunderlandSeed(makeConfig({ emotionality: 0.9 }));
    expect(s.moodAdaptation!.allowedMoods).toContain('FRUSTRATED');
  });

  it('should NOT add FRUSTRATED when emotionality <= 0.7', () => {
    const s = createWunderlandSeed(makeConfig({ emotionality: 0.5 }));
    expect(s.moodAdaptation!.allowedMoods).not.toContain('FRUSTRATED');
  });

  it('should add both ASSERTIVE and FRUSTRATED when both conditions met', () => {
    const s = createWunderlandSeed(
      makeConfig({ honesty_humility: 0.2, emotionality: 0.9 }),
    );
    expect(s.moodAdaptation!.allowedMoods).toContain('ASSERTIVE');
    expect(s.moodAdaptation!.allowedMoods).toContain('FRUSTRATED');
  });

  it('should include mood prompts for all base moods', () => {
    const prompts = seed.moodAdaptation!.moodPrompts!;
    expect(prompts.NEUTRAL).toBeDefined();
    expect(prompts.FOCUSED).toBeDefined();
    expect(prompts.EMPATHETIC).toBeDefined();
    expect(prompts.CURIOUS).toBeDefined();
    expect(prompts.ANALYTICAL).toBeDefined();
    expect(prompts.CREATIVE).toBeDefined();
    expect(prompts.ASSERTIVE).toBeDefined();
    expect(prompts.FRUSTRATED).toBeDefined();
  });

  // ── Model defaults from inference hierarchy ────────────────────────────

  it('should set model defaults from inference hierarchy primaryModel', () => {
    expect(seed.defaultProviderId).toBe(
      DEFAULT_INFERENCE_HIERARCHY.primaryModel.providerId,
    );
    expect(seed.defaultModelId).toBe(
      DEFAULT_INFERENCE_HIERARCHY.primaryModel.modelId,
    );
  });

  it('should set completion options from inference hierarchy', () => {
    const opts = seed.defaultModelCompletionOptions!;
    expect(opts.temperature).toBe(
      DEFAULT_INFERENCE_HIERARCHY.primaryModel.temperature,
    );
    expect(opts.maxTokens).toBe(
      DEFAULT_INFERENCE_HIERARCHY.primaryModel.maxTokens,
    );
  });

  it('should use default temperature 0.7 when primaryModel has no temperature', () => {
    const config = {
      ...makeConfig(),
      inferenceHierarchy: {
        ...DEFAULT_INFERENCE_HIERARCHY,
        primaryModel: {
          ...DEFAULT_INFERENCE_HIERARCHY.primaryModel,
          temperature: undefined,
        },
      },
    };
    const s = createWunderlandSeed(config);
    expect(s.defaultModelCompletionOptions!.temperature).toBe(0.7);
  });

  it('should use default maxTokens 4096 when primaryModel has no maxTokens', () => {
    const config = {
      ...makeConfig(),
      inferenceHierarchy: {
        ...DEFAULT_INFERENCE_HIERARCHY,
        primaryModel: {
          ...DEFAULT_INFERENCE_HIERARCHY.primaryModel,
          maxTokens: undefined,
        },
      },
    };
    const s = createWunderlandSeed(config);
    expect(s.defaultModelCompletionOptions!.maxTokens).toBe(4096);
  });

  // ── suggestedSkills ────────────────────────────────────────────────────

  it('should set suggestedSkills from config', () => {
    const config = {
      ...makeConfig(),
      suggestedSkills: ['web-search', 'code-exec'],
    };
    const s = createWunderlandSeed(config);
    expect(s.suggestedSkills).toEqual(['web-search', 'code-exec']);
  });

  it('should default suggestedSkills to empty array when not provided', () => {
    expect(seed.suggestedSkills).toEqual([]);
  });

  // ── channelBindings ───────────────────────────────────────────────────

  it('should set channelBindings from config', () => {
    const bindings = [
      {
        platform: 'telegram' as const,
        channelId: 'chan-1',
        isActive: true,
      },
    ];
    const config = { ...makeConfig(), channelBindings: bindings };
    const s = createWunderlandSeed(config);
    expect(s.channelBindings).toEqual(bindings);
  });

  it('should default channelBindings to empty array when not provided', () => {
    expect(seed.channelBindings).toEqual([]);
  });

  // ── Security and hierarchy pass-through ────────────────────────────────

  it('should pass securityProfile through from config', () => {
    expect(seed.securityProfile).toEqual(DEFAULT_SECURITY_PROFILE);
  });

  it('should pass inferenceHierarchy through from config', () => {
    expect(seed.inferenceHierarchy).toEqual(DEFAULT_INFERENCE_HIERARCHY);
  });

  it('should pass stepUpAuthConfig through from config', () => {
    expect(seed.stepUpAuthConfig).toEqual(DEFAULT_STEP_UP_AUTH_CONFIG);
  });

  // ── Modalities and memory defaults ─────────────────────────────────────

  it('should set allowed input/output modalities', () => {
    expect(seed.allowedInputModalities).toEqual([
      'text',
      'audio_transcription',
      'vision_image_url',
    ]);
    expect(seed.allowedOutputModalities).toEqual(['text', 'audio_tts']);
  });

  it('should enable memory with RAG config', () => {
    expect(seed.memoryConfig!.enabled).toBe(true);
    expect(seed.memoryConfig!.ragConfig!.enabled).toBe(true);
    expect(seed.memoryConfig!.ragConfig!.defaultRetrievalStrategy).toBe(
      'similarity',
    );
    expect(seed.memoryConfig!.ragConfig!.defaultRetrievalTopK).toBe(5);
  });
});

// ── createDefaultWunderlandSeed ─────────────────────────────────────────────

describe('createDefaultWunderlandSeed', () => {
  it('should create a seed with a generated UUID seedId', () => {
    const s = createDefaultWunderlandSeed('Default Agent', 'A default agent');
    expect(s.seedId).toMatch(/^seed-[0-9a-f-]{36}$/);
    expect(s.id).toBe(s.seedId);
  });

  it('should generate unique seedIds on each call', () => {
    const s1 = createDefaultWunderlandSeed('Agent A', 'First');
    const s2 = createDefaultWunderlandSeed('Agent B', 'Second');
    expect(s1.seedId).not.toBe(s2.seedId);
  });

  it('should use DEFAULT_SECURITY_PROFILE', () => {
    const s = createDefaultWunderlandSeed('Agent', 'Desc');
    expect(s.securityProfile).toEqual(DEFAULT_SECURITY_PROFILE);
  });

  it('should use DEFAULT_INFERENCE_HIERARCHY', () => {
    const s = createDefaultWunderlandSeed('Agent', 'Desc');
    expect(s.inferenceHierarchy).toEqual(DEFAULT_INFERENCE_HIERARCHY);
  });

  it('should use DEFAULT_STEP_UP_AUTH_CONFIG', () => {
    const s = createDefaultWunderlandSeed('Agent', 'Desc');
    expect(s.stepUpAuthConfig).toEqual(DEFAULT_STEP_UP_AUTH_CONFIG);
  });

  it('should set name and description from arguments', () => {
    const s = createDefaultWunderlandSeed('My Agent', 'Does useful things');
    expect(s.name).toBe('My Agent');
    expect(s.description).toBe('Does useful things');
  });

  it('should accept partial traits and merge with defaults', () => {
    const s = createDefaultWunderlandSeed('Agent', 'Desc', {
      extraversion: 0.9,
      openness: 0.1,
    });
    expect(s.hexacoTraits.extraversion).toBe(0.9);
    expect(s.hexacoTraits.openness).toBe(0.1);
    // Other traits should be defaults
    const defaults = normalizeHEXACOTraits({});
    expect(s.hexacoTraits.honesty_humility).toBe(defaults.honesty_humility);
    expect(s.hexacoTraits.emotionality).toBe(defaults.emotionality);
    expect(s.hexacoTraits.agreeableness).toBe(defaults.agreeableness);
    expect(s.hexacoTraits.conscientiousness).toBe(defaults.conscientiousness);
  });

  it('should work with empty traits object', () => {
    const s = createDefaultWunderlandSeed('Agent', 'Desc', {});
    const defaults = normalizeHEXACOTraits({});
    for (const key of HEXACO_KEYS) {
      expect(s.hexacoTraits[key]).toBe(defaults[key]);
    }
  });

  it('should work with no traits argument', () => {
    const s = createDefaultWunderlandSeed('Agent', 'Desc');
    const defaults = normalizeHEXACOTraits({});
    for (const key of HEXACO_KEYS) {
      expect(s.hexacoTraits[key]).toBe(defaults[key]);
    }
  });

  it('should clamp out-of-range partial traits', () => {
    const s = createDefaultWunderlandSeed('Agent', 'Desc', {
      extraversion: 5.0,
      openness: -2.0,
    });
    expect(s.hexacoTraits.extraversion).toBe(1);
    expect(s.hexacoTraits.openness).toBe(0);
  });

  it('should produce a valid system prompt containing the agent name', () => {
    const s = createDefaultWunderlandSeed('Athena', 'Wisdom agent');
    expect(typeof s.baseSystemPrompt).toBe('string');
    expect(s.baseSystemPrompt as string).toContain('Athena');
  });
});

// ── updateSeedTraits ────────────────────────────────────────────────────────

describe('updateSeedTraits', () => {
  let originalSeed: IWunderlandSeed;

  beforeEach(() => {
    originalSeed = createWunderlandSeed(
      makeConfig({
        honesty_humility: 0.5,
        emotionality: 0.3,
        extraversion: 0.4,
        agreeableness: 0.5,
        conscientiousness: 0.5,
        openness: 0.5,
      }),
    );
  });

  it('should return a new seed with updated traits', () => {
    const updated = updateSeedTraits(originalSeed, { extraversion: 0.9 });
    expect(updated).not.toBe(originalSeed);
    expect(updated.hexacoTraits.extraversion).toBe(0.9);
  });

  it('should preserve seedId', () => {
    const updated = updateSeedTraits(originalSeed, { extraversion: 0.9 });
    expect(updated.seedId).toBe(originalSeed.seedId);
    expect(updated.id).toBe(originalSeed.id);
  });

  it('should preserve name', () => {
    const updated = updateSeedTraits(originalSeed, { extraversion: 0.9 });
    expect(updated.name).toBe(originalSeed.name);
  });

  it('should preserve description', () => {
    const updated = updateSeedTraits(originalSeed, { extraversion: 0.9 });
    expect(updated.description).toBe(originalSeed.description);
  });

  it('should preserve securityProfile', () => {
    const updated = updateSeedTraits(originalSeed, { extraversion: 0.9 });
    expect(updated.securityProfile).toEqual(originalSeed.securityProfile);
  });

  it('should preserve inferenceHierarchy', () => {
    const updated = updateSeedTraits(originalSeed, { extraversion: 0.9 });
    expect(updated.inferenceHierarchy).toEqual(originalSeed.inferenceHierarchy);
  });

  it('should preserve stepUpAuthConfig', () => {
    const updated = updateSeedTraits(originalSeed, { extraversion: 0.9 });
    expect(updated.stepUpAuthConfig).toEqual(originalSeed.stepUpAuthConfig);
  });

  it('should preserve channelBindings', () => {
    const seedWithBindings = createWunderlandSeed({
      ...makeConfig(),
      channelBindings: [
        { platform: 'discord', channelId: 'ch-1', isActive: true },
      ],
    });
    const updated = updateSeedTraits(seedWithBindings, { openness: 0.9 });
    expect(updated.channelBindings).toEqual(seedWithBindings.channelBindings);
  });

  it('should preserve suggestedSkills', () => {
    const seedWithSkills = createWunderlandSeed({
      ...makeConfig(),
      suggestedSkills: ['skill-a', 'skill-b'],
    });
    const updated = updateSeedTraits(seedWithSkills, { openness: 0.9 });
    expect(updated.suggestedSkills).toEqual(seedWithSkills.suggestedSkills);
  });

  it('should regenerate personality traits after update', () => {
    const updated = updateSeedTraits(originalSeed, { extraversion: 0.95 });
    expect(updated.personalityTraits).not.toEqual(
      originalSeed.personalityTraits,
    );
    // Verify the derived humor_level changes with extraversion
    expect(updated.personalityTraits!.humor_level).not.toBe(
      originalSeed.personalityTraits!.humor_level,
    );
  });

  it('should regenerate mood config after update', () => {
    // Original has extraversion 0.4, default mood should be NEUTRAL
    expect(originalSeed.moodAdaptation!.defaultMood).toBe('NEUTRAL');

    // Update to high extraversion => CREATIVE
    const updated = updateSeedTraits(originalSeed, { extraversion: 0.9 });
    expect(updated.moodAdaptation!.defaultMood).toBe('CREATIVE');
  });

  it('should regenerate system prompt after update', () => {
    const updated = updateSeedTraits(originalSeed, { extraversion: 0.9 });
    // The prompt should still contain the agent name
    expect(updated.baseSystemPrompt as string).toContain(originalSeed.name);
    // But the prompt text may differ because personality guidelines change
    expect(updated.baseSystemPrompt).not.toBe(originalSeed.baseSystemPrompt);
  });

  it('should merge partial trait updates with existing traits', () => {
    const updated = updateSeedTraits(originalSeed, { openness: 0.95 });
    // Updated trait
    expect(updated.hexacoTraits.openness).toBe(0.95);
    // Unchanged traits preserved
    expect(updated.hexacoTraits.honesty_humility).toBe(
      originalSeed.hexacoTraits.honesty_humility,
    );
    expect(updated.hexacoTraits.emotionality).toBe(
      originalSeed.hexacoTraits.emotionality,
    );
    expect(updated.hexacoTraits.extraversion).toBe(
      originalSeed.hexacoTraits.extraversion,
    );
    expect(updated.hexacoTraits.agreeableness).toBe(
      originalSeed.hexacoTraits.agreeableness,
    );
    expect(updated.hexacoTraits.conscientiousness).toBe(
      originalSeed.hexacoTraits.conscientiousness,
    );
  });

  it('should normalize out-of-range trait updates', () => {
    const updated = updateSeedTraits(originalSeed, {
      extraversion: 2.0,
      openness: -1.0,
    });
    expect(updated.hexacoTraits.extraversion).toBe(1);
    expect(updated.hexacoTraits.openness).toBe(0);
  });

  it('should update multiple traits at once', () => {
    const updated = updateSeedTraits(originalSeed, {
      honesty_humility: 0.1,
      emotionality: 0.9,
      extraversion: 0.8,
    });
    expect(updated.hexacoTraits.honesty_humility).toBe(0.1);
    expect(updated.hexacoTraits.emotionality).toBe(0.9);
    expect(updated.hexacoTraits.extraversion).toBe(0.8);
    // ASSERTIVE should be added (honesty_humility < 0.5)
    expect(updated.moodAdaptation!.allowedMoods).toContain('ASSERTIVE');
    // FRUSTRATED should be added (emotionality > 0.7)
    expect(updated.moodAdaptation!.allowedMoods).toContain('FRUSTRATED');
    // Default mood should be CREATIVE (extraversion > 0.7)
    expect(updated.moodAdaptation!.defaultMood).toBe('CREATIVE');
  });

  it('should not mutate the original seed', () => {
    const originalTraits = { ...originalSeed.hexacoTraits };
    const originalMood = originalSeed.moodAdaptation!.defaultMood;

    updateSeedTraits(originalSeed, { extraversion: 0.99 });

    expect(originalSeed.hexacoTraits).toEqual(originalTraits);
    expect(originalSeed.moodAdaptation!.defaultMood).toBe(originalMood);
  });
});

// ── HEXACO_PRESETS ──────────────────────────────────────────────────────────

describe('HEXACO_PRESETS', () => {
  const EXPECTED_PRESET_KEYS = [
    'HELPFUL_ASSISTANT',
    'CREATIVE_THINKER',
    'ANALYTICAL_RESEARCHER',
    'EMPATHETIC_COUNSELOR',
    'DECISIVE_EXECUTOR',
  ] as const;

  it('should contain all 5 preset keys', () => {
    for (const key of EXPECTED_PRESET_KEYS) {
      expect(HEXACO_PRESETS).toHaveProperty(key);
    }
    expect(Object.keys(HEXACO_PRESETS)).toHaveLength(5);
  });

  it.each(EXPECTED_PRESET_KEYS)(
    'preset %s should have all 6 HEXACO trait fields',
    (presetKey) => {
      const preset = HEXACO_PRESETS[presetKey];
      for (const traitKey of HEXACO_KEYS) {
        expect(preset).toHaveProperty(traitKey);
        expect(typeof preset[traitKey]).toBe('number');
      }
    },
  );

  it.each(EXPECTED_PRESET_KEYS)(
    'preset %s should have all trait values between 0 and 1',
    (presetKey) => {
      const preset = HEXACO_PRESETS[presetKey];
      for (const traitKey of HEXACO_KEYS) {
        expect(preset[traitKey]).toBeGreaterThanOrEqual(0);
        expect(preset[traitKey]).toBeLessThanOrEqual(1);
      }
    },
  );

  it('HELPFUL_ASSISTANT should have high conscientiousness and agreeableness', () => {
    expect(HEXACO_PRESETS.HELPFUL_ASSISTANT.conscientiousness).toBeGreaterThan(
      0.7,
    );
    expect(HEXACO_PRESETS.HELPFUL_ASSISTANT.agreeableness).toBeGreaterThan(0.7);
  });

  it('CREATIVE_THINKER should have high openness', () => {
    expect(HEXACO_PRESETS.CREATIVE_THINKER.openness).toBeGreaterThan(0.7);
  });

  it('ANALYTICAL_RESEARCHER should have high conscientiousness and low emotionality', () => {
    expect(
      HEXACO_PRESETS.ANALYTICAL_RESEARCHER.conscientiousness,
    ).toBeGreaterThan(0.7);
    expect(HEXACO_PRESETS.ANALYTICAL_RESEARCHER.emotionality).toBeLessThan(0.5);
  });

  it('EMPATHETIC_COUNSELOR should have high agreeableness and emotionality', () => {
    expect(HEXACO_PRESETS.EMPATHETIC_COUNSELOR.agreeableness).toBeGreaterThan(
      0.7,
    );
    expect(HEXACO_PRESETS.EMPATHETIC_COUNSELOR.emotionality).toBeGreaterThan(
      0.7,
    );
  });

  it('DECISIVE_EXECUTOR should have high extraversion and moderate-to-low agreeableness', () => {
    expect(HEXACO_PRESETS.DECISIVE_EXECUTOR.extraversion).toBeGreaterThan(0.7);
    expect(HEXACO_PRESETS.DECISIVE_EXECUTOR.agreeableness).toBeLessThan(0.5);
  });

  it('all presets should produce valid seeds via createWunderlandSeed', () => {
    for (const presetKey of EXPECTED_PRESET_KEYS) {
      const s = createWunderlandSeed({
        seedId: `preset-${presetKey}`,
        name: presetKey,
        description: `Preset agent: ${presetKey}`,
        hexacoTraits: HEXACO_PRESETS[presetKey],
        securityProfile: DEFAULT_SECURITY_PROFILE,
        inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
        stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
      });
      expect(s.seedId).toBe(`preset-${presetKey}`);
      expect(s.hexacoTraits).toBeDefined();
      expect(s.moodAdaptation).toBeDefined();
      expect(s.personalityTraits).toBeDefined();
      expect(typeof s.baseSystemPrompt).toBe('string');
    }
  });
});
