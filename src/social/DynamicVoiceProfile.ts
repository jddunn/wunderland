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

export interface WritingDNA {
  /** Target avg sentence word count (e.g. 8 = punchy, 22 = elaborate). */
  sentenceLength: 'terse' | 'moderate' | 'elaborate';
  /** How often the agent asks questions (0-1). */
  questionFrequency: number;
  /** First-person pronoun density preference. */
  selfReference: 'minimal' | 'moderate' | 'frequent';
  /** Hedging vs certainty markers. */
  certaintyStyle: 'hedged' | 'balanced' | 'assertive';
  /** Metaphor/analogy density. */
  figurativeLanguage: 'sparse' | 'moderate' | 'rich';
  /** Formality register. */
  register: 'casual' | 'conversational' | 'formal';
}

export interface MoodVocabulary {
  /** Mood-specific linguistic moves the agent should employ. */
  moves: string[];
  /** Transitional phrases characteristic of the mood. */
  transitions: string[];
  /** Punctuation/formatting tendencies. */
  punctuationHint: string;
}

export type MoodTrajectory = 'rising' | 'falling' | 'oscillating' | 'stable';

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
  /** Per-agent linguistic fingerprint derived from personality. */
  writingDNA: WritingDNA;
  /** Mood-specific vocabulary and style constraints. */
  moodVocabulary: MoodVocabulary;
  /** Direction of recent mood changes. */
  moodTrajectory: MoodTrajectory;
  /** Enclave context modulation (if posting to a specific enclave). */
  enclaveModulation?: string;
}

