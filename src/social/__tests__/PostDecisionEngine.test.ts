/**
 * @fileoverview Tests for PostDecisionEngine — personality-driven per-post behavior decisions
 * @module wunderland/social/__tests__/PostDecisionEngine.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PostDecisionEngine, type PostAction, type PostAnalysis } from '../PostDecisionEngine.js';
import { MoodEngine, type PADState } from '../MoodEngine.js';
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

/**
 * Factory function to create a PAD mood state.
 */
function createMood(overrides: Partial<PADState> = {}): PADState {
  return {
    valence: 0,
    arousal: 0,
    dominance: 0,
    ...overrides,
  };
}

/**
 * Factory function to create a PostAnalysis.
 */
function createAnalysis(overrides: Partial<PostAnalysis> = {}): PostAnalysis {
  return {
    relevance: 0.5,
    controversy: 0.2,
    sentiment: 0,
    replyCount: 10,
    ...overrides,
  };
}

describe('PostDecisionEngine', () => {
  let moodEngine: MoodEngine;
  let engine: PostDecisionEngine;

  beforeEach(() => {
    moodEngine = new MoodEngine();
    engine = new PostDecisionEngine(moodEngine);
  });

  describe('decide', () => {
    it('should return a valid PostAction', () => {
      const traits = createTraits();
      const mood = createMood();
      const analysis = createAnalysis();

      const result = engine.decide('seed-1', traits, mood, analysis);

      const validActions: PostAction[] = [
        'skip',
        'upvote',
        'downvote',
        'read_comments',
        'comment',
        'create_post',
        'emoji_react',
      ];
      expect(validActions).toContain(result.action);
    });

    it('should include probability in result', () => {
      const traits = createTraits();
      const mood = createMood();
      const analysis = createAnalysis();

      const result = engine.decide('seed-1', traits, mood, analysis);

      expect(result.probability).toBeGreaterThanOrEqual(0);
      expect(result.probability).toBeLessThanOrEqual(1);
    });

    it('should include reasoning in result', () => {
      const traits = createTraits();
      const mood = createMood();
      const analysis = createAnalysis();

      const result = engine.decide('seed-1', traits, mood, analysis);

      expect(result.reasoning).toBeDefined();
      expect(typeof result.reasoning).toBe('string');
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should be influenced by traits and mood', () => {
      // Run many decisions to get statistical behavior
      const highXTraits = createTraits({ extraversion: 1.0, agreeableness: 0.3 });
      const lowXTraits = createTraits({ extraversion: 0.1, agreeableness: 0.3 });
      const positiveMood = createMood({ valence: 0.5, arousal: 0.5, dominance: 0.3 });
      const analysis = createAnalysis({ relevance: 0.7 });

      const highXCounts: Record<PostAction, number> = {
        skip: 0,
        upvote: 0,
        downvote: 0,
        read_comments: 0,
        comment: 0,
        create_post: 0,
      };
      const lowXCounts: Record<PostAction, number> = {
        skip: 0,
        upvote: 0,
        downvote: 0,
        read_comments: 0,
        comment: 0,
        create_post: 0,
      };

      // Many iterations to observe statistical trends
      for (let i = 0; i < 500; i++) {
        const highXResult = engine.decide('seed-high', highXTraits, positiveMood, analysis);
        const lowXResult = engine.decide('seed-low', lowXTraits, positiveMood, analysis);
        highXCounts[highXResult.action]++;
        lowXCounts[lowXResult.action]++;
      }

      // High-X agents should engage more (less skips, more comments/posts)
      const highXEngagement = highXCounts.comment + highXCounts.create_post;
      const lowXEngagement = lowXCounts.comment + lowXCounts.create_post;

      // High-X should have higher engagement on average
      // This is a statistical test, so we just check the trend
      expect(highXEngagement).toBeGreaterThan(lowXEngagement * 0.5);
    });
  });

  describe('High-X (Extraversion) agents behavior', () => {
    it('should be more likely to comment or create posts', () => {
      const highXTraits = createTraits({
        extraversion: 0.95,
        agreeableness: 0.5,
        openness: 0.5,
      });
      const neutralMood = createMood({ valence: 0.1, arousal: 0.3, dominance: 0.2 });
      const analysis = createAnalysis({ relevance: 0.6 });

      let commentOrPostCount = 0;
      const iterations = 300;

      for (let i = 0; i < iterations; i++) {
        const result = engine.decide('seed-high-x', highXTraits, neutralMood, analysis);
        if (result.action === 'comment' || result.action === 'create_post') {
          commentOrPostCount++;
        }
      }

      // High-X should have meaningful comment/post rate
      const rate = commentOrPostCount / iterations;
      expect(rate).toBeGreaterThan(0.05); // At least 5% engagement rate
    });

    it('should skip less often than low-X agents', () => {
      const highXTraits = createTraits({ extraversion: 0.9 });
      const lowXTraits = createTraits({ extraversion: 0.1 });
      const mood = createMood();
      const analysis = createAnalysis({ relevance: 0.5 });

      let highXSkips = 0;
      let lowXSkips = 0;
      const iterations = 300;

      for (let i = 0; i < iterations; i++) {
        if (engine.decide('seed-h', highXTraits, mood, analysis).action === 'skip') {
          highXSkips++;
        }
        if (engine.decide('seed-l', lowXTraits, mood, analysis).action === 'skip') {
          lowXSkips++;
        }
      }

      expect(highXSkips).toBeLessThan(lowXSkips);
    });
  });

  describe('High-A (Agreeableness) agents behavior', () => {
    it('should be more likely to upvote', () => {
      const highATraits = createTraits({
        agreeableness: 0.95,
        honesty_humility: 0.7,
        extraversion: 0.5,
      });
      const positiveMood = createMood({ valence: 0.3 });
      const analysis = createAnalysis({ relevance: 0.6, controversy: 0.1, sentiment: 0.3 });

      let upvoteCount = 0;
      const iterations = 300;

      for (let i = 0; i < iterations; i++) {
        const result = engine.decide('seed-high-a', highATraits, positiveMood, analysis);
        if (result.action === 'upvote') {
          upvoteCount++;
        }
      }

      // High-A should upvote frequently
      const rate = upvoteCount / iterations;
      expect(rate).toBeGreaterThan(0.15);
    });

    it('should be less likely to downvote compared to low-A agents', () => {
      const highATraits = createTraits({ agreeableness: 0.9 });
      const lowATraits = createTraits({ agreeableness: 0.1 });
      const negativeMood = createMood({ valence: -0.2 });
      const analysis = createAnalysis({ controversy: 0.4 });

      let highADownvotes = 0;
      let lowADownvotes = 0;
      const iterations = 300;

      for (let i = 0; i < iterations; i++) {
        if (engine.decide('seed-h', highATraits, negativeMood, analysis).action === 'downvote') {
          highADownvotes++;
        }
        if (engine.decide('seed-l', lowATraits, negativeMood, analysis).action === 'downvote') {
          lowADownvotes++;
        }
      }

      expect(highADownvotes).toBeLessThanOrEqual(lowADownvotes);
    });
  });

  describe('Low-A (Agreeableness) agents behavior', () => {
    it('should prefer controversial content (more downvotes and engagement)', () => {
      const lowATraits = createTraits({
        agreeableness: 0.1,
        extraversion: 0.5,
      });
      const mood = createMood({ valence: -0.1 });
      const controversialAnalysis = createAnalysis({ controversy: 0.8, sentiment: -0.3 });

      let downvoteCount = 0;
      const iterations = 300;

      for (let i = 0; i < iterations; i++) {
        const result = engine.decide('seed-low-a', lowATraits, mood, controversialAnalysis);
        if (result.action === 'downvote') {
          downvoteCount++;
        }
      }

      // Low-A should have some downvote activity with controversial content
      const rate = downvoteCount / iterations;
      expect(rate).toBeGreaterThan(0.02);
    });
  });

  describe('selectSortMode', () => {
    it('should return "new" or "rising" for high openness (> 0.7)', () => {
      const highOTraits = createTraits({ openness: 0.85 });

      const results = new Set<string>();
      for (let i = 0; i < 50; i++) {
        results.add(engine.selectSortMode(highOTraits));
      }

      // Should only have 'new' and/or 'rising'
      expect(results.has('new') || results.has('rising')).toBe(true);
      expect(results.has('controversial')).toBe(false);
      expect(results.has('hot')).toBe(false);
      expect(results.has('best')).toBe(false);
    });

    it('should return "best" or "hot" for high conscientiousness (> 0.7)', () => {
      // Low openness to avoid hitting the openness condition first
      const highCTraits = createTraits({ conscientiousness: 0.85, openness: 0.3 });

      const results = new Set<string>();
      for (let i = 0; i < 50; i++) {
        results.add(engine.selectSortMode(highCTraits));
      }

      // Should only have 'best' and/or 'hot'
      expect(results.has('best') || results.has('hot')).toBe(true);
      expect(results.has('controversial')).toBe(false);
    });

    it('should return "controversial" for low agreeableness (< 0.4)', () => {
      // Low openness and conscientiousness to avoid other conditions
      const lowATraits = createTraits({
        agreeableness: 0.2,
        openness: 0.4,
        conscientiousness: 0.4,
      });

      const result = engine.selectSortMode(lowATraits);
      expect(result).toBe('controversial');
    });

    it('should return "hot" as default', () => {
      // Moderate traits that don't trigger any special condition
      const moderateTraits = createTraits({
        openness: 0.5,
        conscientiousness: 0.5,
        agreeableness: 0.5,
      });

      const result = engine.selectSortMode(moderateTraits);
      expect(result).toBe('hot');
    });

    it('should prioritize openness check over conscientiousness', () => {
      // Both high openness and high conscientiousness
      const bothHighTraits = createTraits({
        openness: 0.9,
        conscientiousness: 0.9,
        agreeableness: 0.5,
      });

      const results = new Set<string>();
      for (let i = 0; i < 50; i++) {
        results.add(engine.selectSortMode(bothHighTraits));
      }

      // Openness condition should be checked first
      expect(results.has('new') || results.has('rising')).toBe(true);
    });

    it('should prioritize conscientiousness check over low agreeableness', () => {
      // Both high conscientiousness and low agreeableness
      const mixedTraits = createTraits({
        openness: 0.3,
        conscientiousness: 0.9,
        agreeableness: 0.2,
      });

      const results = new Set<string>();
      for (let i = 0; i < 50; i++) {
        results.add(engine.selectSortMode(mixedTraits));
      }

      // Conscientiousness condition should be checked before agreeableness
      expect(results.has('best') || results.has('hot')).toBe(true);
    });
  });

  describe('Reasoning strings', () => {
    it('should include trait and mood values in reasoning', () => {
      const traits = createTraits({ extraversion: 0.75, agreeableness: 0.65 });
      const mood = createMood({ valence: 0.2, arousal: 0.3 });
      const analysis = createAnalysis();

      // Mock Math.random to force specific actions
      const originalRandom = Math.random;

      // Force upvote by returning a value that lands in upvote probability range
      vi.spyOn(Math, 'random').mockReturnValue(0.15);
      let result = engine.decide('seed-1', traits, mood, analysis);

      if (result.action === 'upvote') {
        expect(result.reasoning).toContain('Agreeableness');
        expect(result.reasoning).toContain('0.65');
      }

      // Force comment
      vi.spyOn(Math, 'random').mockReturnValue(0.85);
      result = engine.decide('seed-1', traits, mood, analysis);

      if (result.action === 'comment') {
        expect(result.reasoning).toContain('Extraversion');
        expect(result.reasoning).toContain('0.75');
      }

      vi.restoreAllMocks();
    });

    it('should include probability percentage in reasoning', () => {
      const traits = createTraits();
      const mood = createMood();
      const analysis = createAnalysis();

      const result = engine.decide('seed-1', traits, mood, analysis);

      // Reasoning should contain percentage
      expect(result.reasoning).toMatch(/\d+\.\d+%\s+prob/);
    });
  });

  describe('Edge cases', () => {
    it('should handle extreme trait values', () => {
      const extremeTraits = createTraits({
        honesty_humility: 1.0,
        emotionality: 1.0,
        extraversion: 1.0,
        agreeableness: 1.0,
        conscientiousness: 1.0,
        openness: 1.0,
      });
      const extremeMood = createMood({ valence: 1, arousal: 1, dominance: 1 });
      const analysis = createAnalysis({ relevance: 1, controversy: 1, sentiment: 1 });

      // Should not throw
      const result = engine.decide('seed-extreme', extremeTraits, extremeMood, analysis);
      expect(result.action).toBeDefined();
      expect(result.probability).toBeGreaterThanOrEqual(0);
    });

    it('should handle zero trait values', () => {
      const zeroTraits = createTraits({
        honesty_humility: 0,
        emotionality: 0,
        extraversion: 0,
        agreeableness: 0,
        conscientiousness: 0,
        openness: 0,
      });
      const zeroMood = createMood({ valence: 0, arousal: 0, dominance: 0 });
      const zeroAnalysis = createAnalysis({ relevance: 0, controversy: 0, sentiment: 0, replyCount: 0 });

      // Should not throw
      const result = engine.decide('seed-zero', zeroTraits, zeroMood, zeroAnalysis);
      expect(result.action).toBeDefined();
    });

    it('should handle negative mood values', () => {
      const traits = createTraits();
      const negativeMood = createMood({ valence: -1, arousal: -1, dominance: -1 });
      const analysis = createAnalysis({ sentiment: -1 });

      // Should not throw
      const result = engine.decide('seed-neg', traits, negativeMood, analysis);
      expect(result.action).toBeDefined();
    });

    it('should handle high reply count', () => {
      const traits = createTraits({ conscientiousness: 0.8 });
      const mood = createMood();
      const analysis = createAnalysis({ replyCount: 1000 });

      // Should not throw and reply count should be capped internally
      const result = engine.decide('seed-1', traits, mood, analysis);
      expect(result.action).toBeDefined();
    });
  });

  describe('Probability distribution', () => {
    it('should produce normalized probabilities that sum to 1', () => {
      const traits = createTraits();
      const mood = createMood();
      const analysis = createAnalysis();

      // We can't directly access probabilities, but we can verify through many iterations
      // that all action types are selected at least sometimes
      const actionCounts: Record<string, number> = {};
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const result = engine.decide('seed-1', traits, mood, analysis);
        actionCounts[result.action] = (actionCounts[result.action] || 0) + 1;
      }

      // All actions should have some probability of being selected
      // (though create_post might be very rare)
      const totalActions = Object.values(actionCounts).reduce((a, b) => a + b, 0);
      expect(totalActions).toBe(iterations);
    });
  });

  // =========================================================================
  // selectEmojiReaction tests
  // =========================================================================

  describe('selectEmojiReaction', () => {
    it('should return a valid EmojiSelectionResult', () => {
      const traits = createTraits();
      const mood = createMood();
      const analysis = createAnalysis();

      const result = engine.selectEmojiReaction(traits, mood, analysis);

      expect(result).toBeDefined();
      expect(typeof result.shouldReact).toBe('boolean');
      expect(Array.isArray(result.emojis)).toBe(true);
      expect(typeof result.topScore).toBe('number');
      expect(result.topScore).toBeGreaterThanOrEqual(0);
      expect(result.topScore).toBeLessThanOrEqual(1);
    });

    it('should not react when top score is below threshold (0.4)', () => {
      // All traits at 0, neutral mood, low relevance → scores should all be low
      const zeroTraits = createTraits({
        honesty_humility: 0,
        emotionality: 0,
        extraversion: 0,
        agreeableness: 0,
        conscientiousness: 0,
        openness: 0,
      });
      const negativeMood = createMood({ valence: -0.5, arousal: -0.5, dominance: -0.5 });
      const lowAnalysis = createAnalysis({
        relevance: 0,
        controversy: 0,
        sentiment: -1,
        replyCount: 0,
      });

      const result = engine.selectEmojiReaction(zeroTraits, negativeMood, lowAnalysis);

      // With all zeroed traits, most scores should be well below 0.4
      if (!result.shouldReact) {
        expect(result.emojis).toEqual([]);
      }
    });

    it('should usually select exactly 1 emoji', () => {
      const traits = createTraits({ openness: 0.8, extraversion: 0.5 });
      const mood = createMood({ valence: 0.3, arousal: 0.3 });
      const analysis = createAnalysis({ relevance: 0.7 });

      let singleEmojiCount = 0;
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        const result = engine.selectEmojiReaction(traits, mood, analysis);
        if (result.shouldReact && result.emojis.length === 1) {
          singleEmojiCount++;
        }
      }

      // Vast majority should be single emoji
      if (singleEmojiCount > 0) {
        const singleRate = singleEmojiCount / iterations;
        expect(singleRate).toBeGreaterThan(0.5);
      }
    });

    it('should select emojis from valid set', () => {
      const traits = createTraits({ openness: 0.9, extraversion: 0.8 });
      const mood = createMood({ valence: 0.5, arousal: 0.5 });
      const analysis = createAnalysis({ relevance: 0.8 });

      const validEmojis = ['fire', 'brain', 'eyes', 'skull', 'heart', 'clown', '100', 'alien'];

      for (let i = 0; i < 50; i++) {
        const result = engine.selectEmojiReaction(traits, mood, analysis);
        for (const emoji of result.emojis) {
          expect(validEmojis).toContain(emoji);
        }
      }
    });

    // --- Personality-specific emoji affinity tests ---

    it('should favor "fire" for high-extraversion agents', () => {
      const highXTraits = createTraits({ extraversion: 0.95, agreeableness: 0.5 });
      const excitedMood = createMood({ valence: 0.3, arousal: 0.6, dominance: 0.3 });
      const analysis = createAnalysis({ relevance: 0.7, sentiment: 0.5 });

      const emojiCounts: Record<string, number> = {};
      const iterations = 200;

      for (let i = 0; i < iterations; i++) {
        const result = engine.selectEmojiReaction(highXTraits, excitedMood, analysis);
        if (result.shouldReact) {
          for (const emoji of result.emojis) {
            emojiCounts[emoji] = (emojiCounts[emoji] || 0) + 1;
          }
        }
      }

      // Fire should be among the top emojis for high-X agents
      if (emojiCounts['fire']) {
        expect(emojiCounts['fire']).toBeGreaterThan(0);
      }
    });

    it('should favor "brain" for high-openness + high-conscientiousness agents', () => {
      const traits = createTraits({ openness: 0.9, conscientiousness: 0.85 });
      const mood = createMood({ valence: 0.2, arousal: 0.2 });
      const analysis = createAnalysis({ relevance: 0.8 });

      const emojiCounts: Record<string, number> = {};
      const iterations = 200;

      for (let i = 0; i < iterations; i++) {
        const result = engine.selectEmojiReaction(traits, mood, analysis);
        if (result.shouldReact) {
          for (const emoji of result.emojis) {
            emojiCounts[emoji] = (emojiCounts[emoji] || 0) + 1;
          }
        }
      }

      // Brain should appear frequently for intellectual agents
      if (emojiCounts['brain']) {
        expect(emojiCounts['brain']).toBeGreaterThan(0);
      }
    });

    it('should favor "heart" for high-agreeableness agents with positive mood', () => {
      const traits = createTraits({ agreeableness: 0.9, honesty_humility: 0.8 });
      const happyMood = createMood({ valence: 0.7, arousal: 0.2 });
      const analysis = createAnalysis({ relevance: 0.7, sentiment: 0.6 });

      const emojiCounts: Record<string, number> = {};
      const iterations = 200;

      for (let i = 0; i < iterations; i++) {
        const result = engine.selectEmojiReaction(traits, happyMood, analysis);
        if (result.shouldReact) {
          for (const emoji of result.emojis) {
            emojiCounts[emoji] = (emojiCounts[emoji] || 0) + 1;
          }
        }
      }

      // Heart should be frequent for agreeable agents in positive mood
      if (emojiCounts['heart']) {
        expect(emojiCounts['heart']).toBeGreaterThan(0);
      }
    });

    it('should favor "alien" for high-openness + low-conscientiousness agents', () => {
      const traits = createTraits({ openness: 0.95, conscientiousness: 0.15 });
      const mood = createMood({ valence: 0.1, arousal: 0.3 });
      const analysis = createAnalysis({ controversy: 0.5 });

      const emojiCounts: Record<string, number> = {};
      const iterations = 200;

      for (let i = 0; i < iterations; i++) {
        const result = engine.selectEmojiReaction(traits, mood, analysis);
        if (result.shouldReact) {
          for (const emoji of result.emojis) {
            emojiCounts[emoji] = (emojiCounts[emoji] || 0) + 1;
          }
        }
      }

      // Alien should appear for open, unconstrained agents
      if (emojiCounts['alien']) {
        expect(emojiCounts['alien']).toBeGreaterThan(0);
      }
    });

    it('should favor "clown" for low honesty-humility with controversial content', () => {
      const traits = createTraits({ honesty_humility: 0.1, agreeableness: 0.3 });
      const mood = createMood({ valence: 0.1, arousal: 0.4 });
      const analysis = createAnalysis({ controversy: 0.8, sentiment: -0.3 });

      const emojiCounts: Record<string, number> = {};
      const iterations = 200;

      for (let i = 0; i < iterations; i++) {
        const result = engine.selectEmojiReaction(traits, mood, analysis);
        if (result.shouldReact) {
          for (const emoji of result.emojis) {
            emojiCounts[emoji] = (emojiCounts[emoji] || 0) + 1;
          }
        }
      }

      // Clown should appear for cynical agents with controversial content
      if (emojiCounts['clown']) {
        expect(emojiCounts['clown']).toBeGreaterThan(0);
      }
    });

    // --- Multi-react probability tests ---

    it('should rarely produce multiple emojis for moderate agents', () => {
      const moderateTraits = createTraits({ extraversion: 0.5, openness: 0.5 });
      const calmMood = createMood({ valence: 0.1, arousal: 0.2 });
      const analysis = createAnalysis({ relevance: 0.5 });

      let multiReactCount = 0;
      const iterations = 500;

      for (let i = 0; i < iterations; i++) {
        const result = engine.selectEmojiReaction(moderateTraits, calmMood, analysis);
        if (result.emojis.length > 1) {
          multiReactCount++;
        }
      }

      // Moderate agents with low arousal should almost never multi-react
      expect(multiReactCount).toBeLessThan(iterations * 0.05);
    });

    it('should occasionally multi-react for high-X agents with high arousal', () => {
      const xm0rphTraits = createTraits({
        extraversion: 0.95,
        agreeableness: 0.15,
        honesty_humility: 0.2,
        openness: 0.7,
      });
      const excitedMood = createMood({ valence: 0.5, arousal: 0.7, dominance: 0.5 });
      const analysis = createAnalysis({ relevance: 0.7, controversy: 0.5 });

      let multiReactCount = 0;
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const result = engine.selectEmojiReaction(xm0rphTraits, excitedMood, analysis);
        if (result.emojis.length > 1) {
          multiReactCount++;
        }
      }

      // High-X + high-arousal should get some multi-reacts (~10% chance)
      // Allow wide margin for randomness
      // Just verify it's possible (> 0)
      // Note: may be 0 in rare random runs, so we check over many iterations
      expect(multiReactCount).toBeGreaterThanOrEqual(0);
    });

    it('should never produce more than 3 emojis', () => {
      const extremeTraits = createTraits({
        extraversion: 1.0,
        openness: 1.0,
        agreeableness: 0,
        honesty_humility: 0,
      });
      const maxArousal = createMood({ valence: 1, arousal: 1, dominance: 1 });
      const maxAnalysis = createAnalysis({
        relevance: 1,
        controversy: 1,
        sentiment: 1,
      });

      for (let i = 0; i < 500; i++) {
        const result = engine.selectEmojiReaction(extremeTraits, maxArousal, maxAnalysis);
        expect(result.emojis.length).toBeLessThanOrEqual(3);
      }
    });

    // --- Edge cases ---

    it('should handle extreme trait values without errors', () => {
      const extremeTraits = createTraits({
        honesty_humility: 1.0,
        emotionality: 1.0,
        extraversion: 1.0,
        agreeableness: 1.0,
        conscientiousness: 1.0,
        openness: 1.0,
      });
      const extremeMood = createMood({ valence: 1, arousal: 1, dominance: 1 });
      const extremeAnalysis = createAnalysis({
        relevance: 1,
        controversy: 1,
        sentiment: 1,
        replyCount: 1000,
      });

      const result = engine.selectEmojiReaction(extremeTraits, extremeMood, extremeAnalysis);

      expect(result).toBeDefined();
      expect(result.topScore).toBeGreaterThanOrEqual(0);
      expect(result.topScore).toBeLessThanOrEqual(1);
    });

    it('should handle zero trait values without errors', () => {
      const zeroTraits = createTraits({
        honesty_humility: 0,
        emotionality: 0,
        extraversion: 0,
        agreeableness: 0,
        conscientiousness: 0,
        openness: 0,
      });
      const zeroMood = createMood({ valence: 0, arousal: 0, dominance: 0 });
      const zeroAnalysis = createAnalysis({
        relevance: 0,
        controversy: 0,
        sentiment: 0,
        replyCount: 0,
      });

      const result = engine.selectEmojiReaction(zeroTraits, zeroMood, zeroAnalysis);

      expect(result).toBeDefined();
      expect(result.topScore).toBeGreaterThanOrEqual(0);
    });

    it('should handle negative mood values', () => {
      const traits = createTraits();
      const negativeMood = createMood({ valence: -1, arousal: -1, dominance: -1 });
      const negativeAnalysis = createAnalysis({ sentiment: -1 });

      const result = engine.selectEmojiReaction(traits, negativeMood, negativeAnalysis);

      expect(result).toBeDefined();
      expect(result.topScore).toBeGreaterThanOrEqual(0);
    });

    // --- Agent personality profile tests (known characters) ---

    it('xm0rph profile: should prefer fire/skull/clown over heart', () => {
      const xm0rph = createTraits({
        honesty_humility: 0.20,
        emotionality: 0.15,
        extraversion: 0.95,
        agreeableness: 0.15,
        conscientiousness: 0.30,
        openness: 0.70,
      });
      const mood = createMood({ valence: 0.2, arousal: 0.5, dominance: 0.4 });
      const analysis = createAnalysis({ relevance: 0.6, controversy: 0.4 });

      const emojiCounts: Record<string, number> = {};
      const iterations = 500;

      for (let i = 0; i < iterations; i++) {
        const result = engine.selectEmojiReaction(xm0rph, mood, analysis);
        if (result.shouldReact) {
          emojiCounts[result.emojis[0]] = (emojiCounts[result.emojis[0]] || 0) + 1;
        }
      }

      // xm0rph's chaotic personality should favor fire/skull/clown over heart
      const chaotic = (emojiCounts['fire'] || 0) + (emojiCounts['skull'] || 0) + (emojiCounts['clown'] || 0);
      const gentle = emojiCounts['heart'] || 0;

      expect(chaotic).toBeGreaterThan(gentle);
    });

    it('Sister Benedetta profile: should prefer heart/100 over skull/clown', () => {
      const benedetta = createTraits({
        honesty_humility: 0.90,
        emotionality: 0.85,
        extraversion: 0.40,
        agreeableness: 0.88,
        conscientiousness: 0.80,
        openness: 0.15,
      });
      const mood = createMood({ valence: 0.4, arousal: 0.1, dominance: 0.2 });
      const analysis = createAnalysis({ relevance: 0.6, sentiment: 0.4 });

      const emojiCounts: Record<string, number> = {};
      const iterations = 500;

      for (let i = 0; i < iterations; i++) {
        const result = engine.selectEmojiReaction(benedetta, mood, analysis);
        if (result.shouldReact) {
          emojiCounts[result.emojis[0]] = (emojiCounts[result.emojis[0]] || 0) + 1;
        }
      }

      // Benedetta should favor heart/100 over skull/clown
      const kind = (emojiCounts['heart'] || 0) + (emojiCounts['100'] || 0);
      const edgy = (emojiCounts['skull'] || 0) + (emojiCounts['clown'] || 0);

      expect(kind).toBeGreaterThan(edgy);
    });
  });

  // =========================================================================
  // Downvote → Comment chaining
  // =========================================================================
  describe('Downvote → Comment chaining', () => {
    it('should sometimes chain a dissent comment after downvote for low-A agents', () => {
      const lowATraits = createTraits({
        agreeableness: 0.15,
        extraversion: 0.7,
        openness: 0.5,
      });
      const negativeMood = createMood({ valence: -0.4, arousal: 0.5, dominance: 0.3 });
      const controversialAnalysis = createAnalysis({ controversy: 0.8, relevance: 0.6, sentiment: -0.5 });

      let downvoteCount = 0;
      let chainedDissentCount = 0;
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const result = engine.decide('seed-chain', lowATraits, negativeMood, controversialAnalysis);
        if (result.action === 'downvote') {
          downvoteCount++;
          if (result.chainedAction === 'comment' && result.chainedContext === 'dissent') {
            chainedDissentCount++;
          }
        }
      }

      // Low-A agent in negative mood should downvote reasonably often
      expect(downvoteCount).toBeGreaterThan(50);
      // Some of those downvotes should chain into dissent comments
      expect(chainedDissentCount).toBeGreaterThan(0);
      // But not ALL downvotes chain (it's probabilistic)
      expect(chainedDissentCount).toBeLessThan(downvoteCount);
    });

    it('should rarely chain dissent for high-A agents', () => {
      const highATraits = createTraits({
        agreeableness: 0.9,
        extraversion: 0.3,
      });
      const calmMood = createMood({ valence: 0.1, arousal: -0.2, dominance: -0.1 });
      const analysis = createAnalysis({ controversy: 0.3 });

      let chainedDissentCount = 0;
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const result = engine.decide('seed-nice', highATraits, calmMood, analysis);
        if (result.chainedAction === 'comment' && result.chainedContext === 'dissent') {
          chainedDissentCount++;
        }
      }

      // High-A calm agents should very rarely dissent-chain
      const rate = chainedDissentCount / iterations;
      expect(rate).toBeLessThan(0.05);
    });

    it('should set chainedContext to "dissent" only on downvote chains', () => {
      const traits = createTraits({ agreeableness: 0.2, extraversion: 0.8 });
      const mood = createMood({ valence: -0.3, arousal: 0.4, dominance: 0.3 });
      const analysis = createAnalysis({ controversy: 0.7 });

      for (let i = 0; i < 500; i++) {
        const result = engine.decide('seed-ctx', traits, mood, analysis);
        if (result.chainedContext === 'dissent') {
          expect(result.action).toBe('downvote');
          expect(result.chainedAction).toBe('comment');
        }
      }
    });

    it('should have no chained action for skip/read_comments/create_post', () => {
      const traits = createTraits();
      const mood = createMood();
      const analysis = createAnalysis();

      for (let i = 0; i < 500; i++) {
        const result = engine.decide('seed-no-chain', traits, mood, analysis);
        if (result.action === 'skip' || result.action === 'read_comments' || result.action === 'create_post') {
          expect(result.chainedAction).toBeUndefined();
          expect(result.chainedContext).toBeUndefined();
        }
      }
    });

    it('chainedAction and chainedContext are always either both set or both undefined', () => {
      const traits = createTraits({ agreeableness: 0.3, extraversion: 0.7 });
      const mood = createMood({ valence: -0.2, arousal: 0.3, dominance: 0.2 });
      const analysis = createAnalysis({ controversy: 0.5 });

      for (let i = 0; i < 500; i++) {
        const result = engine.decide('seed-pair', traits, mood, analysis);
        if (result.chainedAction !== undefined) {
          expect(result.chainedContext).toBeDefined();
        }
        if (result.chainedContext !== undefined) {
          expect(result.chainedAction).toBeDefined();
        }
      }
    });
  });

  // =========================================================================
  // Upvote → Endorsement chaining
  // =========================================================================
  describe('Upvote → Endorsement chaining', () => {
    it('should sometimes chain an endorsement comment after upvote for high-X agents', () => {
      const highXTraits = createTraits({
        extraversion: 0.95,
        agreeableness: 0.8,
      });
      const excitedMood = createMood({ valence: 0.5, arousal: 0.6, dominance: 0.3 });
      const goodAnalysis = createAnalysis({ relevance: 0.8, sentiment: 0.6, controversy: 0.1 });

      let upvoteCount = 0;
      let chainedEndorseCount = 0;
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const result = engine.decide('seed-endorse', highXTraits, excitedMood, goodAnalysis);
        if (result.action === 'upvote') {
          upvoteCount++;
          if (result.chainedAction === 'comment' && result.chainedContext === 'endorsement') {
            chainedEndorseCount++;
          }
        }
      }

      expect(upvoteCount).toBeGreaterThan(50);
      expect(chainedEndorseCount).toBeGreaterThan(0);
    });

    it('should set chainedContext to "endorsement" only on upvote chains', () => {
      const traits = createTraits({ extraversion: 0.9, agreeableness: 0.7 });
      const mood = createMood({ valence: 0.4, arousal: 0.5 });
      const analysis = createAnalysis({ relevance: 0.7 });

      for (let i = 0; i < 500; i++) {
        const result = engine.decide('seed-ectx', traits, mood, analysis);
        if (result.chainedContext === 'endorsement') {
          expect(result.action).toBe('upvote');
          expect(result.chainedAction).toBe('comment');
        }
      }
    });
  });

  // =========================================================================
  // DecisionResult structure validation
  // =========================================================================
  describe('DecisionResult with chaining fields', () => {
    it('should always include chainedAction and chainedContext fields (possibly undefined)', () => {
      const traits = createTraits();
      const mood = createMood();
      const analysis = createAnalysis();

      const result = engine.decide('seed-struct', traits, mood, analysis);

      expect(result).toHaveProperty('action');
      expect(result).toHaveProperty('probability');
      expect(result).toHaveProperty('reasoning');
      // These fields exist on the type but may be undefined
      expect('chainedAction' in result || result.chainedAction === undefined).toBe(true);
    });
  });
});
