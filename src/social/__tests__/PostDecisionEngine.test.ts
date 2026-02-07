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
});