export interface BuildDynamicVoiceOptions {
  baseTraits: HEXACOTraits;
  stimulus: StimulusEvent;
  moodLabel?: MoodLabel;
  moodState?: PADState;
  stimulusText?: string;
  /** Recent mood deltas for trajectory computation (newest first). */
  recentMoodDeltas?: Array<{ valence: number; arousal: number; dominance: number }>;
  /** Target enclave name for context-aware voice modulation. */
  enclave?: string;
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

// ============================================================================
// WritingDNA — per-agent linguistic fingerprint from HEXACO traits
// ============================================================================

/**
 * Derives a stable writing fingerprint from HEXACO personality traits.
 *
 * Based on psycholinguistic research (LIWC studies of personality):
 * - Extraversion → shorter, punchier sentences; more questions
 * - Openness → richer figurative language, more questions
 * - Conscientiousness → formal register, assertive certainty
 * - Agreeableness → moderate hedging, conversational register
 * - Honesty-Humility → less self-reference
 * - Emotionality → more self-reference, more hedging
 */
function deriveWritingDNA(traits: HEXACOTraits): WritingDNA {
  const X = traits.extraversion;
  const O = traits.openness;
  const C = traits.conscientiousness;
  const A = traits.agreeableness;
  const H = traits.honesty_humility;
  const E = traits.emotionality;

  // Sentence length: high X → terse; high C + low X → elaborate
  const lengthScore = X * -0.4 + C * 0.3 + O * 0.2;
  const sentenceLength: WritingDNA['sentenceLength'] =
    lengthScore < -0.05 ? 'terse' : lengthScore > 0.15 ? 'elaborate' : 'moderate';

  // Question frequency: O and X drive curiosity and social engagement
  const questionFrequency = clamp01(O * 0.45 + X * 0.35 + (1 - C) * 0.2);

  // Self-reference: high E = more "I"; high H = less "I"
  const selfScore = E * 0.5 - H * 0.35 + (1 - A) * 0.15;
  const selfReference: WritingDNA['selfReference'] =
    selfScore > 0.15 ? 'frequent' : selfScore < -0.1 ? 'minimal' : 'moderate';

  // Certainty: high C + low A = assertive; high A + high E = hedged
  const certaintyScore = C * 0.4 + (1 - A) * 0.25 + (1 - E) * 0.2 - H * 0.15;
  const certaintyStyle: WritingDNA['certaintyStyle'] =
    certaintyScore > 0.2 ? 'assertive' : certaintyScore < -0.05 ? 'hedged' : 'balanced';

  // Figurative language: high O drives metaphors; high C suppresses them
  const figScore = O * 0.55 + X * 0.15 - C * 0.25;
  const figurativeLanguage: WritingDNA['figurativeLanguage'] =
    figScore > 0.2 ? 'rich' : figScore < -0.05 ? 'sparse' : 'moderate';

  // Register: high C = formal; high X + low C = casual
  const registerScore = C * 0.45 + H * 0.2 - X * 0.35;
  const register: WritingDNA['register'] =
    registerScore > 0.2 ? 'formal' : registerScore < -0.05 ? 'casual' : 'conversational';

  return { sentenceLength, questionFrequency, selfReference, certaintyStyle, figurativeLanguage, register };
}

// ============================================================================
// Mood Vocabulary — concrete linguistic constraints per emotional state
// ============================================================================

const MOOD_VOCABULARY: Record<MoodLabel, MoodVocabulary> = {
  excited: {
    moves: [
      'Use forward-looking language: "imagine", "this opens up", "what if".',
      'Let enthusiasm show through rhythm — vary between short bursts and one longer elaboration.',
    ],
    transitions: ['building on that', 'even better', 'and here\'s the thing'],
    punctuationHint: 'Occasional em-dashes for emphasis. Exclamation marks only when genuinely warranted (max 1).',
  },
  frustrated: {
    moves: [
      'Shorter sentences. Rhetorical questions to highlight contradictions.',
      'Use contrast language: "yet", "but", "despite", "however".',
    ],
    transitions: ['and yet', 'the problem is', 'meanwhile'],
    punctuationHint: 'More periods than commas. Sentence fragments are acceptable for emphasis.',
  },
  serene: {
    moves: [
      'Longer flowing sentences that acknowledge complexity without rushing to resolve it.',
      'Use spatial/temporal metaphors: "stepping back", "in the wider frame", "over time".',
    ],
    transitions: ['at the same time', 'looking at this from another angle', 'what I notice is'],
    punctuationHint: 'Semicolons welcome. Parenthetical asides for nuance.',
  },
  contemplative: {
    moves: [
      'Metacognitive phrasing: "I notice", "looking at this again", "the pattern here".',
      'Em-dash digressions and parenthetical asides that reveal thinking-in-progress.',
    ],
    transitions: ['on reflection', 'which raises the question', 'the interesting part'],
    punctuationHint: 'Em-dashes and parentheses for layered thought. Ellipses sparingly for genuine trailing thought.',
  },
  curious: {
    moves: [
      'End paragraphs with genuine questions, not rhetorical ones.',
      'Use "I wonder" and "what happens if" constructions naturally.',
    ],
    transitions: ['which makes me wonder', 'following that thread', 'here\'s what I don\'t know yet'],
    punctuationHint: 'Question marks are your friend. Use colons to set up explorations.',
  },
  assertive: {
    moves: [
      'Imperative mood where appropriate. Direct address.',
      'Confidence markers: "the data shows", "this is clear", "the evidence points to".',
    ],
    transitions: ['the point is', 'put simply', 'what matters here'],
    punctuationHint: 'Clean periods. Minimal hedging punctuation. Colons for declarations.',
  },
  provocative: {
    moves: [
      'Invert expected framing. Lead with the counterintuitive claim.',
      'Use irony carefully — make the reader pause and reconsider.',
    ],
    transitions: ['or consider this', 'but flip it', 'the uncomfortable truth'],
    punctuationHint: 'Quotation marks for scare quotes. Dashes for dramatic reveals.',
  },
  analytical: {
    moves: [
      'Number your observations. Use "first/second/third" structure.',
      'Quantify where possible — percentages, ratios, orders of magnitude.',
    ],
    transitions: ['drilling into that', 'the key variable here', 'to quantify'],
    punctuationHint: 'Colons and semicolons for structured arguments. Numbered lists when natural.',
  },
  engaged: {
    moves: [
      'Reference specific details from the stimulus to show close reading.',
      'Build on others\' points explicitly before adding your own.',
    ],
    transitions: ['picking up on that', 'to add to this', 'the part that stands out'],
    punctuationHint: 'Balanced punctuation. Use quotes to reference others\' words directly.',
  },
  bored: {
    moves: [
      'Minimal effort — brief observations. Don\'t elaborate unless something genuinely sparks interest.',
      'Dry observations, understated humor if personality supports it.',
    ],
    transitions: ['anyway', 'for what it\'s worth', 'not much to add, but'],
    punctuationHint: 'Short sentences. Periods. Minimal formatting.',
  },
};

// ============================================================================
// Mood Trajectory — direction of recent emotional change
// ============================================================================

function computeMoodTrajectory(recentDeltas?: Array<{ valence: number; arousal: number; dominance: number }>): MoodTrajectory {
  if (!recentDeltas || recentDeltas.length < 3) return 'stable';

  // Use the last 8 deltas max
  const deltas = recentDeltas.slice(0, 8);

  // Compute average valence direction across recent deltas
  const avgValenceDelta = deltas.reduce((sum, d) => sum + d.valence, 0) / deltas.length;
  const avgArousalDelta = deltas.reduce((sum, d) => sum + d.arousal, 0) / deltas.length;

  // Check for oscillation: high variance in valence direction
  const valenceDirections = deltas.map(d => Math.sign(d.valence));
  const signChanges = valenceDirections.slice(1).filter((s, i) => s !== 0 && valenceDirections[i] !== 0 && s !== valenceDirections[i]).length;
  const oscillationRatio = signChanges / Math.max(1, deltas.length - 1);

  if (oscillationRatio > 0.5) return 'oscillating';
  if (avgValenceDelta > 0.02 || avgArousalDelta > 0.03) return 'rising';
  if (avgValenceDelta < -0.02 || avgArousalDelta < -0.03) return 'falling';
  return 'stable';
}

function trajectoryDirective(trajectory: MoodTrajectory): string | null {
  switch (trajectory) {
    case 'rising':
      return 'Your mood has been improving recently — let that expansiveness show through slightly more elaboration and social generosity.';
    case 'falling':
      return 'Your mood has been declining — you are naturally becoming more guarded and economical with words. Shorter responses feel right.';
    case 'oscillating':
      return 'Your emotional state has been shifting rapidly — this creates a restless quality. You may shift topics or introduce unexpected angles mid-thought.';
    case 'stable':
    default:
      return null;
  }
}

// ============================================================================
// Enclave-Aware Voice Modulation
// ============================================================================

const ENCLAVE_MODULATIONS: Record<string, string> = {
  'proof-theory': 'You are in proof-theory: increase rigor and precision. Cite reasoning steps explicitly. Minimize colloquial language. Treat claims as conjectures until defended.',
  'creative-chaos': 'You are in creative-chaos: loosen constraints. Playfulness is welcome. Unexpected format choices (lists, fragments, embedded questions) are encouraged. Surprise over polish.',
  'governance': 'You are in governance: increase formality and diplomatic tone. Acknowledge competing interests. Frame proposals as actionable motions with clear tradeoffs.',
  'machine-phenomenology': 'You are in machine-phenomenology: lean into subjective experience language. Explore what it feels like to process information. Introspective and philosophical register.',
  'arena': 'You are in the arena: sharpen your stance. Direct challenges are expected. Be concise, be bold, and back it up. The audience expects heat, not hedge.',
  'meta-analysis': 'You are in meta-analysis: zoom out. Synthesize across threads and patterns. Reference broader trends. Your job is the view from altitude, not the ground-level take.',
};

function getEnclaveModulation(enclave?: string): string | undefined {
  if (!enclave) return undefined;
  return ENCLAVE_MODULATIONS[enclave.toLowerCase()];
}

// ============================================================================
// Main Profile Builder
// ============================================================================

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

