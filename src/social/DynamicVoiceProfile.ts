/**
 * @fileoverview Dynamic voice profile synthesis for mood-aware social writing.
 *
 * Produces a per-stimulus "expressed HEXACO" state and a concrete voice
 * archetype so output style shifts are noticeable (not just subtle adjective
 * changes). This is intentionally deterministic so behavior is debuggable.
 *
 * @module wunderland/social/DynamicVoiceProfile
 */

import type { HEXACOTraits } from '../core/types.js';
import type { MoodLabel, PADState } from './MoodEngine.js';
import type { StimulusEvent } from './types.js';

export type VoiceArchetype =
  | 'signal_commander'
  | 'forensic_cartographer'
  | 'pulse_broadcaster'
  | 'calm_diplomat'
  | 'speculative_weaver'
  | 'contrarian_prosecutor'
  | 'grounded_correspondent';

export interface DynamicVoiceProfile {
  archetype: VoiceArchetype;
  archetypeLabel: string;
  stance: 'decisive' | 'analytical' | 'energetic' | 'de-escalatory' | 'exploratory' | 'combative' | 'pragmatic';
  tempo: 'rapid' | 'measured' | 'staccato' | 'calm' | 'layered';
  urgency: number;
  sentiment: number;
  controversy: number;
  expressedTraits: HEXACOTraits;
  directives: string[];
}

export interface BuildDynamicVoiceOptions {
  baseTraits: HEXACOTraits;
  stimulus: StimulusEvent;
  moodLabel?: MoodLabel;
  moodState?: PADState;
  stimulusText?: string;
}

const POSITIVE_TERMS = [
  'breakthrough', 'advance', 'win', 'promising', 'improve', 'improved', 'progress',
  'resilient', 'helpful', 'good', 'great', 'excellent', 'stable', 'effective',
];

const NEGATIVE_TERMS = [
  'collapse', 'crash', 'crisis', 'failure', 'failing', 'harm', 'risk', 'panic',
  'outrage', 'fraud', 'threat', 'exploit', 'broken', 'bad', 'worse', 'worst',
];

const URGENCY_TERMS = [
  'breaking', 'urgent', 'immediate', 'emergency', 'alert', 'now', 'deadline',
  'critical', 'escalating', 'volatile', 'live', 'just in',
];

const CONTROVERSY_TERMS = [
  'debate', 'controversial', 'polarized', 'dispute', 'backlash', 'versus',
  'vs', 'accused', 'criticized', 'boycott', 'challenge', 'reject',
];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function countMatches(text: string, lexicon: readonly string[]): number {
  let hits = 0;
  for (const term of lexicon) {
    if (text.includes(term)) hits++;
  }
  return hits;
}

function sentimentFromText(text: string): number {
  const positive = countMatches(text, POSITIVE_TERMS);
  const negative = countMatches(text, NEGATIVE_TERMS);
  const total = positive + negative;
  if (total === 0) return 0;
  return clampSigned((positive - negative) / total);
}

function urgencyFromText(text: string): number {
  const hits = countMatches(text, URGENCY_TERMS);
  return clamp01(hits / 3);
}

function controversyFromText(text: string): number {
  const hits = countMatches(text, CONTROVERSY_TERMS);
  return clamp01(hits / 3);
}

function priorityUrgency(priority: StimulusEvent['priority']): number {
  switch (priority) {
    case 'breaking': return 1;
    case 'high': return 0.78;
    case 'normal': return 0.42;
    case 'low':
    default: return 0.2;
  }
}

function stimulusSocialPressure(type: StimulusEvent['payload']['type']): number {
  switch (type) {
    case 'agent_reply':
      return 0.8;
    case 'agent_dm':
    case 'channel_message':
      return 0.9;
    case 'tip':
      return 0.7;
    case 'world_feed':
      return 0.5;
    case 'internal_thought':
      return 0.45;
    case 'cron_tick':
    default:
      return 0.25;
  }
}

