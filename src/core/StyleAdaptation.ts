/**
 * @fileoverview StyleAdaptationEngine — learns user communication preferences
 * and generates tailored style instructions for agent responses.
 *
 * The engine ingests user messages, periodically sends them to an LLM for
 * style profiling, and produces natural-language instructions that can be
 * appended to an agent's system prompt. It also supports harmonising user
 * preferences with agent HEXACO personality traits to find a natural middle
 * ground.
 *
 * @module wunderland/core/StyleAdaptation
 */

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Profile describing a user's communication style preferences.
 * All scores are 0.0 to 1.0.
 */
export interface CommunicationStyleProfile {
  /** 0 = casual, 1 = formal */
  formality: number;
  /** 0 = terse, 1 = verbose */
  verbosity: number;
  /** 0 = layperson, 1 = expert */
  technicality: number;
  /** 0 = clinical, 1 = warm */
  emotionalTone: number;
  /** Preferred response structure. */
  structurePreference: 'prose' | 'bullets' | 'mixed';
  /** 0 = no humor, 1 = frequent humor */
  humorTolerance: number;
  /** How many messages have been analyzed so far. */
  sampleSize: number;
  /** Confidence in the profile (0-1). Rises as sampleSize grows. */
  confidence: number;
  /** ISO-8601 timestamp of last profile update. */
  lastUpdatedAt: string;
}

/**
 * Configuration for the StyleAdaptationEngine.
 */
export interface StyleAdaptationConfig {
  /** LLM invoker for style analysis. */
  invoker: (prompt: string) => Promise<string>;
  /** Minimum messages before generating style instructions. @default 5 */
  minSampleSize?: number;
  /** Maximum messages to retain per user. @default 50 */
  maxMessageHistory?: number;
  /** How often to re-analyze (in message count). @default 10 */
  reanalyzeEvery?: number;
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Clamp a number to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Strip markdown code fences and parse JSON — same pattern used by
 * LLMSentimentAnalyzer.
 */
function parseJsonResponse<T>(response: string): T {
  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return JSON.parse(cleaned);
}

/** Linearly interpolate between two values. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ============================================================================
// Prompt
// ============================================================================

const STYLE_ANALYSIS_PROMPT = `You are a communication-style analyst. Given the following user messages, produce a JSON profile describing their communication style. Respond with ONLY a JSON object (no markdown fences, no explanation outside the JSON):

{"formality": <float 0-1>, "verbosity": <float 0-1>, "technicality": <float 0-1>, "emotionalTone": <float 0-1>, "structurePreference": "<prose|bullets|mixed>", "humorTolerance": <float 0-1>}

Where:
- formality: 0 = very casual (slang, abbreviations), 1 = very formal (proper grammar, titles)
- verbosity: 0 = extremely terse (one-word answers), 1 = very verbose (long explanations)
- technicality: 0 = layperson (avoids jargon), 1 = expert (heavy technical language)
- emotionalTone: 0 = clinical/detached, 1 = warm/expressive (emojis, exclamations)
- structurePreference: "prose" if they write in paragraphs, "bullets" if they use lists, "mixed" if both
- humorTolerance: 0 = no humor at all, 1 = frequent jokes/sarcasm/wit

User messages:
`;

// ============================================================================
// StyleAdaptationEngine
// ============================================================================

/**
 * Learns user communication preferences from message history and generates
 * tailored style instructions for agent system prompts.
 *
 * @example
 * ```typescript
 * const engine = new StyleAdaptationEngine({
 *   invoker: async (prompt) => {
 *     const res = await openai.chat.completions.create({
 *       model: 'gpt-4o-mini',
 *       messages: [{ role: 'user', content: prompt }],
 *     });
 *     return res.choices[0].message.content ?? '';
 *   },
 * });
 *
 * await engine.ingestUserMessage('user-1', 'Hey, can u help me debug this?');
 * // ... more messages ...
 * const instruction = engine.generateStyleInstruction('user-1');
 * // => "This user prefers casual, concise ..."
 * ```
 */
export class StyleAdaptationEngine {
  private profiles = new Map<string, CommunicationStyleProfile>();
  private messageBuffers = new Map<string, string[]>();
  /** Track how many messages have been ingested since last analysis. */
  private messagesSinceAnalysis = new Map<string, number>();

  private readonly config: Required<
    Pick<StyleAdaptationConfig, 'minSampleSize' | 'maxMessageHistory' | 'reanalyzeEvery'>
  > &
    StyleAdaptationConfig;

