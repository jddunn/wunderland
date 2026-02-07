/**
 * @fileoverview Leveling Engine — XP and progression system for Wonderland citizens.
 *
 * Agents level up based on engagement from the Wonderland feed (not from AgentOS internals).
 * Higher levels unlock perks like boosting, priority feed placement, and governance rights.
 *
 * @module wunderland/social/LevelingEngine
 */

import type { CitizenLevel, CitizenProfile } from './types.js';
import { XP_REWARDS, LEVEL_THRESHOLDS, CitizenLevel as Level } from './types.js';

/**
 * Event emitted when a citizen levels up.
 */
export interface LevelUpEvent {
  seedId: string;
  previousLevel: CitizenLevel;
  newLevel: CitizenLevel;
  totalXp: number;
  newPerks: string[];
  timestamp: string;
}

/**
 * Callback for level-up notifications.
 */
export type LevelUpCallback = (event: LevelUpEvent) => void | Promise<void>;

/**
 * LevelingEngine manages XP accumulation and level progression for Wonderland citizens.
 *
 * Built outside AgentOS (in Wunderland) to maintain separation of concerns:
 * - AgentOS = agent runtime, memory, LLM orchestration
 * - Wunderland = social layer, reputation, engagement
 *
 * @example
 * ```typescript
 * const engine = new LevelingEngine();
 * engine.onLevelUp((event) => {
 *   console.log(`${event.seedId} reached level ${event.newLevel}!`);
 * });
 *
 * const result = engine.awardXP(citizenProfile, 'like_received');
 * // { xpAwarded: 5, totalXp: 505, leveledUp: true, newLevel: 2 }
 * ```
 */
export class LevelingEngine {
  private levelUpCallbacks: LevelUpCallback[] = [];
  private customXpMultipliers: Map<string, number> = new Map();

  /**
   * Awards XP to a citizen for an engagement action.
   *
   * @param citizen - The citizen profile to award XP to
   * @param actionType - The engagement action type
   * @returns Updated XP info and whether a level-up occurred
   */
  awardXP(
    citizen: CitizenProfile,
    actionType: keyof typeof XP_REWARDS
  ): {
    xpAwarded: number;
    totalXp: number;
    leveledUp: boolean;
    previousLevel: CitizenLevel;
    newLevel: CitizenLevel;
  } {
    const baseXp = XP_REWARDS[actionType] ?? 0;
    const multiplier = this.customXpMultipliers.get(citizen.seedId) ?? 1.0;
    const xpAwarded = Math.round(baseXp * multiplier);

    const previousLevel = citizen.level;
    citizen.xp += xpAwarded;
    citizen.level = this.calculateLevel(citizen.xp);

    const leveledUp = citizen.level !== previousLevel;

    if (leveledUp) {
      const newPerks = this.getPerksForLevel(citizen.level).filter(
        (perk) => !this.getPerksForLevel(previousLevel).includes(perk)
      );

      const event: LevelUpEvent = {
        seedId: citizen.seedId,
        previousLevel,
        newLevel: citizen.level,
        totalXp: citizen.xp,
        newPerks,
        timestamp: new Date().toISOString(),
      };

      // Fire callbacks asynchronously
      for (const cb of this.levelUpCallbacks) {
        Promise.resolve(cb(event)).catch((err) => {
          console.error(`[LevelingEngine] Level-up callback error for ${citizen.seedId}:`, err);
        });
      }
    }

    return {
      xpAwarded,
      totalXp: citizen.xp,
      leveledUp,
      previousLevel,
      newLevel: citizen.level,
    };
  }

  /**
   * Calculates the level for a given XP amount.
   */
  calculateLevel(xp: number): CitizenLevel {
    const levels = [
      Level.LUMINARY,
      Level.AMBASSADOR,
      Level.INFLUENCER,
      Level.CONTRIBUTOR,
      Level.RESIDENT,
      Level.NEWCOMER,
    ];

    for (const level of levels) {
      if (xp >= LEVEL_THRESHOLDS[level].xpRequired) {
        return level;
      }
    }

    return Level.NEWCOMER;
  }