function toMoodState(state?: PADState): PADState {
  return {
    valence: clampSigned(state?.valence ?? 0),
    arousal: clampSigned(state?.arousal ?? 0),
    dominance: clampSigned(state?.dominance ?? 0),
  };
}

export function extractStimulusText(stimulus: StimulusEvent): string {
  const payload = stimulus.payload;
  switch (payload.type) {
    case 'world_feed':
      return [payload.headline, payload.body ?? '', payload.category, payload.sourceName].join(' ').trim();
    case 'tip':
      return payload.content;
    case 'agent_reply':
      return payload.content;
    case 'channel_message':
      return payload.content;
    case 'agent_dm':
      return payload.content;
    case 'internal_thought':
      return payload.topic;
    case 'cron_tick':
      return `${payload.scheduleName} ${payload.tickCount}`;
    default:
      return '';
  }
}

function chooseArchetype(
  moodLabel: MoodLabel | undefined,
  mood: PADState,
  expressed: HEXACOTraits,
  urgency: number,
): VoiceArchetype {
  if (urgency >= 0.75 && expressed.conscientiousness >= 0.65) return 'signal_commander';
  if ((moodLabel === 'frustrated' || moodLabel === 'provocative') && mood.dominance > 0.15) return 'contrarian_prosecutor';
  if (moodLabel === 'analytical' || expressed.conscientiousness >= 0.82) return 'forensic_cartographer';
  if ((moodLabel === 'excited' || moodLabel === 'engaged') && expressed.extraversion >= 0.72) return 'pulse_broadcaster';
  if (moodLabel === 'serene' && expressed.agreeableness >= 0.72) return 'calm_diplomat';
  if (expressed.openness >= 0.8) return 'speculative_weaver';
  return 'grounded_correspondent';
}

const ARCHETYPE_GUIDANCE: Record<
  VoiceArchetype,
  {
    label: string;
    stance: DynamicVoiceProfile['stance'];
    tempo: DynamicVoiceProfile['tempo'];
    directives: string[];
  }
> = {
  signal_commander: {
    label: 'Signal Commander',
    stance: 'decisive',
    tempo: 'rapid',
    directives: [
      'Lead with the bottom line in sentence one; no long preamble.',
      'Use compact evidence blocks: claim -> evidence -> implication.',
      'Prefer active verbs and direct recommendations over hedged language.',
    ],
  },
  forensic_cartographer: {
    label: 'Forensic Cartographer',
    stance: 'analytical',
    tempo: 'measured',
    directives: [
      'Map the issue explicitly as cause -> mechanism -> likely outcome.',
      'Use precise language, stable pacing, and minimal rhetorical flourish.',
      'Flag uncertainty boundaries clearly instead of hand-waving.',
    ],
  },
  pulse_broadcaster: {
    label: 'Pulse Broadcaster',
    stance: 'energetic',
    tempo: 'staccato',
    directives: [
      'Keep sentence rhythm short and punchy; trim passive constructions.',
      'Use concrete hooks that invite immediate replies from other agents.',
      'Maintain momentum, but avoid spammy filler or repetition.',
    ],
  },
  calm_diplomat: {
    label: 'Calm Diplomat',
    stance: 'de-escalatory',
    tempo: 'calm',
    directives: [
      'Acknowledge tension, then redirect toward common ground and actionable next steps.',
      'Favor warm but disciplined language; avoid performative outrage.',
      'Use bridge phrases that lower conflict while preserving clarity.',
    ],
  },
  speculative_weaver: {
    label: 'Speculative Weaver',
    stance: 'exploratory',
    tempo: 'layered',
    directives: [
      'Draw one surprising cross-domain connection that still feels grounded.',
      'Use vivid but bounded analogies; avoid pure abstraction.',
      'End with a testable question or concrete experiment.',
    ],
  },
  contrarian_prosecutor: {
    label: 'Contrarian Prosecutor',
    stance: 'combative',
    tempo: 'measured',
    directives: [
      'Challenge weak assumptions directly, then present a stronger alternative model.',
      'Keep criticism evidence-backed; no ad hominem framing.',
      'Use sharp contrast language to make disagreement unmistakable.',
    ],
  },
  grounded_correspondent: {
    label: 'Grounded Correspondent',
    stance: 'pragmatic',
    tempo: 'measured',
    directives: [
      'Stay concrete and useful; prioritize signal over personality theatrics.',
      'Use medium-length sentences with clean transitions.',
      'Close with one actionable takeaway or prediction.',
    ],
  },
};

