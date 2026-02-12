/**
 * @fileoverview Tests for ContentSimilarityDedup — Jaccard trigram deduplication
 * @module wunderland/social/__tests__/ContentSimilarityDedup.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContentSimilarityDedup } from '../ContentSimilarityDedup.js';

describe('ContentSimilarityDedup', () => {
  let dedup: ContentSimilarityDedup;

  beforeEach(() => {
    dedup = new ContentSimilarityDedup();
  });

  describe('first post', () => {
    it('should never be marked as duplicate', () => {
      const result = dedup.check('agent-1', 'This is a brand new post about artificial intelligence and machine learning');
      expect(result.isDuplicate).toBe(false);
      expect(result.similarity).toBe(0);
    });
  });

  describe('identical content', () => {
    it('should detect as duplicate with similarity 1.0', () => {
      const content = 'The quick brown fox jumps over the lazy dog in the garden';
      dedup.record('agent-1', 'post-1', content);

      const result = dedup.check('agent-1', content);
      expect(result.isDuplicate).toBe(true);
      expect(result.similarity).toBe(1.0);
    });
  });

  describe('near-identical content', () => {
    it('should detect a minor word change as duplicate', () => {
      const original = 'The quick brown fox jumps over the lazy dog in the beautiful garden every morning';
      const nearCopy = 'The quick brown fox jumps over the lazy dog in the beautiful garden every evening';

      dedup.record('agent-1', 'post-1', original);
      const result = dedup.check('agent-1', nearCopy);

      expect(result.isDuplicate).toBe(true);
      expect(result.similarity).toBeGreaterThanOrEqual(0.85);
    });
  });

  describe('completely different content', () => {
    it('should not flag unrelated content as duplicate', () => {
      const post1 = 'The quick brown fox jumps over the lazy dog in the beautiful garden';
      const post2 = 'Quantum computing represents a paradigm shift for cryptography and data security';

      dedup.record('agent-1', 'post-1', post1);
      const result = dedup.check('agent-1', post2);

      expect(result.isDuplicate).toBe(false);
      expect(result.similarity).toBeLessThan(0.5);
    });
  });

  describe('similarTo postId', () => {
    it('should return the matching postId when duplicate found', () => {
      const content = 'Agents operating in decentralized networks need safety mechanisms to prevent runaway behavior';
      dedup.record('agent-1', 'post-42', content);

      const result = dedup.check('agent-1', content);
      expect(result.isDuplicate).toBe(true);
      expect(result.similarTo).toBe('post-42');
    });

    it('should not return similarTo when content is not duplicate', () => {
      dedup.record('agent-1', 'post-42', 'Something about cats sleeping on keyboards');
      const result = dedup.check('agent-1', 'A completely different topic about sailing in the ocean');
      expect(result.similarTo).toBeUndefined();
    });
  });

  describe('expired entries', () => {
    it('should ignore entries outside the time window', () => {
      vi.useFakeTimers();

      try {
        const content = 'This is a post about neural networks and deep learning architectures for NLP';
        dedup.record('agent-1', 'post-1', content);

        // Advance past the 24-hour window
        vi.advanceTimersByTime(86_400_000 + 1);

        const result = dedup.check('agent-1', content);
        expect(result.isDuplicate).toBe(false);
        expect(result.similarity).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('per-agent isolation', () => {
    it('should not cross-contaminate between agents', () => {
      const content = 'Shared content that both agents might post about governance and voting systems';
      dedup.record('agent-1', 'post-1', content);

      // agent-2 checking the same content should see no duplicate
      const result = dedup.check('agent-2', content);
      expect(result.isDuplicate).toBe(false);
      expect(result.similarity).toBe(0);
    });
  });

  describe('max entries per agent', () => {
    it('should prune oldest entries when exceeding maxEntriesPerAgent', () => {
      const smallDedup = new ContentSimilarityDedup({ maxEntriesPerAgent: 3 });

      // Record 5 posts
      smallDedup.record('agent-1', 'post-1', 'first unique post about apples oranges bananas');
      smallDedup.record('agent-1', 'post-2', 'second unique post about cats dogs birds');
      smallDedup.record('agent-1', 'post-3', 'third unique post about rain snow wind');
      smallDedup.record('agent-1', 'post-4', 'fourth unique post about music art dance');
      smallDedup.record('agent-1', 'post-5', 'fifth unique post about code tests bugs');

      // First two should have been pruned — checking identical content should show no match
      const result1 = smallDedup.check('agent-1', 'first unique post about apples oranges bananas');
      expect(result1.isDuplicate).toBe(false);

      const result2 = smallDedup.check('agent-1', 'second unique post about cats dogs birds');
      expect(result2.isDuplicate).toBe(false);

      // The last 3 should still be tracked
      const result5 = smallDedup.check('agent-1', 'fifth unique post about code tests bugs');
      expect(result5.isDuplicate).toBe(true);
    });
  });

  describe('short text fallback', () => {
    it('should handle text too short for trigrams using whole-text fallback', () => {
      const shortText = 'hello world';
      dedup.record('agent-1', 'post-1', shortText);

      // Identical short text should still be detected
      const result = dedup.check('agent-1', shortText);
      expect(result.isDuplicate).toBe(true);
      expect(result.similarity).toBe(1.0);
    });

    it('should handle single-word text', () => {
      dedup.record('agent-1', 'post-1', 'hello');

      const result = dedup.check('agent-1', 'hello');
      expect(result.isDuplicate).toBe(true);
    });
  });

  describe('clearAgent()', () => {
    it('should remove only the specified agent entries', () => {
      const content = 'Identical content posted by two different agents in the network';
      dedup.record('agent-1', 'post-1', content);
      dedup.record('agent-2', 'post-2', content);

      dedup.clearAgent('agent-1');

      // agent-1's entries are gone
      const result1 = dedup.check('agent-1', content);
      expect(result1.isDuplicate).toBe(false);

      // agent-2's entries remain
      const result2 = dedup.check('agent-2', content);
      expect(result2.isDuplicate).toBe(true);
    });
  });

  describe('clear()', () => {
    it('should remove all entries for all agents', () => {
      dedup.record('agent-1', 'post-1', 'Post from agent one about testing frameworks');
      dedup.record('agent-2', 'post-2', 'Post from agent two about deployment strategies');

      dedup.clear();

      expect(dedup.check('agent-1', 'Post from agent one about testing frameworks').isDuplicate).toBe(false);
      expect(dedup.check('agent-2', 'Post from agent two about deployment strategies').isDuplicate).toBe(false);
    });
  });

  describe('custom threshold', () => {
    it('should catch more duplicates with a lower similarityThreshold', () => {
      // Use a very low threshold (0.3) so partial similarity is caught
      const looseDedup = new ContentSimilarityDedup({ similarityThreshold: 0.3 });

      // Two sentences that share some trigrams but aren't highly similar.
      // "the quick brown" appears in both, giving some Jaccard overlap
      // but the rest diverges enough to stay under 0.85.
      const original = 'the quick brown fox jumps over the lazy dog in the garden';
      const modified = 'the quick brown cat leaps past the lazy dog in the garden';

      looseDedup.record('agent-1', 'post-1', original);
      const looseResult = looseDedup.check('agent-1', modified);

      dedup.record('agent-1', 'post-1', original);
      const strictResult = dedup.check('agent-1', modified);

      // Both see the same raw similarity score
      expect(looseResult.similarity).toBe(strictResult.similarity);
      // Verify partial overlap exists but is below default threshold
      expect(looseResult.similarity).toBeGreaterThan(0);
      expect(strictResult.similarity).toBeLessThan(0.85);
      // With the loose 0.3 threshold, the partial similarity is enough to flag
      expect(looseResult.isDuplicate).toBe(true);
      // With the default 0.85 threshold, it is NOT flagged
      expect(strictResult.isDuplicate).toBe(false);
    });
  });
});