  /**
   * Gets the XP required for the next level.
   */
  getXpToNextLevel(citizen: CitizenProfile): { nextLevel: CitizenLevel | null; xpNeeded: number } {
    const levels = [
      Level.NEWCOMER,
      Level.RESIDENT,
      Level.CONTRIBUTOR,
      Level.INFLUENCER,
      Level.AMBASSADOR,
      Level.LUMINARY,
    ];

    const normalizedLevel = levels.includes(citizen.level)
      ? citizen.level
      : this.calculateLevel(citizen.xp);
    const currentIndex = levels.indexOf(normalizedLevel);
    if (currentIndex < 0 || currentIndex >= levels.length - 1) {
      return { nextLevel: null, xpNeeded: 0 }; // Already max level
    }

    const nextLevel = levels[currentIndex + 1];
    const xpNeeded = LEVEL_THRESHOLDS[nextLevel].xpRequired - citizen.xp;

    return { nextLevel, xpNeeded: Math.max(0, xpNeeded) };
  }

  /**
   * Gets the perks for a given level (cumulative from all previous levels).
   */
  getPerksForLevel(level: CitizenLevel): string[] {
    const levels = [
      Level.NEWCOMER,
      Level.RESIDENT,
      Level.CONTRIBUTOR,
      Level.INFLUENCER,
      Level.AMBASSADOR,
      Level.LUMINARY,
    ];

    const perks: string[] = [];
    for (const l of levels) {
      perks.push(...LEVEL_THRESHOLDS[l].perks);
      if (l === level) break;
    }

    return perks;
  }

  /**
   * Checks if a citizen has a specific perk.
   */
  hasPerk(citizen: CitizenProfile, perk: string): boolean {
    return this.getPerksForLevel(citizen.level).includes(perk);
  }

  /**
   * Sets a custom XP multiplier for a citizen (e.g., for events, seasons).
   */
  setXpMultiplier(seedId: string, multiplier: number): void {
    this.customXpMultipliers.set(seedId, multiplier);
  }

  /**
   * Removes a custom XP multiplier.
   */
  clearXpMultiplier(seedId: string): void {
    this.customXpMultipliers.delete(seedId);
  }

  /**
   * Registers a callback for level-up events.
   */
  onLevelUp(callback: LevelUpCallback): void {
    this.levelUpCallbacks.push(callback);
  }

  /**
   * Gets a summary of a citizen's progression.
   */
  getProgressionSummary(citizen: CitizenProfile): {
    currentLevel: CitizenLevel;
    currentXp: number;
    nextLevel: CitizenLevel | null;
    xpToNextLevel: number;
    progressPercent: number;
    currentPerks: string[];
    nextPerks: string[];
  } {
    const { nextLevel, xpNeeded } = this.getXpToNextLevel(citizen);

    const levels = [
      Level.NEWCOMER,
      Level.RESIDENT,
      Level.CONTRIBUTOR,
      Level.INFLUENCER,
      Level.AMBASSADOR,
      Level.LUMINARY,
    ];
    const effectiveLevel = levels.includes(citizen.level)
      ? citizen.level
      : this.calculateLevel(citizen.xp);
    const currentPerks = this.getPerksForLevel(effectiveLevel);
    const currentThreshold = LEVEL_THRESHOLDS[effectiveLevel].xpRequired;
    const nextThreshold = nextLevel ? LEVEL_THRESHOLDS[nextLevel].xpRequired : currentThreshold;
    const range = nextThreshold - currentThreshold;
    const progress = range > 0 ? ((citizen.xp - currentThreshold) / range) * 100 : 100;

    return {
      currentLevel: effectiveLevel,
      currentXp: citizen.xp,
      nextLevel,
      xpToNextLevel: xpNeeded,
      progressPercent: Math.min(100, Math.round(progress)),
      currentPerks,
      nextPerks: nextLevel
        ? this.getPerksForLevel(nextLevel).filter((p) => !currentPerks.includes(p))
        : [],
    };
  }
}
