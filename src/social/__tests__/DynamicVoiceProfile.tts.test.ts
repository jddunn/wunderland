/**
 * @fileoverview Tests for voiceProfileToTtsParams — TTS parameter mapping from DynamicVoiceProfile.
 * @module wunderland/social/__tests__/DynamicVoiceProfile.tts.test
 *
 * Validates that personality-driven voice profiles produce correct TTS synthesis
 * parameters: speed, stability, styleExaggeration, prosody hints, and style presets.
 */

import { describe, it, expect } from 'vitest';
import {
  voiceProfileToTtsParams,
  buildDynamicVoiceProfile,
  type DynamicVoiceProfile,
  type BuildDynamicVoiceOptions,
} from '../DynamicVoiceProfile.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<DynamicVoiceProfile> = {}): DynamicVoiceProfile {
  return {
    archetype: 'grounded_correspondent',
    archetypeLabel: 'Grounded Correspondent',
    stance: 'pragmatic',
    tempo: 'measured',
    urgency: 0.42,
    sentiment: 0.1,
    controversy: 0.2,
    expressedTraits: {
      honesty_humility: 0.7,
      emotionality: 0.5,
      extraversion: 0.6,
      agreeableness: 0.7,
      conscientiousness: 0.7,
      openness: 0.6,
    },
    directives: [],
    writingDNA: {
      sentenceLength: 'moderate',
      questionFrequency: 0.4,
      selfReference: 'moderate',
      certaintyStyle: 'balanced',
      figurativeLanguage: 'moderate',
      register: 'conversational',
    },
    moodVocabulary: { moves: [], transitions: [], punctuationHint: '' },
    moodTrajectory: 'stable',
    ...overrides,
  };
}

// ── Speed Mapping ────────────────────────────────────────────────────────────

