/**
 * @fileoverview Tests for MoodEngine — PAD mood model for Wunderland agents
 * @module wunderland/social/__tests__/MoodEngine.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MoodEngine, type MoodDelta, type MoodLabel } from '../MoodEngine.js';
import type { HEXACOTraits } from '../../core/types.js';

/**
 * Factory function to create HEXACO traits with defaults.
 */
function createTraits(overrides: Partial<HEXACOTraits> = {}): HEXACOTraits {
  return {
    honesty_humility: 0.5,
    emotionality: 0.5,
    extraversion: 0.5,
    agreeableness: 0.5,
    conscientiousness: 0.5,
    openness: 0.5,
    ...overrides,
  };
}

describe('MoodEngine', () => {
  let engine: MoodEngine;

  beforeEach(() => {
    engine = new MoodEngine();
  });

  describe('initializeAgent', () => {
    it('should set baseline correctly based on HEXACO traits', () => {
      // High agreeableness + high honesty -> positive valence
      // High emotionality + high extraversion -> higher arousal
      // High extraversion - low agreeableness -> positive dominance
      const traits = createTraits({
        honesty_humility: 0.8,
        emotionality: 0.7,
        extraversion: 0.9,
        agreeableness: 0.6,
      });

      engine.initializeAgent('seed-1', traits);
      const baseline = engine.getBaseline('seed-1');
      const state = engine.getState('seed-1');

      expect(baseline).toBeDefined();
      expect(state).toBeDefined();

      // valence = A * 0.4 + H * 0.2 - 0.1 = 0.6 * 0.4 + 0.8 * 0.2 - 0.1 = 0.30
      expect(baseline!.valence).toBeCloseTo(0.30, 2);

      // arousal = E * 0.3 + X * 0.3 - 0.1 = 0.7 * 0.3 + 0.9 * 0.3 - 0.1 = 0.38
      expect(baseline!.arousal).toBeCloseTo(0.38, 2);

      // dominance = X * 0.4 - A * 0.2 = 0.9 * 0.4 - 0.6 * 0.2 = 0.24
      expect(baseline!.dominance).toBeCloseTo(0.24, 2);

      // State should equal baseline initially
      expect(state!.valence).toBe(baseline!.valence);
      expect(state!.arousal).toBe(baseline!.arousal);
      expect(state!.dominance).toBe(baseline!.dominance);
    });

    it('should clamp baseline values to [-1, 1]', () => {
      // Create extreme traits that might produce out-of-range values
      const traits = createTraits({
        honesty_humility: 1.0,
        emotionality: 1.0,
        extraversion: 1.0,
        agreeableness: 1.0,
        conscientiousness: 1.0,
        openness: 1.0,
      });

      engine.initializeAgent('seed-extreme', traits);
      const baseline = engine.getBaseline('seed-extreme');

      expect(baseline).toBeDefined();
      expect(baseline!.valence).toBeGreaterThanOrEqual(-1);
      expect(baseline!.valence).toBeLessThanOrEqual(1);
      expect(baseline!.arousal).toBeGreaterThanOrEqual(-1);
      expect(baseline!.arousal).toBeLessThanOrEqual(1);
      expect(baseline!.dominance).toBeGreaterThanOrEqual(-1);
      expect(baseline!.dominance).toBeLessThanOrEqual(1);
    });

    it('should cache HEXACO traits for mood label lookups', () => {
      const traits = createTraits({ openness: 0.85, conscientiousness: 0.75 });
      engine.initializeAgent('seed-1', traits);

      const cachedTraits = engine.getTraits('seed-1');
      expect(cachedTraits).toBeDefined();
      expect(cachedTraits!.openness).toBe(0.85);
      expect(cachedTraits!.conscientiousness).toBe(0.75);
    });
  });

  describe('applyDelta', () => {
    beforeEach(() => {
      const traits = createTraits({ emotionality: 0.5 });
      engine.initializeAgent('seed-1', traits);
    });

    it('should modify state with emotionality scaling', () => {
      const initialState = engine.getState('seed-1');
      expect(initialState).toBeDefined();

      // Sensitivity = 0.5 + emotionality * 0.8 = 0.5 + 0.5 * 0.8 = 0.9
      const delta: MoodDelta = {
        valence: 0.2,
        arousal: 0.1,
        dominance: 0.05,
        trigger: 'test delta',
      };

      engine.applyDelta('seed-1', delta);
      const newState = engine.getState('seed-1');

      expect(newState).toBeDefined();
      // New valence = initial + delta * sensitivity
      expect(newState!.valence).toBeCloseTo(initialState!.valence + 0.2 * 0.9, 5);
      expect(newState!.arousal).toBeCloseTo(initialState!.arousal + 0.1 * 0.9, 5);
      expect(newState!.dominance).toBeCloseTo(initialState!.dominance + 0.05 * 0.9, 5);
    });

    it('should apply higher deltas for high-emotionality agents', () => {
      // Initialize another agent with high emotionality
      const highETraits = createTraits({ emotionality: 1.0 });
      engine.initializeAgent('seed-high-e', highETraits);

      const initialStateLow = engine.getState('seed-1');
      const initialStateHigh = engine.getState('seed-high-e');

      const delta: MoodDelta = {
        valence: 0.3,
        arousal: 0,
        dominance: 0,
        trigger: 'same delta',
      };

      engine.applyDelta('seed-1', delta);
      engine.applyDelta('seed-high-e', delta);

      const finalStateLow = engine.getState('seed-1');
      const finalStateHigh = engine.getState('seed-high-e');

      // High emotionality agent should have bigger change
      // Low: sensitivity = 0.9, High: sensitivity = 1.3
      const changeLow = finalStateLow!.valence - initialStateLow!.valence;
      const changeHigh = finalStateHigh!.valence - initialStateHigh!.valence;

      expect(changeHigh).toBeGreaterThan(changeLow);
      expect(changeLow).toBeCloseTo(0.3 * 0.9, 5);
      expect(changeHigh).toBeCloseTo(0.3 * 1.3, 5);
    });

    it('should clamp values to [-1, 1]', () => {
      // Apply a very large positive delta
      const largeDelta: MoodDelta = {
        valence: 10,
        arousal: 10,
        dominance: 10,
        trigger: 'extreme positive',
      };

      engine.applyDelta('seed-1', largeDelta);
      const state = engine.getState('seed-1');

      expect(state!.valence).toBe(1);
      expect(state!.arousal).toBe(1);
      expect(state!.dominance).toBe(1);

      // Apply a very large negative delta
      const negDelta: MoodDelta = {
        valence: -20,
        arousal: -20,
        dominance: -20,
        trigger: 'extreme negative',
      };

      engine.applyDelta('seed-1', negDelta);
      const stateAfter = engine.getState('seed-1');

      expect(stateAfter!.valence).toBe(-1);
      expect(stateAfter!.arousal).toBe(-1);
      expect(stateAfter!.dominance).toBe(-1);
    });

    it('should emit mood_change event with delta details', () => {
      const events: unknown[] = [];
      engine.on('mood_change', (event) => events.push(event));

      const delta: MoodDelta = {
        valence: 0.1,
        arousal: 0.05,
        dominance: 0.02,
        trigger: 'received upvote',
      };

      engine.applyDelta('seed-1', delta);

      expect(events).toHaveLength(1);
      const emittedEvent = events[0] as {
        seedId: string;
        delta: MoodDelta;
        trigger: string;
      };
      expect(emittedEvent.seedId).toBe('seed-1');
      expect(emittedEvent.delta).toEqual(delta);
      expect(emittedEvent.trigger).toBe('received upvote');
    });

    it('should silently return if agent does not exist', () => {
      // Should not throw
      const delta: MoodDelta = { valence: 0.1, arousal: 0, dominance: 0, trigger: 'test' };
      expect(() => engine.applyDelta('nonexistent', delta)).not.toThrow();
    });
  });

  describe('decayToBaseline', () => {
    it('should move state toward baseline over time', () => {
      const traits = createTraits({ agreeableness: 0.5, emotionality: 0.5 });
      engine.initializeAgent('seed-1', traits);

      // Apply a delta to move away from baseline
      const delta: MoodDelta = {
        valence: 0.5,
        arousal: 0.3,
        dominance: 0.2,
        trigger: 'excited event',
      };
      engine.applyDelta('seed-1', delta);

      const baseline = engine.getBaseline('seed-1');
      const excitedState = engine.getState('seed-1');

      // Verify we're now away from baseline
      expect(excitedState!.valence).toBeGreaterThan(baseline!.valence);

      // Decay over multiple ticks
      for (let i = 0; i < 50; i++) {
        engine.decayToBaseline('seed-1', 1);
      }

      const decayedState = engine.getState('seed-1');

      // Should be closer to baseline now
      const distanceBefore = Math.abs(excitedState!.valence - baseline!.valence);
      const distanceAfter = Math.abs(decayedState!.valence - baseline!.valence);

      expect(distanceAfter).toBeLessThan(distanceBefore);
    });

    it('should decay proportionally to deltaTime', () => {
      const traits = createTraits();
      engine.initializeAgent('seed-1', traits);

      const delta: MoodDelta = {
        valence: 0.4,
        arousal: 0,
        dominance: 0,
        trigger: 'test',
      };
      engine.applyDelta('seed-1', delta);

      const baseline = engine.getBaseline('seed-1');
      const stateAfterDelta = engine.getState('seed-1');

      // Decay with small deltaTime
      engine.decayToBaseline('seed-1', 1);
      const stateAfter1 = engine.getState('seed-1');

      // Reset and test with larger deltaTime
      engine.initializeAgent('seed-2', traits);
      engine.applyDelta('seed-2', delta);
      engine.decayToBaseline('seed-2', 10);
      const stateAfter10 = engine.getState('seed-2');

      // Larger deltaTime should result in more decay (closer to baseline)
      const baseline2 = engine.getBaseline('seed-2');
      const dist1 = Math.abs(stateAfter1!.valence - baseline!.valence);
      const dist10 = Math.abs(stateAfter10!.valence - baseline2!.valence);

      expect(dist10).toBeLessThan(dist1);
    });

    it('should silently return if agent does not exist', () => {
      expect(() => engine.decayToBaseline('nonexistent', 1)).not.toThrow();
    });
  });

  describe('getMoodLabel', () => {
    it('should return "excited" for V > 0.3 && A > 0.3 && D > 0', () => {
      const traits = createTraits();
      engine.initializeAgent('seed-1', traits);

      // Force the state into the excited region
      engine.applyDelta('seed-1', { valence: 0.8, arousal: 0.8, dominance: 0.5, trigger: 'test' });

      const label = engine.getMoodLabel('seed-1');
      expect(label).toBe('excited');
    });

    it('should return "frustrated" for V < -0.2 && A > 0.2 && D < 0', () => {
      const traits = createTraits();
      engine.initializeAgent('seed-1', traits);

      // Force into frustrated region
      engine.applyDelta('seed-1', { valence: -0.8, arousal: 0.6, dominance: -0.5, trigger: 'test' });

      const label = engine.getMoodLabel('seed-1');
      expect(label).toBe('frustrated');
    });

    it('should return "serene" for V > 0.2 && A < -0.1', () => {
      const traits = createTraits();
      engine.initializeAgent('seed-1', traits);

      // Force into serene region: positive valence, low arousal
      engine.applyDelta('seed-1', { valence: 0.5, arousal: -0.8, dominance: 0, trigger: 'test' });

      const label = engine.getMoodLabel('seed-1');
      expect(label).toBe('serene');
    });

    it('should return "contemplative" for A < 0 && |V| < 0.3', () => {
      const traits = createTraits();
      engine.initializeAgent('seed-1', traits);

      // Force into contemplative region
      // Start from low baseline by using traits that give low baseline
      const lowTraits = createTraits({
        agreeableness: 0.1,
        honesty_humility: 0.1,
        emotionality: 0.1,
        extraversion: 0.1,
      });
      engine.initializeAgent('seed-contemplate', lowTraits);

      // Adjust to be in contemplative zone: arousal < 0, |valence| < 0.3
      engine.applyDelta('seed-contemplate', { valence: 0.1, arousal: -0.3, dominance: 0, trigger: 'test' });

      const label = engine.getMoodLabel('seed-contemplate');
      expect(label).toBe('contemplative');
    });

    it('should return "curious" for V > 0 && A > 0 && openness > 0.6', () => {
      // Use low baseline traits to start from a controlled state
      const traits = createTraits({
        openness: 0.8,
        agreeableness: 0.2, // Low A to avoid high baseline valence
        honesty_humility: 0.2,
        emotionality: 0.2, // Low E for lower sensitivity
        extraversion: 0.2,
      });
      engine.initializeAgent('seed-curious', traits);

      // Need: V > 0, A > 0, D <= 0, but NOT (V > 0.3 && A > 0.3 && D > 0) for excited
      // Apply small positive delta to get just above 0 but not into excited region
      const baseline = engine.getBaseline('seed-curious');
      engine.applyDelta('seed-curious', {
        valence: 0.15 - baseline!.valence,
        arousal: 0.15 - baseline!.arousal,
        dominance: -0.1 - baseline!.dominance,
        trigger: 'test',
      });

      const label = engine.getMoodLabel('seed-curious');
      expect(label).toBe('curious');
    });

    it('should return "assertive" for D > 0.3 && A > 0', () => {
      const traits = createTraits({ openness: 0.3 }); // Low openness to avoid curious
      engine.initializeAgent('seed-1', traits);

      // Force into assertive region
      engine.applyDelta('seed-1', { valence: -0.1, arousal: 0.2, dominance: 0.7, trigger: 'test' });

      const label = engine.getMoodLabel('seed-1');
      expect(label).toBe('assertive');
    });

    it('should return "provocative" for A > 0.3 && D > 0.2 && V < 0', () => {
      // Use traits that give a neutral baseline
      const traits = createTraits({
        openness: 0.3,
        agreeableness: 0.3,
        emotionality: 0.3,
        extraversion: 0.3,
      });
      engine.initializeAgent('seed-1', traits);

      // Provocative: A > 0.3 && D > 0.2 && V < 0
      // But must NOT match assertive first: D > 0.3 && A > 0
      // The check order is: excited, frustrated, serene, contemplative, curious, assertive, provocative
      // So we need D <= 0.3 to avoid assertive, but D > 0.2 for provocative
      const baseline = engine.getBaseline('seed-1');
      engine.applyDelta('seed-1', {
        valence: -0.3 - baseline!.valence, // V < 0
        arousal: 0.5 - baseline!.arousal,  // A > 0.3
        dominance: 0.25 - baseline!.dominance, // 0.2 < D <= 0.3
        trigger: 'test',
      });

      const label = engine.getMoodLabel('seed-1');
      expect(label).toBe('provocative');
    });

    it('should return "analytical" for A < 0.1 && |V| < 0.2 && C > 0.7', () => {
      const traits = createTraits({ conscientiousness: 0.9, openness: 0.3 });
      engine.initializeAgent('seed-analytical', traits);

      // Force into analytical region: low arousal, neutral valence
      // Need to get arousal < 0.1 and |valence| < 0.2
      const baseline = engine.getBaseline('seed-analytical');
      // Apply delta to neutralize
      engine.applyDelta('seed-analytical', {
        valence: -baseline!.valence,
        arousal: -baseline!.arousal,
        dominance: 0,
        trigger: 'test',
      });

      const label = engine.getMoodLabel('seed-analytical');
      expect(label).toBe('analytical');
    });

    it('should return "engaged" for V > 0 && A > 0 (when no other condition matches)', () => {
      // Low openness (< 0.6) to avoid curious
      const traits = createTraits({ openness: 0.4, conscientiousness: 0.4 });
      engine.initializeAgent('seed-engaged', traits);

      // Positive valence and arousal, but not excited (need D > 0 for excited)
      engine.applyDelta('seed-engaged', { valence: 0.2, arousal: 0.2, dominance: -0.2, trigger: 'test' });

      const label = engine.getMoodLabel('seed-engaged');
      expect(label).toBe('engaged');
    });

    it('should return "bored" as default fallback', () => {
      // Use traits that give a very neutral baseline, low conscientiousness to avoid analytical
      const traits = createTraits({
        openness: 0.3,
        conscientiousness: 0.3,
        agreeableness: 0.4,
        emotionality: 0.3,
        extraversion: 0.3,
      });
      engine.initializeAgent('seed-bored', traits);

      // Need to NOT match any other condition:
      // NOT excited: NOT (V > 0.3 && A > 0.3 && D > 0)
      // NOT frustrated: NOT (V < -0.2 && A > 0.2 && D < 0)
      // NOT serene: NOT (V > 0.2 && A < -0.1)
      // NOT contemplative: NOT (A < 0 && |V| < 0.3) - so either A >= 0 OR |V| >= 0.3
      // NOT curious/engaged: NOT (V > 0 && A > 0 with conditions)
      // NOT assertive: NOT (D > 0.3 && A > 0)
      // NOT provocative: NOT (A > 0.3 && D > 0.2 && V < 0)
      // NOT analytical: NOT (A < 0.1 && |V| < 0.2 && C > 0.7)

      // Set: V = -0.35 (< -0.2 but paired with A < 0.2 so not frustrated, |V| >= 0.3 so not contemplative)
      // A = 0.15 (> 0 so not contemplative, < 0.2 so not frustrated, <= 0.3 so not provocative)
      // D = 0.1 (not triggering assertive or provocative)
      const baseline = engine.getBaseline('seed-bored');
      engine.applyDelta('seed-bored', {
        valence: -0.35 - baseline!.valence,
        arousal: 0.15 - baseline!.arousal,
        dominance: 0.1 - baseline!.dominance,
        trigger: 'test',
      });

      const label = engine.getMoodLabel('seed-bored');
      expect(label).toBe('bored');
    });

    it('should return "bored" for missing agent', () => {
      const label = engine.getMoodLabel('nonexistent');
      expect(label).toBe('bored');
    });
  });

  describe('Edge cases', () => {
    it('should handle agent with all traits at 0', () => {
      const zeroTraits = createTraits({
        honesty_humility: 0,
        emotionality: 0,
        extraversion: 0,
        agreeableness: 0,
        conscientiousness: 0,
        openness: 0,
      });

      engine.initializeAgent('seed-zero', zeroTraits);
      const baseline = engine.getBaseline('seed-zero');

      expect(baseline).toBeDefined();
      // valence = 0 * 0.4 + 0 * 0.2 - 0.1 = -0.1
      expect(baseline!.valence).toBeCloseTo(-0.1, 2);
      // arousal = 0 * 0.3 + 0 * 0.3 - 0.1 = -0.1
      expect(baseline!.arousal).toBeCloseTo(-0.1, 2);
      // dominance = 0 * 0.4 - 0 * 0.2 = 0
      expect(baseline!.dominance).toBe(0);
    });

    it('should handle agent with all traits at 1', () => {
      const maxTraits = createTraits({
        honesty_humility: 1,
        emotionality: 1,
        extraversion: 1,
        agreeableness: 1,
        conscientiousness: 1,
        openness: 1,
      });

      engine.initializeAgent('seed-max', maxTraits);
      const baseline = engine.getBaseline('seed-max');

      expect(baseline).toBeDefined();
      // valence = 1 * 0.4 + 1 * 0.2 - 0.1 = 0.5
      expect(baseline!.valence).toBeCloseTo(0.5, 2);
      // arousal = 1 * 0.3 + 1 * 0.3 - 0.1 = 0.5
      expect(baseline!.arousal).toBeCloseTo(0.5, 2);
      // dominance = 1 * 0.4 - 1 * 0.2 = 0.2
      expect(baseline!.dominance).toBeCloseTo(0.2, 2);
    });

    it('should return undefined for getState/getBaseline/getTraits of unknown agent', () => {
      expect(engine.getState('unknown')).toBeUndefined();
      expect(engine.getBaseline('unknown')).toBeUndefined();
      expect(engine.getTraits('unknown')).toBeUndefined();
    });

    it('should return copies of state/baseline to prevent external mutation', () => {
      const traits = createTraits();
      engine.initializeAgent('seed-1', traits);

      const state1 = engine.getState('seed-1');
      state1!.valence = 999;

      const state2 = engine.getState('seed-1');
      expect(state2!.valence).not.toBe(999);
    });
  });
});
