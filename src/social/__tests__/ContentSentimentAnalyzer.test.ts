/**
 * @fileoverview Tests for ContentSentimentAnalyzer — lightweight keyword-based content analysis
 * @module wunderland/social/__tests__/ContentSentimentAnalyzer.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ContentSentimentAnalyzer } from '../ContentSentimentAnalyzer.js';

describe('ContentSentimentAnalyzer', () => {
  let analyzer: ContentSentimentAnalyzer;

  beforeEach(() => {
    analyzer = new ContentSentimentAnalyzer();
  });

  describe('analyze', () => {
    it('should return a PostAnalysis object with all required fields', () => {
      const result = analyzer.analyze('This is a test post about technology.', ['tech']);

      expect(result).toHaveProperty('relevance');
      expect(result).toHaveProperty('controversy');
      expect(result).toHaveProperty('sentiment');
      expect(result).toHaveProperty('replyCount');
    });

    it('should always return replyCount as 0 (not derivable from content)', () => {
      const result = analyzer.analyze('Post with 50 comments mentioned in text', ['comments']);
      expect(result.replyCount).toBe(0);
    });
  });

  describe('relevance computation', () => {
    it('should compute relevance based on tag matches', () => {
      const content = 'This article discusses AI safety and alignment research.';
      const tags = ['ai', 'safety', 'alignment'];

      const result = analyzer.analyze(content, tags);

      // All 3 tags should match: ai, safety, alignment
      expect(result.relevance).toBe(1); // 3/3 = 1
    });

    it('should compute partial relevance when some tags match', () => {
      const content = 'Learning about AI and machine learning models.';
      const tags = ['ai', 'safety', 'ml', 'coding'];

      const result = analyzer.analyze(content, tags);

      // Only 'ai' matches (ml is a separate word from machine learning)
      // If 'machine learning' doesn't contain 'ml', only 1/4 tags match
      expect(result.relevance).toBe(0.25); // 1/4
    });

    it('should return 0 relevance when no tags match', () => {
      const content = 'This is about cooking and recipes.';
      const tags = ['programming', 'software', 'coding'];

      const result = analyzer.analyze(content, tags);

      expect(result.relevance).toBe(0);
    });

    it('should return 0 relevance for empty tags array', () => {
      const content = 'Any content here.';
      const result = analyzer.analyze(content, []);

      expect(result.relevance).toBe(0);
    });

    it('should be case-insensitive for tag matching', () => {
      const content = 'TECHNOLOGY and SCIENCE are interesting topics.';
      const tags = ['technology', 'science'];

      const result = analyzer.analyze(content, tags);

      expect(result.relevance).toBe(1);
    });

    it('should match tags as substrings in content', () => {
      const content = 'The technological advancement in scientific research.';
      const tags = ['tech', 'scien'];

      const result = analyzer.analyze(content, tags);

      // 'tech' should match 'technological', 'scien' should match 'scientific'
      expect(result.relevance).toBe(1);
    });

    it('should cap relevance at 1', () => {
      const content = 'ai ai ai ai ai ai ai ai'; // Tag appears many times
      const tags = ['ai'];

      const result = analyzer.analyze(content, tags);

      expect(result.relevance).toBe(1);
    });
  });

  describe('controversy detection', () => {
    it('should detect controversy from debate markers', () => {
      const content = 'However, I disagree with this viewpoint. The debate continues.';
      const tags: string[] = [];

      const result = analyzer.analyze(content, tags);

      // 'however', 'disagree', 'debate' = 3 markers, 3/4 = 0.75
      expect(result.controversy).toBeCloseTo(0.75, 2);
    });

    it('should detect multi-word controversy markers', () => {
      const content = 'On the other hand, this is a counter-argument to consider.';
      const tags: string[] = [];

      const result = analyzer.analyze(content, tags);

      // 'on the other hand', 'counter-argument' are multi-word markers
      expect(result.controversy).toBeGreaterThan(0);
    });

    it('should return 0 controversy for non-controversial content', () => {
      const content = 'The weather is nice today. I went for a walk in the park.';
      const tags: string[] = [];

      const result = analyzer.analyze(content, tags);

      expect(result.controversy).toBe(0);
    });

    it('should cap controversy at 1', () => {
      const content =
        'However, I disagree. But wait, this is wrong! The challenge is controversial and divisive. The debate has backlash.';
      const tags: string[] = [];

      const result = analyzer.analyze(content, tags);

      expect(result.controversy).toBeLessThanOrEqual(1);
    });

    it('should detect single-word controversy markers', () => {
      const content = 'This is a controversial and divisive topic with much opposition.';
      const tags: string[] = [];

      const result = analyzer.analyze(content, tags);

      expect(result.controversy).toBeGreaterThan(0);
    });
  });

  describe('sentiment computation', () => {
    it('should compute positive sentiment from positive keywords', () => {
      const content = 'This is an excellent and amazing breakthrough! Truly impressive work.';
      const tags: string[] = [];

      const result = analyzer.analyze(content, tags);

      expect(result.sentiment).toBeGreaterThan(0);
    });

    it('should compute negative sentiment from negative keywords', () => {
      const content = 'This is a terrible disaster. The product is useless and broken.';
      const tags: string[] = [];

      const result = analyzer.analyze(content, tags);

      expect(result.sentiment).toBeLessThan(0);
    });

    it('should return neutral sentiment when no keywords match', () => {
      const content = 'The meeting was held at 3pm in the conference room.';
      const tags: string[] = [];

      const result = analyzer.analyze(content, tags);

      expect(result.sentiment).toBe(0);
    });

    it('should balance positive and negative keywords', () => {
      const content = 'The product has excellent features but also terrible documentation.';
      const tags: string[] = [];

      const result = analyzer.analyze(content, tags);

      // 'excellent' (positive) + 'terrible' (negative) = balanced
      expect(result.sentiment).toBe(0);
    });

    it('should return sentiment in range [-1, 1]', () => {
      // All positive
      const positiveContent = 'Excellent amazing brilliant remarkable outstanding impressive wonderful';
      let result = analyzer.analyze(positiveContent, []);
      expect(result.sentiment).toBe(1);

      // All negative
      const negativeContent = 'Terrible awful disaster catastrophe failure broken useless';
      result = analyzer.analyze(negativeContent, []);
      expect(result.sentiment).toBe(-1);
    });

    it('should compute sentiment ratio correctly', () => {
      // 3 positive, 1 negative = (3-1)/4 = 0.5
      const content = 'This is excellent, great, and innovative but has one failure.';
      const tags: string[] = [];

      const result = analyzer.analyze(content, tags);

      expect(result.sentiment).toBeCloseTo(0.5, 2);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty content', () => {
      const result = analyzer.analyze('', ['ai', 'tech']);

      expect(result.relevance).toBe(0);
      expect(result.controversy).toBe(0);
      expect(result.sentiment).toBe(0);
      expect(result.replyCount).toBe(0);
    });

    it('should handle content with only whitespace', () => {
      const result = analyzer.analyze('   \n\t\n   ', ['ai']);

      expect(result.relevance).toBe(0);
      expect(result.controversy).toBe(0);
      expect(result.sentiment).toBe(0);
    });

    it('should handle content with only punctuation', () => {
      const result = analyzer.analyze('!!! ??? ... ,,, ### @@@', ['ai']);

      expect(result.relevance).toBe(0);
      expect(result.controversy).toBe(0);
      expect(result.sentiment).toBe(0);
    });

    it('should handle very long content', () => {
      const longContent = 'AI technology '.repeat(1000) + ' excellent breakthrough';
      const result = analyzer.analyze(longContent, ['ai', 'technology']);

      expect(result.relevance).toBe(1);
      expect(result.sentiment).toBeGreaterThan(0);
    });

    it('should handle special characters in content', () => {
      const content = "AI-powered technology isn't that great! It's wonderful though.";
      const result = analyzer.analyze(content, ['ai']);

      expect(result.relevance).toBeGreaterThan(0);
    });

    it('should handle tags with special characters', () => {
      const content = 'Discussion about c++ and node.js programming.';
      const result = analyzer.analyze(content, ['c++', 'node.js']);

      // Note: depends on how substring matching handles these
      expect(result).toBeDefined();
    });

    it('should handle unicode characters', () => {
      const content = 'AI research is excellent! Great progress on alignment.';
      const result = analyzer.analyze(content, ['ai']);

      expect(result.relevance).toBeGreaterThan(0);
      expect(result.sentiment).toBeGreaterThan(0);
    });

    it('should handle mixed case content and tags', () => {
      const content = 'EXCELLENT work on AI Safety Research!';
      const result = analyzer.analyze(content, ['AI', 'SAFETY']);

      expect(result.relevance).toBe(1);
      expect(result.sentiment).toBeGreaterThan(0);
    });
  });

  describe('Keyword matching accuracy', () => {
    it('should match exact positive keywords', () => {
      const positiveWords = [
        'excellent',
        'great',
        'innovative',
        'breakthrough',
        'brilliant',
        'remarkable',
        'outstanding',
        'impressive',
        'wonderful',
        'amazing',
      ];

      for (const word of positiveWords) {
        const result = analyzer.analyze(`This is ${word}`, []);
        expect(result.sentiment).toBeGreaterThan(0);
      }
    });

    it('should match exact negative keywords', () => {
      const negativeWords = [
        'failure',
        'broken',
        'terrible',
        'awful',
        'disaster',
        'catastrophe',
        'flawed',
        'useless',
        'dangerous',
        'harmful',
      ];

      for (const word of negativeWords) {
        const result = analyzer.analyze(`This is ${word}`, []);
        expect(result.sentiment).toBeLessThan(0);
      }
    });

    it('should match controversy markers', () => {
      const controversyMarkers = [
        'however',
        'disagree',
        'but',
        'wrong',
        'challenge',
        'versus',
        'debate',
        'controversial',
        'divisive',
      ];

      for (const marker of controversyMarkers) {
        const result = analyzer.analyze(`This is ${marker}`, []);
        expect(result.controversy).toBeGreaterThan(0);
      }
    });
  });

  describe('Tokenization', () => {
    it('should tokenize correctly, stripping punctuation', () => {
      const content = "Hello, world! This is a test. How's it going?";
      const result = analyzer.analyze(content, ['hello', 'world', 'test']);

      // All tags should match if tokenization strips punctuation
      expect(result.relevance).toBe(1);
    });

    it('should split on whitespace correctly', () => {
      const content = 'word1   word2\t\tword3\n\nword4';
      const result = analyzer.analyze(content, ['word1', 'word2', 'word3', 'word4']);

      expect(result.relevance).toBe(1);
    });

    it('should handle hyphenated words', () => {
      const content = 'This is a counter-argument with state-of-the-art technology.';
      const result = analyzer.analyze(content, []);

      // 'counter-argument' is a controversy marker
      expect(result.controversy).toBeGreaterThan(0);
    });
  });

  describe('Real-world content examples', () => {
    it('should analyze a tech news article appropriately', () => {
      const content = `
        Breaking: OpenAI announces breakthrough in AI alignment research.
        This innovative approach shows promising results for safety.
        However, some researchers disagree with the methodology.
      `;
      const tags = ['ai', 'openai', 'alignment', 'safety'];

      const result = analyzer.analyze(content, tags);

      expect(result.relevance).toBeGreaterThan(0.5);
      expect(result.sentiment).toBeGreaterThan(0); // breakthrough, innovative, promising
      expect(result.controversy).toBeGreaterThan(0); // however, disagree
    });

    it('should analyze a negative review appropriately', () => {
      const content = `
        This product is a complete disaster. The software is broken,
        useless, and dangerous to use. Total failure on every level.
        Absolutely terrible experience.
      `;
      const tags = ['product', 'software'];

      const result = analyzer.analyze(content, tags);

      expect(result.relevance).toBe(1);
      expect(result.sentiment).toBe(-1); // All negative keywords
      expect(result.controversy).toBe(0); // No debate markers
    });

    it('should analyze a balanced discussion appropriately', () => {
      const content = `
        This new framework is excellent in many ways - it's innovative
        and shows great promise. However, there are some flaws that make
        it problematic for production use. The debate continues about
        whether the benefits outweigh the drawbacks.
      `;
      const tags = ['framework'];

      const result = analyzer.analyze(content, tags);

      expect(result.relevance).toBe(1);
      expect(result.controversy).toBeGreaterThan(0); // however, debate, flawed
      // Sentiment should be slightly positive or neutral (mix of keywords)
    });
  });
});
