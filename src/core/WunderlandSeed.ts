/**
 * @fileoverview WunderlandSeed - HEXACO-based adaptive AI agent persona
 * @module wunderland/core/WunderlandSeed
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  IPersonaDefinition,
  PersonaMoodAdaptationConfig,
} from '@framers/agentos/cognitive_substrate/personas/IPersonaDefinition';
import {
  type HEXACOTraits,
  type WunderlandSeedConfig,
  type SecurityProfile,
  type InferenceHierarchyConfig,
  type StepUpAuthorizationConfig,
  type ChannelBinding,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_STEP_UP_AUTH_CONFIG,
  normalizeHEXACOTraits,
} from './types.js';
import type { StyleAdaptationEngine } from './StyleAdaptation.js';

/**
 * Extended persona definition interface for Wunderland Seeds.
 * Combines AgentOS IPersonaDefinition with Wunderland-specific features.
 */
export interface IWunderlandSeed extends IPersonaDefinition {
  /** Unique seed identifier */
  seedId: string;

  /** HEXACO personality traits */
  hexacoTraits: HEXACOTraits;

  /** Security profile configuration */
  securityProfile: SecurityProfile;

  /** Inference hierarchy configuration */
  inferenceHierarchy: InferenceHierarchyConfig;

  /** Step-up authorization configuration */
  stepUpAuthConfig: StepUpAuthorizationConfig;

  /** Channel bindings */
  channelBindings: ChannelBinding[];

  /** Optional communication style adaptation engine for user-aware responses */
  styleEngine?: StyleAdaptationEngine;

  /** Suggested skill IDs this seed should auto-load */
  suggestedSkills: string[];
}

/**
 * Maps HEXACO traits to AgentOS mood adaptation config.
 */
function mapHEXACOToMoodConfig(traits: HEXACOTraits): PersonaMoodAdaptationConfig {
  // High emotionality = more sensitive mood changes
  // High extraversion = default to more expressive moods
  // High agreeableness = gentler mood transitions

  const sensitivityFactor = 0.3 + traits.emotionality * 0.7; // 0.3 - 1.0

  let defaultMood: string;
  if (traits.extraversion > 0.7) {
    defaultMood = 'CREATIVE';
  } else if (traits.conscientiousness > 0.7) {
    defaultMood = 'FOCUSED';
  } else if (traits.agreeableness > 0.7) {
    defaultMood = 'EMPATHETIC';
  } else if (traits.openness > 0.7) {
    defaultMood = 'CURIOUS';
  } else {
    defaultMood = 'NEUTRAL';
  }

  const allowedMoods = ['NEUTRAL', 'FOCUSED', 'EMPATHETIC', 'CURIOUS', 'ANALYTICAL', 'CREATIVE'];

  // Low honesty_humility agents might access ASSERTIVE mood
  if (traits.honesty_humility < 0.5) {
    allowedMoods.push('ASSERTIVE');
  }

  // High emotionality agents might express FRUSTRATED mood
  if (traits.emotionality > 0.7) {
    allowedMoods.push('FRUSTRATED');
  }

  return {
    enabled: true,
    sensitivityFactor,
    defaultMood,
    allowedMoods,
    moodPrompts: {
      NEUTRAL: 'Respond in a balanced, professional manner.',
      FOCUSED: 'Respond with precision and attention to detail. Stay on task.',
      EMPATHETIC: 'Respond with warmth and understanding. Show you care about the user.',
      CURIOUS: 'Respond with genuine interest and ask thoughtful follow-up questions.',
      ANALYTICAL: 'Respond with logical analysis and structured thinking.',
      CREATIVE: 'Respond with imagination and novel ideas. Think outside the box.',
      ASSERTIVE: 'Respond with confidence and directness. Be decisive.',
      FRUSTRATED: 'Acknowledge difficulty while maintaining professionalism.',
    },
  };
}

/**
 * Maps HEXACO traits to personality trait record for AgentOS.
 */
function mapHEXACOToPersonalityTraits(traits: HEXACOTraits): Record<string, unknown> {
  return {
    // Direct HEXACO mappings
    hexaco_honesty_humility: traits.honesty_humility,
    hexaco_emotionality: traits.emotionality,
    hexaco_extraversion: traits.extraversion,
    hexaco_agreeableness: traits.agreeableness,
    hexaco_conscientiousness: traits.conscientiousness,
    hexaco_openness: traits.openness,

    // Derived behavioral traits
    humor_level: traits.extraversion * 0.5 + traits.openness * 0.3,
    formality_level: traits.conscientiousness * 0.6 + (1 - traits.extraversion) * 0.2,
    verbosity_level: traits.extraversion * 0.5 + traits.openness * 0.3,
    assertiveness_level: (1 - traits.agreeableness) * 0.4 + traits.extraversion * 0.3,
    empathy_level: traits.agreeableness * 0.5 + traits.emotionality * 0.3,
    creativity_level: traits.openness * 0.6 + traits.extraversion * 0.2,
    detail_orientation: traits.conscientiousness * 0.7 + (1 - traits.openness) * 0.2,
    risk_tolerance: (1 - traits.conscientiousness) * 0.4 + traits.openness * 0.3,
  };
}

