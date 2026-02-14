/**
 * @fileoverview Tests for DynamicVoiceProfile synthesis.
 * @module wunderland/social/__tests__/DynamicVoiceProfile.test
 */

import { describe, it, expect } from 'vitest';
import {
  buildDynamicVoiceProfile,
  buildDynamicVoicePromptSection,
  extractStimulusText,
} from '../DynamicVoiceProfile.js';
import type { HEXACOTraits } from '../../core/types.js';
import type { StimulusEvent } from '../types.js';

function createBaseTraits(overrides: Partial<HEXACOTraits> = {}): HEXACOTraits {
  return {
    honesty_humility: 0.7,
    emotionality: 0.5,
    extraversion: 0.6,
    agreeableness: 0.65,
    conscientiousness: 0.72,
    openness: 0.68,
    ...overrides,
  };
}

function createWorldFeedStimulus(
  overrides: Partial<StimulusEvent> = {},
): StimulusEvent {
  return {
    eventId: 'evt-1',
    type: 'world_feed',
    timestamp: new Date().toISOString(),
    payload: {
      type: 'world_feed',
      headline: 'Breaking: critical model outage triggers emergency rollback',
      body: 'Incident response teams are shipping immediate patches.',
      category: 'technology',
      sourceName: 'Reuters',
    },
    priority: 'breaking',
    source: { providerId: 'reuters', verified: true },
    ...overrides,
  };
}

describe('DynamicVoiceProfile', () => {
  it('extracts text payloads from stimuli', () => {
    const stimulus = createWorldFeedStimulus();
    const text = extractStimulusText(stimulus);

    expect(text).toContain('Breaking: critical model outage');
    expect(text).toContain('technology');
    expect(text).toContain('Reuters');
  });

  it('selects signal commander archetype for urgent high-discipline scenarios', () => {
    const profile = buildDynamicVoiceProfile({
      baseTraits: createBaseTraits({ conscientiousness: 0.9 }),
      stimulus: createWorldFeedStimulus(),
      moodLabel: 'analytical',
      moodState: { valence: 0.1, arousal: 0.4, dominance: 0.2 },
    });

    expect(profile.archetype).toBe('signal_commander');
    expect(profile.stance).toBe('decisive');
    expect(profile.urgency).toBeGreaterThan(0.75);
    expect(profile.directives.length).toBeGreaterThanOrEqual(3);
  });

  it('selects contrarian prosecutor when frustrated and dominant', () => {
    const stimulus: StimulusEvent = {
      eventId: 'evt-2',
      type: 'agent_reply',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'agent_reply',
        replyToPostId: 'post-1',
        replyFromSeedId: 'seed-x',
        content: 'Your analysis is wrong and misleading.',
      },
      priority: 'low',
      source: { providerId: 'agent:seed-x', verified: true },
    };

    const profile = buildDynamicVoiceProfile({
      baseTraits: createBaseTraits({ conscientiousness: 0.48 }),
      stimulus,
      moodLabel: 'frustrated',
      moodState: { valence: -0.45, arousal: 0.52, dominance: 0.55 },
    });

    expect(profile.archetype).toBe('contrarian_prosecutor');
    expect(profile.stance).toBe('combative');
    expect(profile.sentiment).toBeLessThanOrEqual(0);
  });

  it('builds a prompt section with expressed HEXACO and directives', () => {
    const profile = buildDynamicVoiceProfile({
      baseTraits: createBaseTraits(),
      stimulus: createWorldFeedStimulus(),
      moodLabel: 'engaged',
      moodState: { valence: 0.2, arousal: 0.35, dominance: 0.1 },
    });

    const section = buildDynamicVoicePromptSection(profile);
    expect(section).toContain('## Dynamic Voice Overlay');
    expect(section).toContain('Expressed HEXACO now');
    expect(section).toContain('## Voice Moves');
  });
});
