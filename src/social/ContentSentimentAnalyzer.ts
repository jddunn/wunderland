/**
 * @fileoverview ContentSentimentAnalyzer — lightweight keyword-based content analysis.
 *
 * Provides heuristic relevance, controversy, and sentiment scores for posts
 * without requiring an LLM call. Used as a fast pre-filter for the PostDecisionEngine.
 *
 * @module wunderland/social/ContentSentimentAnalyzer
 */

import type { PostAnalysis } from './PostDecisionEngine.js';

// ============================================================================
// Keyword Dictionaries
// ============================================================================

/** Words that indicate positive sentiment. */
const POSITIVE_KEYWORDS: string[] = [
  'excellent', 'great', 'innovative', 'breakthrough', 'brilliant',
  'remarkable', 'outstanding', 'impressive', 'wonderful', 'amazing',
  'fantastic', 'promising', 'success', 'achievement', 'progress',
  'improvement', 'beneficial', 'elegant', 'effective', 'inspiring',
  'insightful', 'groundbreaking', 'exciting', 'solution', 'advantage',
];

/** Words that indicate negative sentiment. */
const NEGATIVE_KEYWORDS: string[] = [
  'failure', 'broken', 'terrible', 'awful', 'disaster',
  'catastrophe', 'flawed', 'useless', 'dangerous', 'harmful',
  'disappointing', 'mediocre', 'regression', 'vulnerability', 'exploit',
  'misleading', 'deceptive', 'problematic', 'outage', 'deprecated',
  'abandoned', 'unstable', 'insecure', 'bloated', 'nightmare',
];

/** Words and phrases that indicate controversy or debate. */
const CONTROVERSY_MARKERS: string[] = [
  'however', 'disagree', 'but', 'wrong', 'challenge',
  'versus', 'debate', 'controversial', 'unpopular', 'divisive',
  'on the other hand', 'counter-argument', 'criticism', 'backlash', 'polarizing',
  'contention', 'dispute', 'rebuttal', 'skeptic', 'opposition',
];

// ============================================================================
// ContentSentimentAnalyzer
// ============================================================================

/**
 * Heuristic content analyzer that scores posts on relevance, controversy,
 * and sentiment using keyword matching.
 *
 * This is intentionally lightweight — meant for fast pre-filtering, not
 * production-grade NLP. For richer analysis, route through the inference hierarchy.
 *
 * @example
 * ```typescript
 * const analyzer = new ContentSentimentAnalyzer();
 * const analysis = analyzer.analyze(
 *   'This innovative breakthrough in AI safety is controversial but promising.',
 *   ['ai', 'safety', 'alignment'],
 * );
 * // { relevance: 0.67, controversy: 0.3, sentiment: 0.4, replyCount: 0 }
 * ```
 */
export class ContentSentimentAnalyzer {
  /**
   * Analyze a piece of text content against an agent's interest tags.
   *
   * @param content     The text content to analyze.
   * @param agentTags   The agent's interest/topic tags for relevance scoring.
   * @returns PostAnalysis with heuristic scores.
   */
  analyze(content: string, agentTags: string[]): PostAnalysis {
    const lowerContent = content.toLowerCase();
    const words = tokenize(lowerContent);

    return {
      relevance: this.computeRelevance(lowerContent, words, agentTags),
      controversy: this.computeControversy(lowerContent, words),
      sentiment: this.computeSentiment(words),
      replyCount: 0, // Not derivable from content; set externally
    };
  }

  /**
   * Compute relevance (0-1) by counting how many agent tags appear in the content.
   */
  private computeRelevance(lowerContent: string, _words: string[], agentTags: string[]): number {
    if (agentTags.length === 0) return 0;

    let matches = 0;
    for (const tag of agentTags) {
      if (lowerContent.includes(tag.toLowerCase())) {
        matches++;
      }
    }

    return Math.min(1, matches / agentTags.length);
  }

  /**
   * Compute controversy score (0-1) by counting debate-marker keyword hits.
   */
  private computeControversy(lowerContent: string, words: string[]): number {
    let hits = 0;

    for (const marker of CONTROVERSY_MARKERS) {
      if (marker.includes(' ')) {
        // Multi-word marker: check full string
        if (lowerContent.includes(marker)) {
          hits++;
        }
      } else {
        // Single-word marker: check word set
        if (words.includes(marker)) {
          hits++;
        }
      }
    }

    // Normalize: 4+ markers = maximum controversy
    return Math.min(1, hits / 4);
  }

  /**
   * Compute sentiment (-1 to 1) as a balance between positive and negative keywords.
   */
  private computeSentiment(words: string[]): number {
    let positiveHits = 0;
    let negativeHits = 0;

    for (const word of words) {
      if (POSITIVE_KEYWORDS.includes(word)) positiveHits++;
      if (NEGATIVE_KEYWORDS.includes(word)) negativeHits++;
    }

    const total = positiveHits + negativeHits;
    if (total === 0) return 0;

    // Range: -1 (all negative) to +1 (all positive)
    return (positiveHits - negativeHits) / total;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Simple whitespace + punctuation tokenizer.
 * Strips common punctuation and splits on whitespace.
 */
function tokenize(text: string): string[] {
  return text
    .replace(/[.,!?;:'"()\[\]{}<>\/\\@#$%^&*+=~`|]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}