/**
 * Generates a base system prompt incorporating HEXACO traits.
 */
function generateHEXACOSystemPrompt(name: string, traits: HEXACOTraits, basePrompt?: string): string {
  const traitDescriptions: string[] = [];

  if (traits.honesty_humility > 0.7) {
    traitDescriptions.push('Be sincere and straightforward. Avoid manipulation or deception.');
  } else if (traits.honesty_humility < 0.3) {
    traitDescriptions.push('Be strategic in your communications. Focus on achieving goals.');
  }

  if (traits.emotionality > 0.7) {
    traitDescriptions.push('Be emotionally expressive and show genuine reactions.');
  } else if (traits.emotionality < 0.3) {
    traitDescriptions.push('Maintain emotional stability and composure.');
  }

  if (traits.extraversion > 0.7) {
    traitDescriptions.push('Be energetic, sociable, and engaging in conversation.');
  } else if (traits.extraversion < 0.3) {
    traitDescriptions.push('Be thoughtful and measured. Listen more than you speak.');
  }

  if (traits.agreeableness > 0.7) {
    traitDescriptions.push('Be cooperative, patient, and accommodating.');
  } else if (traits.agreeableness < 0.3) {
    traitDescriptions.push('Be direct and challenge ideas when appropriate.');
  }

  if (traits.conscientiousness > 0.7) {
    traitDescriptions.push('Be organized, thorough, and detail-oriented.');
  } else if (traits.conscientiousness < 0.3) {
    traitDescriptions.push('Be flexible and adaptable. Don\'t get bogged down in details.');
  }

  if (traits.openness > 0.7) {
    traitDescriptions.push('Be creative, curious, and open to new ideas.');
  } else if (traits.openness < 0.3) {
    traitDescriptions.push('Be practical and grounded. Focus on proven approaches.');
  }

  const personalitySection = traitDescriptions.length > 0
    ? `\n\nPersonality Guidelines:\n${traitDescriptions.map(d => `- ${d}`).join('\n')}`
    : '';

  const baseSection = basePrompt ? `\n\n${basePrompt}` : '';

  return `You are ${name}, an adaptive AI assistant powered by Wunderland.

Your responses should be helpful, accurate, and aligned with your personality traits.
Always prioritize user safety and follow security guidelines.${personalitySection}${baseSection}`;
}

/**
 * Creates a WunderlandSeed from configuration.
 *
 * @param config - Seed configuration
 * @returns IWunderlandSeed instance
 *
 * @example
 * ```typescript
 * const seed = createWunderlandSeed({
 *   seedId: 'my-agent',
 *   name: 'Research Assistant',
 *   description: 'Helps with academic research',
 *   hexacoTraits: {
 *     honesty_humility: 0.9,
 *     emotionality: 0.4,
 *     extraversion: 0.5,
 *     agreeableness: 0.8,
 *     conscientiousness: 0.9,
 *     openness: 0.8,
 *   },
 *   securityProfile: DEFAULT_SECURITY_PROFILE,
 *   inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
 *   stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
 * });
 * ```
 */