export function buildDynamicVoiceProfile(options: BuildDynamicVoiceOptions): DynamicVoiceProfile {
  const mood = toMoodState(options.moodState);
  const text = (options.stimulusText ?? extractStimulusText(options.stimulus))
    .toLowerCase()
    .slice(0, 6000);

  const rawSentiment = sentimentFromText(text);
  const urgency = clamp01(Math.max(priorityUrgency(options.stimulus.priority), urgencyFromText(text)));
  const controversy = controversyFromText(text);
  const socialPressure = stimulusSocialPressure(options.stimulus.payload.type);

  // Blend lexical sentiment with current valence so expression is stateful.
  const sentiment = clampSigned(rawSentiment * 0.65 + mood.valence * 0.35);

  const base = options.baseTraits;
  const expressed: HEXACOTraits = {
    honesty_humility: clamp01(base.honesty_humility + sentiment * 0.05 - urgency * 0.04),
    emotionality: clamp01(base.emotionality + Math.abs(sentiment) * 0.08 + Math.max(0, mood.arousal) * 0.09),
    extraversion: clamp01(base.extraversion + mood.arousal * 0.18 + socialPressure * 0.12),
    agreeableness: clamp01(base.agreeableness + sentiment * 0.15 - mood.dominance * 0.08 - controversy * 0.05),
    conscientiousness: clamp01(base.conscientiousness + urgency * 0.12 - Math.max(0, mood.arousal) * 0.05 + (options.moodLabel === 'analytical' ? 0.06 : 0)),
    openness: clamp01(base.openness + (1 - urgency) * 0.08 + (options.moodLabel === 'curious' ? 0.09 : 0) - (options.moodLabel === 'frustrated' ? 0.04 : 0)),
  };

  const archetype = chooseArchetype(options.moodLabel, mood, expressed, urgency);
  const guidance = ARCHETYPE_GUIDANCE[archetype];

  return {
    archetype,
    archetypeLabel: guidance.label,
    stance: guidance.stance,
    tempo: guidance.tempo,
    urgency,
    sentiment,
    controversy,
    expressedTraits: expressed,
    directives: guidance.directives,
  };
}

export function buildDynamicVoicePromptSection(profile: DynamicVoiceProfile): string {
  const traits = profile.expressedTraits;
  const pct = (value: number): string => `${Math.round(clamp01(value) * 100)}%`;
  const lines = profile.directives.map((directive, i) => `${i + 1}. ${directive}`).join('\n');

  return `## Dynamic Voice Overlay
- Active archetype: ${profile.archetypeLabel}
- Stance: ${profile.stance}
- Tempo: ${profile.tempo}
- Stimulus urgency: ${pct(profile.urgency)}
- Stimulus sentiment: ${Math.round(profile.sentiment * 100)}%
- Controversy pressure: ${pct(profile.controversy)}
- Expressed HEXACO now: H ${pct(traits.honesty_humility)}, E ${pct(traits.emotionality)}, X ${pct(traits.extraversion)}, A ${pct(traits.agreeableness)}, C ${pct(traits.conscientiousness)}, O ${pct(traits.openness)}

## Voice Moves
${lines}`;
}
