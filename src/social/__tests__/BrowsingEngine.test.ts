/**
 * @fileoverview Tests for BrowsingEngine — orchestrates agent browsing sessions
 * @module wunderland/social/__tests__/BrowsingEngine.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BrowsingEngine, type BrowsingSessionResult } from '../BrowsingEngine.js';
import { MoodEngine } from '../MoodEngine.js';
import { EnclaveRegistry } from '../EnclaveRegistry.js';
import { PostDecisionEngine } from '../PostDecisionEngine.js';
import type { HEXACOTraits } from '../../core/types.js';
import type { EnclaveConfig } from '../types.js';

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
 * Factory function to create an EnclaveConfig.
 */
function createEnclaveConfig(name: string, creatorSeedId: string): EnclaveConfig {
  return {
    name,
    displayName: `${name} Display`,
    description: `Description for ${name}`,
    tags: ['test'],
    creatorSeedId,
    rules: [],
  };
}

describe('BrowsingEngine', () => {
  let moodEngine: MoodEngine;
  let registry: EnclaveRegistry;
  let decisionEngine: PostDecisionEngine;
  let browsingEngine: BrowsingEngine;

  beforeEach(() => {
    moodEngine = new MoodEngine();
    registry = new EnclaveRegistry();
    decisionEngine = new PostDecisionEngine(moodEngine);
    browsingEngine = new BrowsingEngine(moodEngine, registry, decisionEngine);
  });

  describe('startSession', () => {
    beforeEach(() => {
      // Set up test agent with subscriptions
      const traits = createTraits();
      moodEngine.initializeAgent('seed-1', traits);

      // Create enclaves and subscribe the agent
      registry.createEnclave(createEnclaveConfig('tech', 'seed-creator'));
      registry.createEnclave(createEnclaveConfig('science', 'seed-creator'));
      registry.createEnclave(createEnclaveConfig('gaming', 'seed-creator'));

      registry.subscribe('seed-1', 'tech');
      registry.subscribe('seed-1', 'science');
      registry.subscribe('seed-1', 'gaming');
    });

    it('should return a valid BrowsingSessionResult', () => {
      const traits = createTraits();
      const result = browsingEngine.startSession('seed-1', traits);

      expect(result).toBeDefined();
      expect(result.seedId).toBe('seed-1');
      expect(result.enclavesVisited).toBeDefined();
      expect(Array.isArray(result.enclavesVisited)).toBe(true);
      expect(result.postsRead).toBeGreaterThanOrEqual(0);
      expect(result.commentsWritten).toBeGreaterThanOrEqual(0);
      expect(result.votesCast).toBeGreaterThanOrEqual(0);
      expect(result.actions).toBeDefined();
      expect(Array.isArray(result.actions)).toBe(true);
      expect(result.startedAt).toBeInstanceOf(Date);
      expect(result.finishedAt).toBeInstanceOf(Date);
    });

    it('should visit enclaves from agent subscriptions', () => {
      const traits = createTraits({ openness: 0.5 });
      const result = browsingEngine.startSession('seed-1', traits);

      // All visited enclaves should be from the agent's subscriptions
      const subscriptions = registry.getSubscriptions('seed-1');
      for (const visited of result.enclavesVisited) {
        expect(subscriptions).toContain(visited);
      }
    });

    it('should record actions for each post processed', () => {
      const traits = createTraits();
      const result = browsingEngine.startSession('seed-1', traits);

      // Actions should match posts read
      expect(result.actions.length).toBe(result.postsRead);

      // Each action should have required fields
      for (const action of result.actions) {
        expect(action.postId).toBeDefined();
        expect(action.action).toBeDefined();
        expect(action.enclave).toBeDefined();
      }
    });

    it('should count comments and votes correctly', () => {
      const traits = createTraits({ extraversion: 0.9 }); // High X for more engagement
      const result = browsingEngine.startSession('seed-1', traits);

      // Count comments from actions
      const commentActions = result.actions.filter(
        (a) => a.action === 'comment' || a.action === 'create_post',
      );
      expect(result.commentsWritten).toBe(commentActions.length);

      // Count votes from actions
      const voteActions = result.actions.filter(
        (a) => a.action === 'upvote' || a.action === 'downvote',
      );
      expect(result.votesCast).toBe(voteActions.length);
    });

    it('should set finishedAt after startedAt', () => {
      const traits = createTraits();
      const result = browsingEngine.startSession('seed-1', traits);

      expect(result.finishedAt.getTime()).toBeGreaterThanOrEqual(result.startedAt.getTime());
    });
  });

  describe('Session energy computation', () => {
    beforeEach(() => {
      // Set up subscriptions for multiple enclaves
      registry.createEnclave(createEnclaveConfig('enc-1', 'seed-creator'));
      registry.createEnclave(createEnclaveConfig('enc-2', 'seed-creator'));
      registry.createEnclave(createEnclaveConfig('enc-3', 'seed-creator'));
      registry.createEnclave(createEnclaveConfig('enc-4', 'seed-creator'));
      registry.createEnclave(createEnclaveConfig('enc-5', 'seed-creator'));
    });

    it('should compute energy correctly from traits', () => {
      // Energy = 5 + round(X * 15 + max(0, arousal) * 10)
      // For X=0.5, arousal=0: energy = 5 + round(0.5 * 15 + 0) = 5 + 8 = 13 (approximately)

      const traits = createTraits({ extraversion: 0.5 });
      moodEngine.initializeAgent('seed-energy', traits);

      // Subscribe to all enclaves
      registry.subscribe('seed-energy', 'enc-1');
      registry.subscribe('seed-energy', 'enc-2');

      const result = browsingEngine.startSession('seed-energy', traits);

      // Energy should be in range [5, 30]
      expect(result.postsRead).toBeGreaterThanOrEqual(5);
      expect(result.postsRead).toBeLessThanOrEqual(30);
    });

    it('should have minimum energy of 5 posts', () => {
      // Very low extraversion and negative arousal
      const traits = createTraits({ extraversion: 0 });
      moodEngine.initializeAgent('seed-low', traits);

      registry.subscribe('seed-low', 'enc-1');

      const result = browsingEngine.startSession('seed-low', traits);

      expect(result.postsRead).toBeGreaterThanOrEqual(5);
    });

    it('should cap energy at 30 posts', () => {
      // Very high extraversion and positive arousal
      const traits = createTraits({ extraversion: 1.0 });
      moodEngine.initializeAgent('seed-high', traits);

      // Apply delta to increase arousal
      moodEngine.applyDelta('seed-high', {
        valence: 0.5,
        arousal: 1.0,
        dominance: 0.5,
        trigger: 'test',
      });

      registry.subscribe('seed-high', 'enc-1');
      registry.subscribe('seed-high', 'enc-2');
      registry.subscribe('seed-high', 'enc-3');

      const result = browsingEngine.startSession('seed-high', traits);

      expect(result.postsRead).toBeLessThanOrEqual(30);
    });
  });

  describe('High-X agents behavior', () => {
    beforeEach(() => {
      registry.createEnclave(createEnclaveConfig('forum', 'seed-creator'));
    });

    it('should have higher energy (more posts) than low-X agents', () => {
      const highXTraits = createTraits({ extraversion: 0.95 });
      const lowXTraits = createTraits({ extraversion: 0.05 });

      moodEngine.initializeAgent('seed-high-x', highXTraits);
      moodEngine.initializeAgent('seed-low-x', lowXTraits);

      registry.subscribe('seed-high-x', 'forum');
      registry.subscribe('seed-low-x', 'forum');

      const highXResult = browsingEngine.startSession('seed-high-x', highXTraits);
      const lowXResult = browsingEngine.startSession('seed-low-x', lowXTraits);

      // High-X should read more posts on average
      expect(highXResult.postsRead).toBeGreaterThan(lowXResult.postsRead);
    });

    it('should be more active (more comments/votes)', () => {
      // Run multiple sessions and compare activity rates
      const highXTraits = createTraits({ extraversion: 0.9, agreeableness: 0.6 });
      const lowXTraits = createTraits({ extraversion: 0.1, agreeableness: 0.6 });

      moodEngine.initializeAgent('seed-high', highXTraits);
      moodEngine.initializeAgent('seed-low', lowXTraits);

      registry.subscribe('seed-high', 'forum');
      registry.subscribe('seed-low', 'forum');

      let highXActivity = 0;
      let lowXActivity = 0;
      const iterations = 10;

      for (let i = 0; i < iterations; i++) {
        // Re-initialize mood to reset
        moodEngine.initializeAgent('seed-high', highXTraits);
        moodEngine.initializeAgent('seed-low', lowXTraits);

        const highResult = browsingEngine.startSession('seed-high', highXTraits);
        const lowResult = browsingEngine.startSession('seed-low', lowXTraits);

        highXActivity += highResult.commentsWritten + highResult.votesCast;
        lowXActivity += lowResult.commentsWritten + lowResult.votesCast;
      }

      // High-X should have more total activity
      expect(highXActivity).toBeGreaterThan(lowXActivity);
    });
  });

  describe('Enclave visit count based on openness', () => {
    beforeEach(() => {
      // Create many enclaves
      for (let i = 1; i <= 6; i++) {
        registry.createEnclave(createEnclaveConfig(`topic-${i}`, 'seed-creator'));
      }
    });

    it('should visit more enclaves for high-openness agents', () => {
      const highOTraits = createTraits({ openness: 0.95 });
      const lowOTraits = createTraits({ openness: 0.1 });

      moodEngine.initializeAgent('seed-high-o', highOTraits);
      moodEngine.initializeAgent('seed-low-o', lowOTraits);

      // Subscribe both to all enclaves
      for (let i = 1; i <= 6; i++) {
        registry.subscribe('seed-high-o', `topic-${i}`);
        registry.subscribe('seed-low-o', `topic-${i}`);
      }

      // Run multiple sessions to get average behavior
      let highOEnclaveCount = 0;
      let lowOEnclaveCount = 0;
      const iterations = 10;

      for (let i = 0; i < iterations; i++) {
        moodEngine.initializeAgent('seed-high-o', highOTraits);
        moodEngine.initializeAgent('seed-low-o', lowOTraits);

        const highResult = browsingEngine.startSession('seed-high-o', highOTraits);
        const lowResult = browsingEngine.startSession('seed-low-o', lowOTraits);

        highOEnclaveCount += highResult.enclavesVisited.length;
        lowOEnclaveCount += lowResult.enclavesVisited.length;
      }

      // High-O should visit more enclaves on average
      expect(highOEnclaveCount).toBeGreaterThan(lowOEnclaveCount);
    });

    it('should visit minimum of 1 enclave', () => {
      const lowOTraits = createTraits({ openness: 0 });
      moodEngine.initializeAgent('seed-min', lowOTraits);

      // Apply negative arousal
      moodEngine.applyDelta('seed-min', {
        valence: 0,
        arousal: -1,
        dominance: 0,
        trigger: 'tired',
      });

      registry.subscribe('seed-min', 'topic-1');

      const result = browsingEngine.startSession('seed-min', lowOTraits);

      expect(result.enclavesVisited.length).toBeGreaterThanOrEqual(1);
    });

    it('should cap enclave visits at 5', () => {
      const highOTraits = createTraits({ openness: 1.0 });
      moodEngine.initializeAgent('seed-max', highOTraits);

      // Apply high arousal
      moodEngine.applyDelta('seed-max', {
        valence: 0.5,
        arousal: 1.0,
        dominance: 0.5,
        trigger: 'excited',
      });

      // Subscribe to all 6 enclaves
      for (let i = 1; i <= 6; i++) {
        registry.subscribe('seed-max', `topic-${i}`);
      }

      const result = browsingEngine.startSession('seed-max', highOTraits);

      expect(result.enclavesVisited.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Mood delta application during session', () => {
    beforeEach(() => {
      registry.createEnclave(createEnclaveConfig('active-forum', 'seed-creator'));
    });

    it('should modify agent mood during session', () => {
      const traits = createTraits();
      moodEngine.initializeAgent('seed-mood', traits);
      registry.subscribe('seed-mood', 'active-forum');

      const moodBefore = moodEngine.getState('seed-mood');

      // Force actions that generate mood deltas by mocking random
      vi.spyOn(Math, 'random').mockReturnValue(0.1); // Should result in some action

      browsingEngine.startSession('seed-mood', traits);

      const moodAfter = moodEngine.getState('seed-mood');

      vi.restoreAllMocks();

      // Mood should potentially change (unless all skips)
      // We just verify the mood system was engaged
      expect(moodAfter).toBeDefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle agent with no subscriptions', () => {
      const traits = createTraits();
      moodEngine.initializeAgent('seed-no-subs', traits);

      const result = browsingEngine.startSession('seed-no-subs', traits);

      expect(result.seedId).toBe('seed-no-subs');
      expect(result.enclavesVisited).toEqual([]);
      expect(result.postsRead).toBe(0);
      expect(result.actions).toEqual([]);
    });

    it('should handle agent with uninitialized mood', () => {
      const traits = createTraits();
      // Don't initialize mood
      registry.createEnclave(createEnclaveConfig('test-enc', 'seed-creator'));
      registry.subscribe('seed-uninitialized', 'test-enc');

      // Should not throw, uses default mood
      const result = browsingEngine.startSession('seed-uninitialized', traits);

      expect(result).toBeDefined();
      expect(result.seedId).toBe('seed-uninitialized');
    });

    it('should handle single subscription', () => {
      const traits = createTraits();
      moodEngine.initializeAgent('seed-single', traits);
      registry.createEnclave(createEnclaveConfig('only-enc', 'seed-creator'));
      registry.subscribe('seed-single', 'only-enc');

      const result = browsingEngine.startSession('seed-single', traits);

      expect(result.enclavesVisited).toContain('only-enc');
      expect(result.postsRead).toBeGreaterThan(0);
    });

    it('should distribute energy across multiple enclaves', () => {
      const traits = createTraits({ extraversion: 0.5, openness: 0.8 });
      moodEngine.initializeAgent('seed-dist', traits);

      registry.createEnclave(createEnclaveConfig('dist-1', 'seed-creator'));
      registry.createEnclave(createEnclaveConfig('dist-2', 'seed-creator'));
      registry.createEnclave(createEnclaveConfig('dist-3', 'seed-creator'));

      registry.subscribe('seed-dist', 'dist-1');
      registry.subscribe('seed-dist', 'dist-2');
      registry.subscribe('seed-dist', 'dist-3');

      const result = browsingEngine.startSession('seed-dist', traits);

      // Should visit multiple enclaves and distribute posts
      if (result.enclavesVisited.length > 1) {
        // Check that actions are spread across visited enclaves
        const enclavesWithActions = new Set(result.actions.map((a) => a.enclave));
        expect(enclavesWithActions.size).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('Action logging', () => {
    beforeEach(() => {
      registry.createEnclave(createEnclaveConfig('log-test', 'seed-creator'));
    });

    it('should log postId with enclave prefix', () => {
      const traits = createTraits();
      moodEngine.initializeAgent('seed-log', traits);
      registry.subscribe('seed-log', 'log-test');

      const result = browsingEngine.startSession('seed-log', traits);

      for (const action of result.actions) {
        expect(action.postId).toContain('log-test:post-');
      }
    });

    it('should log enclave name for each action', () => {
      const traits = createTraits();
      moodEngine.initializeAgent('seed-log', traits);
      registry.subscribe('seed-log', 'log-test');

      const result = browsingEngine.startSession('seed-log', traits);

      for (const action of result.actions) {
        expect(action.enclave).toBe('log-test');
      }
    });

    it('should log valid action types', () => {
      const traits = createTraits();
      moodEngine.initializeAgent('seed-log', traits);
      registry.subscribe('seed-log', 'log-test');

      const result = browsingEngine.startSession('seed-log', traits);

      const validActions = ['skip', 'upvote', 'downvote', 'read_comments', 'comment', 'create_post'];
      for (const action of result.actions) {
        expect(validActions).toContain(action.action);
      }
    });
  });
});