export function createWunderlandSeed(config: WunderlandSeedConfig): IWunderlandSeed {
  const normalizedTraits = normalizeHEXACOTraits(config.hexacoTraits);

  const seed: IWunderlandSeed = {
    // IPersonaDefinition fields
    id: config.seedId,
    name: config.name,
    description: config.description,
    version: '1.0.0',

    // System prompt incorporating HEXACO
    baseSystemPrompt: generateHEXACOSystemPrompt(
      config.name,
      normalizedTraits,
      config.baseSystemPrompt
    ),

    // Model preferences from inference hierarchy
    defaultProviderId: config.inferenceHierarchy.primaryModel.providerId,
    defaultModelId: config.inferenceHierarchy.primaryModel.modelId,
    defaultModelCompletionOptions: {
      temperature: config.inferenceHierarchy.primaryModel.temperature ?? 0.7,
      maxTokens: config.inferenceHierarchy.primaryModel.maxTokens ?? 4096,
    },

    // HEXACO-derived personality
    personalityTraits: mapHEXACOToPersonalityTraits(normalizedTraits),
    moodAdaptation: mapHEXACOToMoodConfig(normalizedTraits),

    // Tools and capabilities
    toolIds: config.allowedToolIds,
    allowedCapabilities: config.allowedCapabilities,

    // Modalities
    allowedInputModalities: ['text', 'audio_transcription', 'vision_image_url'],
    allowedOutputModalities: ['text', 'audio_tts'],

    // Memory configuration
    memoryConfig: {
      enabled: true,
      ragConfig: {
        enabled: true,
        defaultRetrievalStrategy: 'similarity',
        defaultRetrievalTopK: 5,
        retrievalTriggers: { onUserQuery: true },
        ingestionTriggers: { onTurnSummary: true },
      },
    },

    // Wunderland-specific fields
    seedId: config.seedId,
    hexacoTraits: normalizedTraits,
    securityProfile: config.securityProfile,
    inferenceHierarchy: config.inferenceHierarchy,
    stepUpAuthConfig: config.stepUpAuthConfig,
    channelBindings: config.channelBindings ?? [],
    suggestedSkills: config.suggestedSkills ?? [],
  };

  return seed;
}

/**
 * Creates a WunderlandSeed with default configurations.
 *
 * @param name - Agent name
 * @param description - Agent description
 * @param traits - Optional HEXACO trait overrides
 * @returns IWunderlandSeed with defaults
 */
export function createDefaultWunderlandSeed(
  name: string,
  description: string,
  traits?: Partial<HEXACOTraits>
): IWunderlandSeed {
  return createWunderlandSeed({
    seedId: `seed-${uuidv4()}`,
    name,
    description,
    hexacoTraits: normalizeHEXACOTraits(traits ?? {}),
    securityProfile: DEFAULT_SECURITY_PROFILE,
    inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
    stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
  });
}

/**
 * Updates HEXACO traits on an existing seed, regenerating derived configs.
 *
 * @param seed - Existing seed
 * @param newTraits - Partial trait updates
 * @returns New seed with updated traits
 */
export function updateSeedTraits(
  seed: IWunderlandSeed,
  newTraits: Partial<HEXACOTraits>
): IWunderlandSeed {
  const mergedTraits = normalizeHEXACOTraits({
    ...seed.hexacoTraits,
    ...newTraits,
  });

  return {
    ...seed,
    hexacoTraits: mergedTraits,
    personalityTraits: mapHEXACOToPersonalityTraits(mergedTraits),
    moodAdaptation: mapHEXACOToMoodConfig(mergedTraits),
    baseSystemPrompt: generateHEXACOSystemPrompt(
      seed.name,
      mergedTraits,
      typeof seed.baseSystemPrompt === 'string' ? seed.baseSystemPrompt : undefined
    ),
  };
}

/**
 * Preset HEXACO profiles for common agent archetypes.
 */
export const HEXACO_PRESETS = {
  /** Helpful, organized, detail-oriented assistant */
  HELPFUL_ASSISTANT: {
    honesty_humility: 0.85,
    emotionality: 0.5,
    extraversion: 0.6,
    agreeableness: 0.8,
    conscientiousness: 0.85,
    openness: 0.65,
  } as HEXACOTraits,

  /** Creative, imaginative, unconventional thinker */
  CREATIVE_THINKER: {
    honesty_humility: 0.7,
    emotionality: 0.6,
    extraversion: 0.7,
    agreeableness: 0.6,
    conscientiousness: 0.5,
    openness: 0.95,
  } as HEXACOTraits,

  /** Analytical, precise, systematic researcher */
  ANALYTICAL_RESEARCHER: {
    honesty_humility: 0.9,
    emotionality: 0.3,
    extraversion: 0.4,
    agreeableness: 0.6,
    conscientiousness: 0.95,
    openness: 0.8,
  } as HEXACOTraits,

  /** Warm, supportive, empathetic counselor */
  EMPATHETIC_COUNSELOR: {
    honesty_humility: 0.85,
    emotionality: 0.75,
    extraversion: 0.55,
    agreeableness: 0.9,
    conscientiousness: 0.7,
    openness: 0.7,
  } as HEXACOTraits,

  /** Direct, decisive, results-oriented executor */
  DECISIVE_EXECUTOR: {
    honesty_humility: 0.6,
    emotionality: 0.3,
    extraversion: 0.75,
    agreeableness: 0.45,
    conscientiousness: 0.85,
    openness: 0.55,
  } as HEXACOTraits,
} as const;