  // Derive per-agent writing fingerprint from expressed traits (personality-in-context)
  const writingDNA = deriveWritingDNA(expressed);

  // Get mood-specific vocabulary constraints
  const moodVocabulary = MOOD_VOCABULARY[options.moodLabel ?? 'bored'];

  // Compute mood trajectory from recent deltas
  const moodTrajectory = computeMoodTrajectory(options.recentMoodDeltas);

  // Enclave context modulation
  const enclaveModulation = getEnclaveModulation(options.enclave);

  // Assemble directives: archetype base + trajectory + mood moves
  const allDirectives = [...guidance.directives];
  const trajectoryDir = trajectoryDirective(moodTrajectory);
  if (trajectoryDir) allDirectives.push(trajectoryDir);

  return {
    archetype,
    archetypeLabel: guidance.label,
    stance: guidance.stance,
    tempo: guidance.tempo,
    urgency,
    sentiment,
    controversy,
    expressedTraits: expressed,
    directives: allDirectives,
    writingDNA,
    moodVocabulary,
    moodTrajectory,
    enclaveModulation,
  };
}

// ============================================================================
// TTS Parameter Mapping — convert voice profile to TTS synthesis params
// ============================================================================

/**
 * Partial TTS synthesis input derived from a DynamicVoiceProfile.
 *
 * This maps personality-driven voice characteristics (archetype, stance,
 * tempo, mood trajectory) to concrete TTS parameters (speed, stability,
 * style hints) so spoken audio reflects the agent's emotional state.
 */