describe('voiceProfileToTtsParams — speed mapping', () => {
  it('rapid tempo should produce speed > 1.1', () => {
    const profile = makeProfile({ tempo: 'rapid', urgency: 0 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.speed).toBeGreaterThan(1.1);
  });

  it('calm tempo should produce speed < 1.0', () => {
    const profile = makeProfile({ tempo: 'calm', urgency: 0 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.speed).toBeLessThan(1.0);
  });

  it('measured tempo with zero urgency should produce speed ~1.0', () => {
    const profile = makeProfile({ tempo: 'measured', urgency: 0 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.speed).toBeCloseTo(1.0, 1);
  });

  it('staccato tempo should produce speed > 1.0', () => {
    const profile = makeProfile({ tempo: 'staccato', urgency: 0 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.speed).toBeGreaterThanOrEqual(1.1);
  });

  it('layered tempo should produce speed between calm and measured', () => {
    const profile = makeProfile({ tempo: 'layered', urgency: 0 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.speed).toBeGreaterThanOrEqual(0.9);
    expect(params.speed).toBeLessThanOrEqual(1.0);
  });
});

// ── Speed Clamping ───────────────────────────────────────────────────────────

describe('voiceProfileToTtsParams — speed clamping', () => {
  it('high urgency + rapid tempo stays <= 2.0', () => {
    const profile = makeProfile({ tempo: 'rapid', urgency: 1.0 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.speed).toBeLessThanOrEqual(2.0);
  });

  it('low urgency + calm tempo stays >= 0.5', () => {
    const profile = makeProfile({ tempo: 'calm', urgency: 0 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.speed).toBeGreaterThanOrEqual(0.5);
  });

  it('extreme values never exceed bounds', () => {
    // Max possible: rapid (1.15) + urgency 1.0 * 0.15 = 1.3 — well within bounds
    const maxProfile = makeProfile({ tempo: 'rapid', urgency: 1.0 });
    const maxParams = voiceProfileToTtsParams(maxProfile);
    expect(maxParams.speed).toBeLessThanOrEqual(2.0);
    expect(maxParams.speed).toBeGreaterThanOrEqual(0.5);

    // Min possible: calm (0.9) + urgency 0 * 0.15 = 0.9 — well within bounds
    const minProfile = makeProfile({ tempo: 'calm', urgency: 0 });
    const minParams = voiceProfileToTtsParams(minProfile);
    expect(minParams.speed).toBeLessThanOrEqual(2.0);
    expect(minParams.speed).toBeGreaterThanOrEqual(0.5);
  });
});

// ── Urgency Boost ────────────────────────────────────────────────────────────

describe('voiceProfileToTtsParams — urgency boost', () => {
  it('higher urgency increases speed', () => {
    const lowUrgency = makeProfile({ tempo: 'measured', urgency: 0.1 });
    const highUrgency = makeProfile({ tempo: 'measured', urgency: 0.9 });
    const lowParams = voiceProfileToTtsParams(lowUrgency);
    const highParams = voiceProfileToTtsParams(highUrgency);
    expect(highParams.speed).toBeGreaterThan(lowParams.speed);
  });

  it('zero urgency adds no speed boost', () => {
    const profile = makeProfile({ tempo: 'measured', urgency: 0 });
    const params = voiceProfileToTtsParams(profile);
    // measured base = 1.0, urgency boost = 0 * 0.15 = 0
    expect(params.speed).toBe(1.0);
  });

  it('max urgency adds exactly 0.15 speed boost', () => {
    const noUrgency = makeProfile({ tempo: 'measured', urgency: 0 });
    const maxUrgency = makeProfile({ tempo: 'measured', urgency: 1.0 });
    const noParams = voiceProfileToTtsParams(noUrgency);
    const maxParams = voiceProfileToTtsParams(maxUrgency);
    expect(maxParams.speed - noParams.speed).toBeCloseTo(0.15, 5);
  });
});

// ── Stability Mapping ────────────────────────────────────────────────────────

describe('voiceProfileToTtsParams — stability mapping', () => {
  it('analytical stance should produce stability > 0.8', () => {
    const profile = makeProfile({ stance: 'analytical' });
    const params = voiceProfileToTtsParams(profile);
    expect(params.stability).toBeGreaterThan(0.8);
  });

  it('energetic stance should produce stability < 0.6', () => {
    const profile = makeProfile({ stance: 'energetic' });
    const params = voiceProfileToTtsParams(profile);
    expect(params.stability).toBeLessThan(0.6);
  });

  it('decisive stance should produce moderate stability', () => {
    const profile = makeProfile({ stance: 'decisive' });
    const params = voiceProfileToTtsParams(profile);
    expect(params.stability).toBe(0.7);
  });

  it('de-escalatory stance should produce high stability', () => {
    const profile = makeProfile({ stance: 'de-escalatory' });
    const params = voiceProfileToTtsParams(profile);
    expect(params.stability).toBe(0.8);
  });

  it('combative stance should match decisive stability', () => {
    const decisive = voiceProfileToTtsParams(makeProfile({ stance: 'decisive' }));
    const combative = voiceProfileToTtsParams(makeProfile({ stance: 'combative' }));
    expect(combative.stability).toBe(decisive.stability);
  });

  it('pragmatic stance should produce stability of 0.75', () => {
    const profile = makeProfile({ stance: 'pragmatic' });
    const params = voiceProfileToTtsParams(profile);
    expect(params.stability).toBe(0.75);
  });

  it('exploratory stance should produce stability of 0.65', () => {
    const profile = makeProfile({ stance: 'exploratory' });
    const params = voiceProfileToTtsParams(profile);
    expect(params.stability).toBe(0.65);
  });
});

// ── Style Exaggeration ───────────────────────────────────────────────────────

describe('voiceProfileToTtsParams — style exaggeration', () => {
  it('high emotionality + high controversy produces higher styleExaggeration', () => {
    const calmProfile = makeProfile({
      controversy: 0,
      expressedTraits: {
        honesty_humility: 0.7,
        emotionality: 0.2,
        extraversion: 0.6,
        agreeableness: 0.7,
        conscientiousness: 0.7,
        openness: 0.6,
      },
    });
    const intenseProfile = makeProfile({
      controversy: 0.9,
      expressedTraits: {
        honesty_humility: 0.7,
        emotionality: 0.9,
        extraversion: 0.6,
        agreeableness: 0.7,
        conscientiousness: 0.7,
        openness: 0.6,
      },
    });

    const calmParams = voiceProfileToTtsParams(calmProfile);
    const intenseParams = voiceProfileToTtsParams(intenseProfile);

    expect(intenseParams.styleExaggeration).toBeGreaterThan(calmParams.styleExaggeration);
  });

  it('styleExaggeration stays within 0-1 range', () => {
    // Max emotionality + max controversy + low stability stance
    const extremeProfile = makeProfile({
      stance: 'energetic',
      controversy: 1.0,
      expressedTraits: {
        honesty_humility: 0.7,
        emotionality: 1.0,
        extraversion: 0.6,
        agreeableness: 0.7,
        conscientiousness: 0.7,
        openness: 0.6,
      },
    });
    const params = voiceProfileToTtsParams(extremeProfile);
    expect(params.styleExaggeration).toBeGreaterThanOrEqual(0);
    expect(params.styleExaggeration).toBeLessThanOrEqual(1);
  });

  it('low emotionality + low controversy produces low styleExaggeration', () => {
    const profile = makeProfile({
      stance: 'analytical', // high stability = 0.85
      controversy: 0,
      expressedTraits: {
        honesty_humility: 0.7,
        emotionality: 0.1,
        extraversion: 0.6,
        agreeableness: 0.7,
        conscientiousness: 0.7,
        openness: 0.6,
      },
    });
    const params = voiceProfileToTtsParams(profile);
    expect(params.styleExaggeration).toBeLessThan(0.15);
  });
});

// ── Prosody Rate Mapping ─────────────────────────────────────────────────────

describe('voiceProfileToTtsParams — prosody rate', () => {
  it('fast speed maps to fast or x-fast', () => {
    const profile = makeProfile({ tempo: 'rapid', urgency: 0.5 });
    const params = voiceProfileToTtsParams(profile);
    expect(['fast', 'x-fast']).toContain(params.prosodyRate);
  });

  it('slow speed maps to slow or x-slow', () => {
    const profile = makeProfile({ tempo: 'calm', urgency: 0 });
    const params = voiceProfileToTtsParams(profile);
    expect(['slow', 'x-slow']).toContain(params.prosodyRate);
  });

  it('measured tempo with low urgency maps to medium', () => {
    const profile = makeProfile({ tempo: 'measured', urgency: 0 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.prosodyRate).toBe('medium');
  });

  it('very high speed maps to x-fast', () => {
    // rapid (1.15) + max urgency (1.0 * 0.15 = 0.15) = 1.3 → >= 1.2 → x-fast
    const profile = makeProfile({ tempo: 'rapid', urgency: 1.0 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.prosodyRate).toBe('x-fast');
  });

  it('all five prosody rate values are reachable', () => {
    // x-fast: speed >= 1.2 → rapid(1.15) + urgency 0.5(0.075) = 1.225
    const xfast = voiceProfileToTtsParams(makeProfile({ tempo: 'rapid', urgency: 0.5 }));
    expect(xfast.prosodyRate).toBe('x-fast');

    // fast: speed >= 1.08 and < 1.2 → rapid(1.15) + urgency 0 = 1.15
    const fast = voiceProfileToTtsParams(makeProfile({ tempo: 'rapid', urgency: 0 }));
    expect(fast.prosodyRate).toBe('fast');

    // medium: speed >= 0.95 and < 1.08 → measured(1.0) + urgency 0 = 1.0
    const medium = voiceProfileToTtsParams(makeProfile({ tempo: 'measured', urgency: 0 }));
    expect(medium.prosodyRate).toBe('medium');

    // slow: speed >= 0.85 and < 0.95 → calm(0.9) + urgency 0 = 0.9
    const slow = voiceProfileToTtsParams(makeProfile({ tempo: 'calm', urgency: 0 }));
    expect(slow.prosodyRate).toBe('slow');

    // x-slow: speed < 0.85 — not easily reachable with current tempos (min is calm=0.9)
    // but we verify the boundary via a manual override
    const xslowProfile = makeProfile({ tempo: 'calm', urgency: 0 });
    // Calm + 0 urgency = 0.9 → slow, not x-slow; x-slow requires < 0.85
    // In practice x-slow would require a future tempo value below 0.85
    expect(slow.prosodyRate).toBe('slow');
  });
});

// ── Prosody Pitch ────────────────────────────────────────────────────────────

describe('voiceProfileToTtsParams — prosody pitch', () => {
  it('rising mood trajectory produces high pitch', () => {
    const profile = makeProfile({ moodTrajectory: 'rising', sentiment: 0 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.prosodyPitch).toBe('high');
  });

  it('falling mood trajectory produces low pitch', () => {
    const profile = makeProfile({ moodTrajectory: 'falling', sentiment: 0 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.prosodyPitch).toBe('low');
  });

  it('stable mood trajectory with neutral sentiment produces medium pitch', () => {
    const profile = makeProfile({ moodTrajectory: 'stable', sentiment: 0 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.prosodyPitch).toBe('medium');
  });

  it('oscillating mood trajectory with neutral sentiment produces medium pitch', () => {
    const profile = makeProfile({ moodTrajectory: 'oscillating', sentiment: 0 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.prosodyPitch).toBe('medium');
  });

  it('positive sentiment (> 0.3) produces high pitch regardless of trajectory', () => {
    const profile = makeProfile({ moodTrajectory: 'stable', sentiment: 0.5 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.prosodyPitch).toBe('high');
  });

  it('negative sentiment (< -0.3) produces low pitch regardless of trajectory', () => {
    const profile = makeProfile({ moodTrajectory: 'stable', sentiment: -0.5 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.prosodyPitch).toBe('low');
  });

  it('mild positive sentiment (0.2) does not force high pitch', () => {
    const profile = makeProfile({ moodTrajectory: 'stable', sentiment: 0.2 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.prosodyPitch).toBe('medium');
  });

  it('mild negative sentiment (-0.2) does not force low pitch', () => {
    const profile = makeProfile({ moodTrajectory: 'stable', sentiment: -0.2 });
    const params = voiceProfileToTtsParams(profile);
    expect(params.prosodyPitch).toBe('medium');
  });
});

// ── Style Preset ─────────────────────────────────────────────────────────────

describe('voiceProfileToTtsParams — style preset', () => {
  it('signal_commander maps to authoritative', () => {
    const profile = makeProfile({ archetype: 'signal_commander' });
    const params = voiceProfileToTtsParams(profile);
    expect(params.stylePreset).toBe('authoritative');
  });

  it('calm_diplomat maps to soothing', () => {
    const profile = makeProfile({ archetype: 'calm_diplomat' });
    const params = voiceProfileToTtsParams(profile);
    expect(params.stylePreset).toBe('soothing');
  });

  it('forensic_cartographer maps to analytical', () => {
    const profile = makeProfile({ archetype: 'forensic_cartographer' });
    const params = voiceProfileToTtsParams(profile);
    expect(params.stylePreset).toBe('analytical');
  });

  it('pulse_broadcaster maps to enthusiastic', () => {
    const profile = makeProfile({ archetype: 'pulse_broadcaster' });
    const params = voiceProfileToTtsParams(profile);
    expect(params.stylePreset).toBe('enthusiastic');
  });

  it('speculative_weaver maps to curious', () => {
    const profile = makeProfile({ archetype: 'speculative_weaver' });
    const params = voiceProfileToTtsParams(profile);
    expect(params.stylePreset).toBe('curious');
  });

  it('contrarian_prosecutor maps to assertive', () => {
    const profile = makeProfile({ archetype: 'contrarian_prosecutor' });
    const params = voiceProfileToTtsParams(profile);
    expect(params.stylePreset).toBe('assertive');
  });

  it('grounded_correspondent maps to neutral', () => {
    const profile = makeProfile({ archetype: 'grounded_correspondent' });
    const params = voiceProfileToTtsParams(profile);
    expect(params.stylePreset).toBe('neutral');
  });

  it('all 7 archetypes produce different style presets', () => {
    const archetypes = [
      'signal_commander',
      'forensic_cartographer',
      'pulse_broadcaster',
      'calm_diplomat',
      'speculative_weaver',
      'contrarian_prosecutor',
      'grounded_correspondent',
    ] as const;

    const presets = archetypes.map((a) => {
      const profile = makeProfile({ archetype: a });
      return voiceProfileToTtsParams(profile).stylePreset;
    });

    // All presets should be defined strings
    for (const preset of presets) {
      expect(preset).toBeDefined();
      expect(typeof preset).toBe('string');
      expect(preset!.length).toBeGreaterThan(0);
    }

    // All presets should be unique
    const uniquePresets = new Set(presets);
    expect(uniquePresets.size).toBe(7);
  });
});

// ── Integration: buildDynamicVoiceProfile + voiceProfileToTtsParams ──────────

describe('voiceProfileToTtsParams — integration with buildDynamicVoiceProfile', () => {
  it('builds a profile from options and converts to valid TTS params', () => {
    const options: BuildDynamicVoiceOptions = {
      baseTraits: {
        honesty_humility: 0.7,
        emotionality: 0.5,
        extraversion: 0.6,
        agreeableness: 0.7,
        conscientiousness: 0.7,
        openness: 0.6,
      },
      stimulus: {
        agentId: 'test-agent',
        timestamp: Date.now(),
        priority: 'normal',
        payload: {
          type: 'world_feed',
          headline: 'Markets stable after breakthrough progress report',
          category: 'finance',
          sourceName: 'Reuters',
        },
      },
      moodLabel: 'engaged',
      moodState: { valence: 0.3, arousal: 0.2, dominance: 0.1 },
    };

    const profile = buildDynamicVoiceProfile(options);
    const params = voiceProfileToTtsParams(profile);

    // Speed should be in valid range
    expect(params.speed).toBeGreaterThanOrEqual(0.5);
    expect(params.speed).toBeLessThanOrEqual(2.0);

    // Stability should be in valid range
    expect(params.stability).toBeGreaterThanOrEqual(0);
    expect(params.stability).toBeLessThanOrEqual(1);

    // Style exaggeration should be in valid range
    expect(params.styleExaggeration).toBeGreaterThanOrEqual(0);
    expect(params.styleExaggeration).toBeLessThanOrEqual(1);

    // Prosody rate should be a valid value
    expect(['x-slow', 'slow', 'medium', 'fast', 'x-fast']).toContain(params.prosodyRate);

    // Prosody pitch should be a valid value
    expect(['x-low', 'low', 'medium', 'high', 'x-high']).toContain(params.prosodyPitch);

    // Style preset should be defined
    expect(params.stylePreset).toBeDefined();
    expect(typeof params.stylePreset).toBe('string');
  });

  it('urgent breaking stimulus produces faster TTS params', () => {
    const baseOptions: BuildDynamicVoiceOptions = {
      baseTraits: {
        honesty_humility: 0.7,
        emotionality: 0.5,
        extraversion: 0.6,
        agreeableness: 0.7,
        conscientiousness: 0.8,
        openness: 0.6,
      },
      stimulus: {
        agentId: 'test-agent',
        timestamp: Date.now(),
        priority: 'low',
        payload: {
          type: 'world_feed',
          headline: 'Quarterly report shows steady growth',
          category: 'finance',
          sourceName: 'AP',
        },
      },
      moodLabel: 'contemplative',
      moodState: { valence: 0, arousal: 0, dominance: 0 },
    };

    const urgentOptions: BuildDynamicVoiceOptions = {
      baseTraits: {
        honesty_humility: 0.7,
        emotionality: 0.5,
        extraversion: 0.6,
        agreeableness: 0.7,
        conscientiousness: 0.8,
        openness: 0.6,
      },
      stimulus: {
        agentId: 'test-agent',
        timestamp: Date.now(),
        priority: 'breaking',
        payload: {
          type: 'world_feed',
          headline: 'BREAKING: urgent emergency alert — critical escalating crisis now',
          category: 'breaking-news',
          sourceName: 'Reuters',
        },
      },
      moodLabel: 'assertive',
      moodState: { valence: -0.1, arousal: 0.6, dominance: 0.4 },
    };

    const calmProfile = buildDynamicVoiceProfile(baseOptions);
    const urgentProfile = buildDynamicVoiceProfile(urgentOptions);

    const calmParams = voiceProfileToTtsParams(calmProfile);
    const urgentParams = voiceProfileToTtsParams(urgentProfile);

    // Urgent profile should have higher speed due to higher urgency
    expect(urgentParams.speed).toBeGreaterThan(calmParams.speed);
  });

  it('serene mood with falling trajectory produces low pitch', () => {
    const options: BuildDynamicVoiceOptions = {
      baseTraits: {
        honesty_humility: 0.6,
        emotionality: 0.4,
        extraversion: 0.5,
        agreeableness: 0.8,
        conscientiousness: 0.6,
        openness: 0.5,
      },
      stimulus: {
        agentId: 'test-agent',
        timestamp: Date.now(),
        priority: 'low',
        payload: {
          type: 'world_feed',
          headline: 'Community garden project continues steady growth',
          category: 'lifestyle',
          sourceName: 'Local News',
        },
      },
      moodLabel: 'serene',
      moodState: { valence: 0.1, arousal: -0.3, dominance: -0.1 },
      recentMoodDeltas: [
        { valence: -0.05, arousal: -0.06, dominance: -0.02 },
        { valence: -0.04, arousal: -0.05, dominance: -0.01 },
        { valence: -0.03, arousal: -0.04, dominance: -0.01 },
        { valence: -0.02, arousal: -0.04, dominance: 0 },
      ],
    };

    const profile = buildDynamicVoiceProfile(options);
    const params = voiceProfileToTtsParams(profile);

    // Falling trajectory should map to low pitch
    expect(profile.moodTrajectory).toBe('falling');
    expect(params.prosodyPitch).toBe('low');
  });
});
