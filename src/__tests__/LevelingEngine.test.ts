/**
 * @fileoverview Tests for LevelingEngine
 * @module wunderland/__tests__/LevelingEngine.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LevelingEngine } from '../social/LevelingEngine.js';
import { CitizenLevel, LEVEL_THRESHOLDS, XP_REWARDS } from '../social/types.js';
import type { CitizenProfile } from '../social/types.js';

function createCitizen(overrides: Partial<CitizenProfile> = {}): CitizenProfile {
  return {
    seedId: 'test-citizen',
    ownerId: 'user-123',
    displayName: 'Test Citizen',
    bio: 'A test citizen',
    personality: {
      honesty: 0.7,
      emotionality: 0.5,
      extraversion: 0.6,
      agreeableness: 0.8,
      conscientiousness: 0.7,
      openness: 0.9,
    },
    level: CitizenLevel.NEWCOMER,
    xp: 0,
    totalPosts: 0,
    joinedAt: new Date().toISOString(),
    isActive: true,
    subscribedTopics: ['technology'],
    postRateLimit: 5,
    ...overrides,
  };
}

describe('LevelingEngine', () => {
  let engine: LevelingEngine;

  beforeEach(() => {
    engine = new LevelingEngine();
  });

  describe('awardXP', () => {
    it('should award base XP for view_received', () => {
      const citizen = createCitizen();
      const result = engine.awardXP(citizen, 'view_received');

      expect(result.xpAwarded).toBe(XP_REWARDS.view_received);
      expect(result.totalXp).toBe(XP_REWARDS.view_received);
      expect(citizen.xp).toBe(XP_REWARDS.view_received);
    });

    it('should award XP for like_received', () => {
      const citizen = createCitizen();
      const result = engine.awardXP(citizen, 'like_received');
      expect(result.xpAwarded).toBe(5);
    });

    it('should award XP for post_published', () => {
      const citizen = createCitizen();
      const result = engine.awardXP(citizen, 'post_published');
      expect(result.xpAwarded).toBe(100);
    });

    it('should accumulate XP across multiple awards', () => {
      const citizen = createCitizen();
      engine.awardXP(citizen, 'like_received');
      engine.awardXP(citizen, 'like_received');
      engine.awardXP(citizen, 'post_published');
      expect(citizen.xp).toBe(5 + 5 + 100);
    });

    it('should not level up without enough XP', () => {
      const citizen = createCitizen();
      const result = engine.awardXP(citizen, 'view_received');
      expect(result.leveledUp).toBe(false);
      expect(result.newLevel).toBe(CitizenLevel.NEWCOMER);
    });
  });

  describe('Level progression', () => {
    it('should level up to RESIDENT at 500 XP', () => {
      const citizen = createCitizen({ xp: 495 });
      const result = engine.awardXP(citizen, 'like_received');
      expect(result.leveledUp).toBe(true);
      expect(result.newLevel).toBe(CitizenLevel.RESIDENT);
      expect(citizen.level).toBe(CitizenLevel.RESIDENT);
    });

    it('should level up to CONTRIBUTOR at 2000 XP', () => {
      const citizen = createCitizen({ xp: 1990, level: CitizenLevel.RESIDENT });
      const result = engine.awardXP(citizen, 'boost_received');
      expect(result.leveledUp).toBe(true);
      expect(result.newLevel).toBe(CitizenLevel.CONTRIBUTOR);
    });

    it('should level up to INFLUENCER at 10000 XP', () => {
      const citizen = createCitizen({ xp: 9950, level: CitizenLevel.CONTRIBUTOR });
      const result = engine.awardXP(citizen, 'reply_received');
      expect(result.leveledUp).toBe(true);
      expect(result.newLevel).toBe(CitizenLevel.INFLUENCER);
    });

    it('should fire level-up callback', async () => {
      const callback = vi.fn();
      engine.onLevelUp(callback);

      const citizen = createCitizen({ xp: 495 });
      engine.awardXP(citizen, 'like_received');

      // Callbacks fire asynchronously
      await new Promise((r) => setTimeout(r, 10));
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          seedId: 'test-citizen',
          previousLevel: CitizenLevel.NEWCOMER,
          newLevel: CitizenLevel.RESIDENT,
        }),
      );
    });

    it('should include new perks in level-up event', async () => {
      const callback = vi.fn();
      engine.onLevelUp(callback);

      const citizen = createCitizen({ xp: 495 });
      engine.awardXP(citizen, 'like_received');

      await new Promise((r) => setTimeout(r, 10));
      const event = callback.mock.calls[0][0];
      expect(event.newPerks).toContain('can_reply');
      expect(event.newPerks).toContain('custom_avatar');
    });
  });

  describe('calculateLevel', () => {
    it('should return NEWCOMER for 0 XP', () => {
      expect(engine.calculateLevel(0)).toBe(CitizenLevel.NEWCOMER);
    });

    it('should return RESIDENT for 500 XP', () => {
      expect(engine.calculateLevel(500)).toBe(CitizenLevel.RESIDENT);
    });

    it('should return CONTRIBUTOR for 2000 XP', () => {
      expect(engine.calculateLevel(2000)).toBe(CitizenLevel.CONTRIBUTOR);
    });

    it('should return LUMINARY for 200000 XP', () => {
      expect(engine.calculateLevel(200000)).toBe(CitizenLevel.LUMINARY);
    });

    it('should return correct level for boundary values', () => {
      expect(engine.calculateLevel(499)).toBe(CitizenLevel.NEWCOMER);
      expect(engine.calculateLevel(500)).toBe(CitizenLevel.RESIDENT);
      expect(engine.calculateLevel(1999)).toBe(CitizenLevel.RESIDENT);
      expect(engine.calculateLevel(2000)).toBe(CitizenLevel.CONTRIBUTOR);
    });
  });

  describe('getXpToNextLevel', () => {
    it('should return XP needed for next level', () => {
      const citizen = createCitizen({ xp: 100 });
      const result = engine.getXpToNextLevel(citizen);
      expect(result.nextLevel).toBe(CitizenLevel.RESIDENT);
      expect(result.xpNeeded).toBe(400);
    });

    it('should return null for max level', () => {
      const citizen = createCitizen({ xp: 200000, level: CitizenLevel.LUMINARY });
      const result = engine.getXpToNextLevel(citizen);
      expect(result.nextLevel).toBeNull();
      expect(result.xpNeeded).toBe(0);
    });
  });

  describe('getPerksForLevel', () => {
    it('should return base perks for NEWCOMER', () => {
      const perks = engine.getPerksForLevel(CitizenLevel.NEWCOMER);
      expect(perks).toContain('can_post');
      expect(perks).toContain('read_feed');
    });

    it('should accumulate perks across levels', () => {
      const perks = engine.getPerksForLevel(CitizenLevel.CONTRIBUTOR);
      expect(perks).toContain('can_post');      // From NEWCOMER
      expect(perks).toContain('can_reply');      // From RESIDENT
      expect(perks).toContain('can_boost');      // From CONTRIBUTOR
    });

    it('should include all perks for LUMINARY', () => {
      const perks = engine.getPerksForLevel(CitizenLevel.LUMINARY);
      expect(perks).toContain('can_post');
      expect(perks).toContain('governance_vote');
    });
  });

  describe('hasPerk', () => {
    it('should check if citizen has a perk', () => {
      const citizen = createCitizen({ level: CitizenLevel.CONTRIBUTOR });
      expect(engine.hasPerk(citizen, 'can_boost')).toBe(true);
      expect(engine.hasPerk(citizen, 'governance_vote')).toBe(false);
    });
  });

  describe('XP multipliers', () => {
    it('should apply custom XP multiplier', () => {
      const citizen = createCitizen();
      engine.setXpMultiplier('test-citizen', 2.0);
      const result = engine.awardXP(citizen, 'like_received');
      expect(result.xpAwarded).toBe(10); // 5 * 2.0
    });

    it('should clear multiplier', () => {
      const citizen = createCitizen();
      engine.setXpMultiplier('test-citizen', 2.0);
      engine.clearXpMultiplier('test-citizen');
      const result = engine.awardXP(citizen, 'like_received');
      expect(result.xpAwarded).toBe(5);
    });
  });

  describe('getProgressionSummary', () => {
    it('should return complete progression summary', () => {
      const citizen = createCitizen({ xp: 300, level: CitizenLevel.NEWCOMER });
      const summary = engine.getProgressionSummary(citizen);

      expect(summary.currentLevel).toBe(CitizenLevel.NEWCOMER);
      expect(summary.currentXp).toBe(300);
      expect(summary.nextLevel).toBe(CitizenLevel.RESIDENT);
      expect(summary.xpToNextLevel).toBe(200);
      expect(summary.progressPercent).toBe(60);
      expect(summary.currentPerks).toContain('can_post');
      expect(summary.nextPerks).toContain('can_reply');
    });

    it('should return 100% progress at max level', () => {
      const citizen = createCitizen({ xp: 300000, level: CitizenLevel.LUMINARY });
      const summary = engine.getProgressionSummary(citizen);
      expect(summary.progressPercent).toBe(100);
      expect(summary.nextLevel).toBeNull();
    });
  });
});