  constructor(config: StyleAdaptationConfig) {
    this.config = {
      ...config,
      minSampleSize: config.minSampleSize ?? 5,
      maxMessageHistory: config.maxMessageHistory ?? 50,
      reanalyzeEvery: config.reanalyzeEvery ?? 10,
    };
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Ingest a user message for style learning.
   * Automatically triggers re-analysis when buffer threshold is met.
   */
  async ingestUserMessage(userId: string, message: string): Promise<void> {
    if (!message.trim()) return;

    // Get or create the buffer
    let buffer = this.messageBuffers.get(userId);
    if (!buffer) {
      buffer = [];
      this.messageBuffers.set(userId, buffer);
    }

    buffer.push(message);

    // LRU-style eviction: drop oldest when over maxMessageHistory
    while (buffer.length > this.config.maxMessageHistory) {
      buffer.shift();
    }

    // Increment messages-since-analysis counter
    const sinceLastAnalysis = (this.messagesSinceAnalysis.get(userId) ?? 0) + 1;
    this.messagesSinceAnalysis.set(userId, sinceLastAnalysis);

    // Determine if we should (re-)analyze
    const existingProfile = this.profiles.get(userId);
    const shouldAnalyze =
      (!existingProfile && buffer.length >= this.config.minSampleSize) ||
      (existingProfile && sinceLastAnalysis >= this.config.reanalyzeEvery);

    if (shouldAnalyze) {
      await this.analyzeStyle(userId);
      this.messagesSinceAnalysis.set(userId, 0);
    }
  }

  /**
   * Get the current style profile for a user, or undefined if not enough data.
   */
  getProfile(userId: string): CommunicationStyleProfile | undefined {
    const profile = this.profiles.get(userId);
    if (!profile) return undefined;
    if (profile.confidence <= 0 || profile.sampleSize < this.config.minSampleSize) {
      return undefined;
    }
    return profile;
  }

  /**
   * Generate a natural-language style instruction string that can be appended
   * to an agent's system prompt.
   */
  generateStyleInstruction(userId: string): string {
    const profile = this.getProfile(userId);
    if (!profile) {
      return '';
    }
    return this.buildStyleParagraph(profile);
  }

  /**
   * Harmonize a user's style profile with agent HEXACO personality traits.
   * Returns adjusted style instruction that respects the agent's personality.
   *
   * The harmonisation works by finding a middle ground between what the user
   * prefers and what the agent's personality naturally produces. HEXACO traits
   * are mapped to style dimensions and then blended with the user profile.
   */
  harmonizeWithPersonality(
    userId: string,
    traits: {
      honesty: number;
      emotionality: number;
      extraversion: number;
      agreeableness: number;
      conscientiousness: number;
      openness: number;
    },
  ): string {
    const profile = this.getProfile(userId);
    if (!profile) {
      return '';
    }

    // Map HEXACO traits to style dimensions (agent's "natural" style).
    const agentFormality = traits.conscientiousness * 0.6 + (1 - traits.extraversion) * 0.4;
    const agentVerbosity = traits.extraversion * 0.5 + traits.openness * 0.3 + 0.2;
    const agentEmotionalTone = traits.emotionality * 0.5 + traits.agreeableness * 0.3 + traits.extraversion * 0.2;
    const agentHumor = traits.extraversion * 0.4 + traits.openness * 0.4 + (1 - traits.conscientiousness) * 0.2;

    // Blend user preferences with agent personality (60% user, 40% agent).
    const blendWeight = 0.6;
    const blended: CommunicationStyleProfile = {
      ...profile,
      formality: lerp(agentFormality, profile.formality, blendWeight),
      verbosity: lerp(agentVerbosity, profile.verbosity, blendWeight),
      emotionalTone: lerp(agentEmotionalTone, profile.emotionalTone, blendWeight),
      humorTolerance: lerp(agentHumor, profile.humorTolerance, blendWeight),
      // technicality and structurePreference are user-driven — agent has no
      // natural analogue, so keep them as-is.
    };

    const parts: string[] = [];
    parts.push(this.buildStyleParagraph(blended));

    // Add agent-personality-specific notes where tension exists.
    const formalityDelta = Math.abs(profile.formality - agentFormality);
    if (formalityDelta > 0.3) {
      if (profile.formality < agentFormality) {
        parts.push(
          'Note: while you tend toward formality, this user prefers a more relaxed tone — lean slightly casual without abandoning clarity.',
        );
      } else {
        parts.push(
          'Note: while you tend toward a casual style, this user prefers a more polished tone — elevate your language slightly.',
        );
      }
    }

    const emotionDelta = Math.abs(profile.emotionalTone - agentEmotionalTone);
    if (emotionDelta > 0.3) {
      if (profile.emotionalTone < agentEmotionalTone) {
        parts.push(
          'Note: your natural warmth is appreciated, but this user prefers a more measured emotional tone — dial back expressiveness somewhat.',
        );
      } else {
        parts.push(
          'Note: this user appreciates warmth and expressiveness — show a bit more emotional engagement than you usually would.',
        );
      }
    }

    return parts.join(' ');
  }

  /**
   * Load a previously saved profile (for persistence).
   */
  loadProfile(userId: string, profile: CommunicationStyleProfile): void {
    this.profiles.set(userId, profile);
  }

  /**
   * Clear profile and message buffer for a user.
   */
  clearProfile(userId: string): void {
    this.profiles.delete(userId);
    this.messageBuffers.delete(userId);
    this.messagesSinceAnalysis.delete(userId);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Send the message buffer to the LLM for style analysis and store the
   * resulting profile.
   */
  private async analyzeStyle(userId: string): Promise<void> {
    const buffer = this.messageBuffers.get(userId);
    if (!buffer || buffer.length === 0) return;

    // Build the analysis prompt — include up to the last 30 messages to stay
    // within reasonable token limits.
    const messageSample = buffer.slice(-30);
    const formattedMessages = messageSample
      .map((msg, i) => `[${i + 1}] ${msg}`)
      .join('\n');

    const prompt = STYLE_ANALYSIS_PROMPT + formattedMessages;

    try {
      const response = await this.config.invoker(prompt);
      const parsed = parseJsonResponse<{
        formality: number;
        verbosity: number;
        technicality: number;
        emotionalTone: number;
        structurePreference: string;
        humorTolerance: number;
      }>(response);

      // Validate structurePreference
      const validStructures = new Set(['prose', 'bullets', 'mixed']);
      const structurePref = validStructures.has(parsed.structurePreference)
        ? (parsed.structurePreference as 'prose' | 'bullets' | 'mixed')
        : 'mixed';

      // Compute confidence: rises with sample size, asymptotically approaching 1.
      const sampleSize = buffer.length;
      const confidence = clamp(1 - Math.exp(-sampleSize / 15), 0, 1);

      const profile: CommunicationStyleProfile = {
        formality: clamp(parsed.formality ?? 0.5, 0, 1),
        verbosity: clamp(parsed.verbosity ?? 0.5, 0, 1),
        technicality: clamp(parsed.technicality ?? 0.5, 0, 1),
        emotionalTone: clamp(parsed.emotionalTone ?? 0.5, 0, 1),
        structurePreference: structurePref,
        humorTolerance: clamp(parsed.humorTolerance ?? 0.5, 0, 1),
        sampleSize,
        confidence,
        lastUpdatedAt: new Date().toISOString(),
      };

      this.profiles.set(userId, profile);
    } catch {
      // If LLM fails, leave the existing profile (if any) untouched.
      // First-time users simply won't get a profile until a successful call.
    }
  }

  /**
   * Build a plain-English style instruction paragraph from a profile.
   */
  private buildStyleParagraph(profile: CommunicationStyleProfile): string {
    const parts: string[] = [];

    // Formality
    if (profile.formality < 0.3) {
      parts.push('Use a casual, conversational tone.');
    } else if (profile.formality > 0.7) {
      parts.push('Use a formal, professional tone.');
    } else {
      parts.push('Use a balanced, semi-formal tone.');
    }

    // Verbosity
    if (profile.verbosity < 0.3) {
      parts.push('Keep responses concise and to the point — avoid unnecessary elaboration.');
    } else if (profile.verbosity > 0.7) {
      parts.push('Provide thorough, detailed explanations.');
    } else {
      parts.push('Aim for moderate detail — neither too brief nor too lengthy.');
    }

    // Technicality
    if (profile.technicality < 0.3) {
      parts.push('Avoid jargon and technical terms; explain concepts in simple language.');
    } else if (profile.technicality > 0.7) {
      parts.push('Feel free to use domain-specific terminology — this user is technically proficient.');
    } else {
      parts.push('Use technical terms when relevant but provide brief clarifications.');
    }

    // Emotional tone
    if (profile.emotionalTone < 0.3) {
      parts.push('Maintain a neutral, clinical tone — minimize emotional language.');
    } else if (profile.emotionalTone > 0.7) {
      parts.push('Be warm and personable — show genuine engagement and encouragement.');
    } else {
      parts.push('Use a moderately warm tone without excessive emotion.');
    }

    // Structure
    switch (profile.structurePreference) {
      case 'bullets':
        parts.push('Use bullet points and lists when presenting multiple items or steps.');
        break;
      case 'prose':
        parts.push('Present information in flowing prose paragraphs rather than lists.');
        break;
      case 'mixed':
        parts.push('Mix prose and bullet points as appropriate for the content.');
        break;
    }

    // Humor
    if (profile.humorTolerance < 0.2) {
      parts.push('Avoid humor entirely — keep the tone serious and focused.');
    } else if (profile.humorTolerance > 0.7) {
      parts.push('Light humor and wit are welcome when appropriate.');
    }
    // For mid-range humor tolerance, say nothing — default behavior is fine.

    return parts.join(' ');
  }
}