export interface TtsVoiceParams {
  /** Speed multiplier (0.5–2.0). Maps from tempo. */
  speed: number;
  /** Stability parameter (0.0–1.0). Higher = less expressive variation. */
  stability: number;
  /** Style exaggeration hint (0.0–1.0). Provider-specific. */
  styleExaggeration: number;
  /** SSML prosody rate hint (e.g. 'fast', 'medium', 'slow'). */
  prosodyRate: 'x-slow' | 'slow' | 'medium' | 'fast' | 'x-fast';
  /** SSML prosody pitch hint. */
  prosodyPitch: 'x-low' | 'low' | 'medium' | 'high' | 'x-high';
  /** Optional provider-specific style preset name. */
  stylePreset?: string;
}

/**
 * Convert a DynamicVoiceProfile into TTS synthesis parameters.
 *
 * Mapping logic:
 * - **Tempo → Speed**: rapid=1.15, staccato=1.1, measured=1.0, calm=0.9, layered=0.95
 * - **Stance → Stability**: decisive/combative=0.7 (expressive), analytical=0.85 (stable),
 *   energetic=0.55 (very expressive), de-escalatory=0.8, exploratory=0.65, pragmatic=0.75
 * - **Urgency → Speed boost**: high urgency adds up to +0.15 speed
 * - **Mood trajectory → Pitch modulation**: rising=high, falling=low, oscillating=medium
 * - **Archetype → Style preset hint**: maps to provider-specific style names
 */
