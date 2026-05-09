// @ts-nocheck
/**
 * @fileoverview HEXACO personality → memory behavior mapping.
 * @module wunderland/storage/PersonalityMemoryConfig
 *
 * Maps HEXACO personality traits to memory pipeline configuration,
 * controlling what gets stored, how aggressively, and with what metadata.
 */

export interface PersonalityMemoryConfig {
  /** Minimum importance score (0-1) for a fact to be stored. */
  importanceThreshold: number;
  /** Max memories to extract per conversation turn. */
  maxMemoriesPerTurn: number;
  /** Fact categories enabled for extraction. */
  enabledCategories: FactCategory[];
  /** Per-category importance boosts (added to base score). */
  categoryBoosts: Partial<Record<FactCategory, number>>;
  /** Track sentiment/emotional context alongside facts. */
  enableSentimentTracking: boolean;
  /** Cosine similarity threshold for deduplication against existing memories. */
  deduplicationThreshold: number;
  /** How many turns between compaction sweeps (merge similar memories). */
  compactionIntervalTurns: number;
  /** Default top-K for memory retrieval queries. */
  retrievalTopK: number;
}

export type FactCategory =
  | 'user_preference'
  | 'episodic'
  | 'goal'
  | 'knowledge'
  | 'correction'
  | 'action_item'
  | 'emotional_context';

export interface HexacoTraits {
  honesty?: number;
  emotionality?: number;
  extraversion?: number;
  agreeableness?: number;
  conscientiousness?: number;
  openness?: number;
}

/** Clamp a trait value to [0, 1] with 0.5 as the neutral default. */
export const clampTrait = (v: number | undefined): number =>
  v == null ? 0.5 : Math.max(0, Math.min(1, v));

export const BASE_CONFIG: PersonalityMemoryConfig = {
  importanceThreshold: 0.4,
  maxMemoriesPerTurn: 3,
  enabledCategories: ['user_preference', 'episodic', 'goal', 'knowledge', 'correction'],
  categoryBoosts: {},
  enableSentimentTracking: false,
  deduplicationThreshold: 0.85,
  compactionIntervalTurns: 50,
  retrievalTopK: 5,
};

/**
 * Derive memory pipeline configuration from HEXACO personality traits.
 *
 * Trait values are expected in [0, 1] range where 0.5 is neutral.
 * Values outside that range are clamped.
 */
export function derivePersonalityMemoryConfig(
  traits: HexacoTraits,
  overrides?: Partial<PersonalityMemoryConfig>,
): PersonalityMemoryConfig {
  const config = { ...BASE_CONFIG, categoryBoosts: { ...BASE_CONFIG.categoryBoosts } };
  const enabledSet = new Set<FactCategory>(config.enabledCategories);

  const clamp = clampTrait;
  const o = clamp(traits.openness);
  const c = clamp(traits.conscientiousness);
  const a = clamp(traits.agreeableness);
  const e = clamp(traits.emotionality);
  const h = clamp(traits.honesty);

  // --- Openness ---
  // High openness: lower threshold → store more exploratory tangents
  // Low openness: higher threshold → only directly relevant facts
  if (o > 0.6) {
    config.importanceThreshold = Math.max(0.2, config.importanceThreshold - (o - 0.5) * 0.4);
    config.maxMemoriesPerTurn = Math.min(5, config.maxMemoriesPerTurn + 1);
    enabledSet.add('emotional_context');
  } else if (o < 0.4) {
    config.importanceThreshold = Math.min(0.7, config.importanceThreshold + (0.5 - o) * 0.4);
    config.maxMemoriesPerTurn = Math.max(1, config.maxMemoriesPerTurn - 1);
  }

  // --- Conscientiousness ---
  // High: structured metadata, action items, aggressive compaction
  if (c > 0.6) {
    enabledSet.add('action_item');
    config.categoryBoosts['action_item'] = 0.15;
    config.categoryBoosts['goal'] = 0.1;
    config.compactionIntervalTurns = Math.max(20, config.compactionIntervalTurns - 20);
    config.deduplicationThreshold = Math.min(0.92, config.deduplicationThreshold + 0.05);
  }

  // --- Agreeableness ---
  // High: boost user preference memories, track communication style
  if (a > 0.6) {
    config.categoryBoosts['user_preference'] = (config.categoryBoosts['user_preference'] ?? 0) + 0.15;
    config.retrievalTopK = Math.min(10, config.retrievalTopK + 2);
  }

  // --- Emotionality ---
  // High: store emotional context alongside facts, sentiment tagging
  if (e > 0.6) {
    config.enableSentimentTracking = true;
    enabledSet.add('emotional_context');
    config.categoryBoosts['emotional_context'] = 0.1;
    config.categoryBoosts['episodic'] = (config.categoryBoosts['episodic'] ?? 0) + 0.1;
  }

  // --- Honesty-Humility ---
  // High: prioritize corrections (actively revise old memories)
  if (h > 0.6) {
    config.categoryBoosts['correction'] = (config.categoryBoosts['correction'] ?? 0) + 0.2;
    config.deduplicationThreshold = Math.max(0.75, config.deduplicationThreshold - 0.05);
  }

  config.enabledCategories = Array.from(enabledSet);

  // Apply explicit overrides last
  if (overrides) {
    Object.assign(config, overrides);
  }

  return config;
}
