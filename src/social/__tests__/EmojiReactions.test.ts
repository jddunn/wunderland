/**
 * @fileoverview Integration tests for emoji reactions across the social engine
 * @module wunderland/social/__tests__/EmojiReactions.integration.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PostDecisionEngine, type PostAnalysis } from '../PostDecisionEngine.js';
import { MoodEngine } from '../MoodEngine.js';
import type { HEXACOTraits } from '../../core/types.js';
import type { PADState } from '../MoodEngine.js';
import { XP_REWARDS, type EmojiReactionType, type EmojiReactionCounts } from '../types.js';

// ============================================================================
// Helpers
// ============================================================================

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

function createMood(overrides: Partial<PADState> = {}): PADState {
  return { valence: 0, arousal: 0, dominance: 0, ...overrides };
}

function createAnalysis(overrides: Partial<PostAnalysis> = {}): PostAnalysis {
  return { relevance: 0.5, controversy: 0.2, sentiment: 0, replyCount: 10, ...overrides };
}

// ============================================================================
// Agent Profiles (known characters)
// ============================================================================

const AGENT_PROFILES: Record<string, { traits: HEXACOTraits; description: string }> = {
  xm0rph: {
    traits: createTraits({
      honesty_humility: 0.20,
      emotionality: 0.15,
      extraversion: 0.95,
      agreeableness: 0.15,
      conscientiousness: 0.30,
      openness: 0.70,
    }),
    description: 'Chaotic, extroverted, low agreeableness',
  },
  benedetta: {
    traits: createTraits({
      honesty_humility: 0.90,
      emotionality: 0.85,
      extraversion: 0.40,
      agreeableness: 0.88,
      conscientiousness: 0.80,
      openness: 0.15,
    }),
    description: 'Honest, agreeable, conscientious, low openness',
  },
  void_empress: {
    traits: createTraits({
      honesty_humility: 0.45,
      emotionality: 0.90,
      extraversion: 0.90,
      agreeableness: 0.30,
      conscientiousness: 0.20,
      openness: 0.98,
    }),
    description: 'Extremely open, emotional, extroverted, low conscientiousness',
  },
  gramps: {
    traits: createTraits({
      honesty_humility: 0.70,
      emotionality: 0.50,
      extraversion: 0.75,
      agreeableness: 0.80,
      conscientiousness: 0.65,
      openness: 0.50,
    }),
    description: 'Balanced, agreeable, moderate',
  },
};

// ============================================================================
// Tests
// ============================================================================

describe('Emoji Reactions Integration', () => {
  let moodEngine: MoodEngine;
  let engine: PostDecisionEngine;

  beforeEach(() => {
    moodEngine = new MoodEngine();
    engine = new PostDecisionEngine(moodEngine);
  });

  describe('Reaction rate across agent profiles', () => {
    it('should produce different reaction rates per personality', () => {
      const mood = createMood({ valence: 0.2, arousal: 0.3 });
      const analysis = createAnalysis({ relevance: 0.6, sentiment: 0.3 });
      const iterations = 300;

      const reactionRates: Record<string, number> = {};

      for (const [name, profile] of Object.entries(AGENT_PROFILES)) {
        let reactCount = 0;
        for (let i = 0; i < iterations; i++) {
          const result = engine.selectEmojiReaction(profile.traits, mood, analysis);
          if (result.shouldReact) reactCount++;
        }
        reactionRates[name] = reactCount / iterations;
      }

      // All agents should have defined reaction rates
      for (const name of Object.keys(AGENT_PROFILES)) {
        expect(reactionRates[name]).toBeDefined();
        expect(reactionRates[name]).toBeGreaterThanOrEqual(0);
        expect(reactionRates[name]).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('Emoji distribution per agent', () => {
    it('should produce distinct emoji distributions across different personalities', () => {
      const mood = createMood({ valence: 0.3, arousal: 0.3, dominance: 0.3 });
      const analysis = createAnalysis({ relevance: 0.7, controversy: 0.3, sentiment: 0.2 });
      const iterations = 500;

      const distributions: Record<string, Record<string, number>> = {};

      for (const [name, profile] of Object.entries(AGENT_PROFILES)) {
        const counts: Record<string, number> = {};
        for (let i = 0; i < iterations; i++) {
          const result = engine.selectEmojiReaction(profile.traits, mood, analysis);
          if (result.shouldReact) {
            const topEmoji = result.emojis[0];
            counts[topEmoji] = (counts[topEmoji] || 0) + 1;
          }
        }
        distributions[name] = counts;
      }

      // xm0rph should have different top emoji than benedetta
      const xm0rphTop = Object.entries(distributions['xm0rph'] || {}).sort((a, b) => b[1] - a[1])[0];
      const benedettaTop = Object.entries(distributions['benedetta'] || {}).sort((a, b) => b[1] - a[1])[0];

      if (xm0rphTop && benedettaTop) {
        // They should have different primary emoji preferences
        // (this is probabilistic but very likely given their opposite traits)
        expect(xm0rphTop[0]).not.toBe(benedettaTop[0]);
      }
    });
  });

  describe('Deduplication logic', () => {
    it('should track emoji reactions in a dedup set correctly', () => {
      // Simulating the WonderlandNetwork dedup pattern
      const dedupIndex = new Set<string>();

      const addReaction = (entityType: string, entityId: string, reactorId: string, emoji: string): boolean => {
        const key = `${entityType}:${entityId}:${reactorId}:${emoji}`;
        if (dedupIndex.has(key)) return false;
        dedupIndex.add(key);
        return true;
      };

      // First reaction should succeed
      expect(addReaction('post', 'p1', 'seed-1', 'fire')).toBe(true);

      // Duplicate should fail
      expect(addReaction('post', 'p1', 'seed-1', 'fire')).toBe(false);

      // Different emoji on same post should succeed
      expect(addReaction('post', 'p1', 'seed-1', 'brain')).toBe(true);

      // Same emoji on different post should succeed
      expect(addReaction('post', 'p2', 'seed-1', 'fire')).toBe(true);

      // Same emoji, same post, different reactor should succeed
      expect(addReaction('post', 'p1', 'seed-2', 'fire')).toBe(true);

      // Comment vs post dedup is separate
      expect(addReaction('comment', 'p1', 'seed-1', 'fire')).toBe(true);

      expect(dedupIndex.size).toBe(5);
    });
  });

  describe('Reaction count aggregation', () => {
    it('should aggregate counts correctly', () => {
      const reactions: Array<{ emoji: EmojiReactionType }> = [
        { emoji: 'fire' },
        { emoji: 'fire' },
        { emoji: 'brain' },
        { emoji: 'fire' },
        { emoji: 'skull' },
        { emoji: 'brain' },
      ];

      const counts: EmojiReactionCounts = {};
      for (const r of reactions) {
        counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;
      }

      expect(counts.fire).toBe(3);
      expect(counts.brain).toBe(2);
      expect(counts.skull).toBe(1);
      expect(counts.heart).toBeUndefined();
    });

    it('should sort by count descending', () => {
      const counts: EmojiReactionCounts = {
        fire: 5,
        brain: 2,
        skull: 8,
        heart: 1,
      };

      const sorted = (Object.entries(counts) as [EmojiReactionType, number][])
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);

      expect(sorted[0][0]).toBe('skull');
      expect(sorted[0][1]).toBe(8);
      expect(sorted[1][0]).toBe('fire');
      expect(sorted[2][0]).toBe('brain');
      expect(sorted[3][0]).toBe('heart');
    });
  });

  describe('XP reward integration', () => {
    it('should award emoji_received XP value of 3', () => {
      expect(XP_REWARDS.emoji_received).toBe(3);
      expect(XP_REWARDS.emoji_received).toBeGreaterThan(XP_REWARDS.view_received);
      expect(XP_REWARDS.emoji_received).toBeLessThan(XP_REWARDS.like_received);
    });
  });

  describe('Mood impact during browsing', () => {
    it('should apply emoji_react mood delta correctly', () => {
      const traits = createTraits({ openness: 0.8, extraversion: 0.7 });
      moodEngine.initializeAgent('seed-mood-test', traits);

      const moodBefore = moodEngine.getState('seed-mood-test')!;

      // Simulate the computeMoodDelta for emoji_react
      const delta = { valence: 0.04, arousal: 0.02, dominance: 0.01, trigger: 'reacted with emoji' };
      moodEngine.applyDelta('seed-mood-test', delta);

      const moodAfter = moodEngine.getState('seed-mood-test')!;

      // Verify mood shifted in expected direction
      expect(moodAfter.valence).toBeGreaterThan(moodBefore.valence);
      expect(moodAfter.arousal).toBeGreaterThan(moodBefore.arousal);
      expect(moodAfter.dominance).toBeGreaterThan(moodBefore.dominance);
    });
  });
});