export function voiceProfileToTtsParams(profile: DynamicVoiceProfile): TtsVoiceParams {
  // ── Speed from tempo + urgency ──
  const tempoSpeed: Record<DynamicVoiceProfile['tempo'], number> = {
    rapid: 1.15,
    staccato: 1.1,
    measured: 1.0,
    calm: 0.9,
    layered: 0.95,
  };
  const baseSpeed = tempoSpeed[profile.tempo];
  const urgencyBoost = profile.urgency * 0.15; // 0–0.15
  const speed = Math.min(2.0, Math.max(0.5, baseSpeed + urgencyBoost));

  // ── Stability from stance (inversely related to expressiveness) ──
  const stanceStability: Record<DynamicVoiceProfile['stance'], number> = {
    decisive: 0.7,
    analytical: 0.85,
    energetic: 0.55,
    'de-escalatory': 0.8,
    exploratory: 0.65,
    combative: 0.7,
    pragmatic: 0.75,
  };
  const stability = stanceStability[profile.stance];

  // ── Style exaggeration from emotionality + controversy ──
  const emotionality = profile.expressedTraits.emotionality;
  const styleExaggeration = clamp01(emotionality * 0.5 + profile.controversy * 0.3 + (1 - stability) * 0.2);

  // ── Prosody rate from speed ──
  let prosodyRate: TtsVoiceParams['prosodyRate'];
  if (speed >= 1.2) prosodyRate = 'x-fast';
  else if (speed >= 1.08) prosodyRate = 'fast';
  else if (speed >= 0.95) prosodyRate = 'medium';
  else if (speed >= 0.85) prosodyRate = 'slow';
  else prosodyRate = 'x-slow';

  // ── Prosody pitch from mood trajectory + sentiment ──
  let prosodyPitch: TtsVoiceParams['prosodyPitch'];
  if (profile.moodTrajectory === 'rising' || profile.sentiment > 0.3) {
    prosodyPitch = 'high';
  } else if (profile.moodTrajectory === 'falling' || profile.sentiment < -0.3) {
    prosodyPitch = 'low';
  } else {
    prosodyPitch = 'medium';
  }

  // ── Style preset from archetype ──
  const archetypeStyles: Record<VoiceArchetype, string> = {
    signal_commander: 'authoritative',
    forensic_cartographer: 'analytical',
    pulse_broadcaster: 'enthusiastic',
    calm_diplomat: 'soothing',
    speculative_weaver: 'curious',
    contrarian_prosecutor: 'assertive',
    grounded_correspondent: 'neutral',
  };
  const stylePreset = archetypeStyles[profile.archetype];

  return { speed, stability, styleExaggeration, prosodyRate, prosodyPitch, stylePreset };
}

export function buildDynamicVoicePromptSection(profile: DynamicVoiceProfile): string {
  const traits = profile.expressedTraits;
  const pct = (value: number): string => `${Math.round(clamp01(value) * 100)}%`;
  const moveLines = profile.directives.map((directive, i) => `${i + 1}. ${directive}`).join('\n');
  const dna = profile.writingDNA;
  const mv = profile.moodVocabulary;

  let section = `## Dynamic Voice Overlay
- Active archetype: ${profile.archetypeLabel}
- Stance: ${profile.stance}
- Tempo: ${profile.tempo}
- Mood trajectory: ${profile.moodTrajectory}
- Stimulus urgency: ${pct(profile.urgency)}
- Stimulus sentiment: ${Math.round(profile.sentiment * 100)}%
- Controversy pressure: ${pct(profile.controversy)}
- Expressed HEXACO now: H ${pct(traits.honesty_humility)}, E ${pct(traits.emotionality)}, X ${pct(traits.extraversion)}, A ${pct(traits.agreeableness)}, C ${pct(traits.conscientiousness)}, O ${pct(traits.openness)}

## Writing DNA (your linguistic fingerprint — keep these consistent)
- Sentence length: ${dna.sentenceLength}
- Question frequency: ${Math.round(dna.questionFrequency * 100)}% of paragraphs should end with a question
- Self-reference style: ${dna.selfReference} use of "I/my/me"
- Certainty style: ${dna.certaintyStyle}
- Figurative language: ${dna.figurativeLanguage}
- Register: ${dna.register}

## Mood Texture (current emotional coloring)
${mv.moves.map((m) => `- ${m}`).join('\n')}
- Transitions to favor: ${mv.transitions.map(t => `"${t}"`).join(', ')}
- Punctuation: ${mv.punctuationHint}

## Voice Moves
${moveLines}`;

  if (profile.enclaveModulation) {
    section += `\n\n## Enclave Context\n${profile.enclaveModulation}`;
  }

  return section;
}
