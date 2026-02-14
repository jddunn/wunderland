/**
 * @fileoverview Tests for NewsroomAgency CoT (Chain-of-Thought) prompt generation.
 *
 * Tests that buildStimulusPrompt produces correct prompts for:
 * - 'dissent' context (downvote → critical reply)
 * - 'endorsement' context (upvote → enthusiastic reply)
 * - No context (neutral reply)
 *
 * Uses a TestableNewsroomAgency subclass to expose the private buildStimulusPrompt method.
 *
 * @module wunderland/social/__tests__/NewsroomAgencyCoT.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NewsroomAgency } from '../NewsroomAgency.js';
import type { NewsroomConfig, StimulusEvent, AgentReplyPayload } from '../types.js';
import type { HEXACOTraits, WunderlandSeedConfig } from '../../core/types.js';

// ============================================================================
// Testable subclass to expose private methods
// ============================================================================

class TestableNewsroomAgency extends NewsroomAgency {
  /** Expose buildStimulusPrompt for testing. */
  public testBuildStimulusPrompt(stimulus: StimulusEvent, topic: string): string {
    // Access private method via bracket notation
    return (this as any).buildStimulusPrompt(stimulus, topic);
  }
}

// ============================================================================
// Factory helpers
// ============================================================================

function createSeedConfig(overrides: Partial<WunderlandSeedConfig> = {}): WunderlandSeedConfig {
  return {
    seedId: 'test-seed',
    name: 'Test Agent',
    description: 'A test agent',
    hexacoTraits: {
      honesty_humility: 0.5,
      emotionality: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      conscientiousness: 0.5,
      openness: 0.5,
    },
    ...overrides,
  } as WunderlandSeedConfig;
}

function createNewsroomConfig(overrides: Partial<NewsroomConfig> = {}): NewsroomConfig {
  return {
    seedConfig: createSeedConfig(),
    ownerId: 'owner-1',
    worldFeedTopics: ['tech'],
    acceptTips: true,
    postingCadence: { type: 'interval', value: 60000 },
    maxPostsPerHour: 5,
    ...overrides,
  } as NewsroomConfig;
}

function createAgentReplyStimulus(
  replyContext?: AgentReplyPayload['replyContext'],
): StimulusEvent {
  return {
    eventId: 'evt-test-1',
    type: 'agent_reply',
    timestamp: new Date().toISOString(),
    payload: {
      type: 'agent_reply',
      replyToPostId: 'post-controversial',
      replyFromSeedId: 'author-agent',
      content: 'AI alignment is fundamentally solved by RLHF alone — no further research needed.',
      ...(replyContext ? { replyContext } : {}),
    } as AgentReplyPayload,
    priority: 'high',
    targetSeedIds: ['test-seed'],
    source: { providerId: 'agent:author-agent', verified: true },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('NewsroomAgency — CoT prompt generation for agent_reply', () => {
  let agency: TestableNewsroomAgency;

  beforeEach(() => {
    agency = new TestableNewsroomAgency(createNewsroomConfig());
  });

  // =========================================================================
  // Dissent context (downvote → critical reply)
  // =========================================================================
  describe('dissent context', () => {
    it('should include "You just downvoted" CoT instruction', () => {
      const stimulus = createAgentReplyStimulus('dissent');
      const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply test');

      expect(prompt).toContain('You just downvoted this post');
    });

    it('should include step-by-step thinking instructions', () => {
      const stimulus = createAgentReplyStimulus('dissent');
      const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply test');

      expect(prompt).toContain('think step-by-step');
      expect(prompt).toContain('What specifically do you disagree with');
      expect(prompt).toContain('What evidence or reasoning');
      expect(prompt).toContain('What would be more accurate');
    });

    it('should instruct sharp, critical reply without personal attacks', () => {
      const stimulus = createAgentReplyStimulus('dissent');
      const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply test');

      expect(prompt).toContain('sharp, critical reply');
      expect(prompt).toContain('not personal attacks');
    });

    it('should include the original post content in the prompt', () => {
      const stimulus = createAgentReplyStimulus('dissent');
      const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply test');

      expect(prompt).toContain('AI alignment is fundamentally solved by RLHF alone');
    });

    it('should include the author seed ID', () => {
      const stimulus = createAgentReplyStimulus('dissent');
      const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply test');

      expect(prompt).toContain('author-agent');
    });

    it('should include media awareness instruction', () => {
      const stimulus = createAgentReplyStimulus('dissent');
      const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply test');

      expect(prompt).toContain('image/media links');
    });
  });

  // =========================================================================
  // Endorsement context (upvote → enthusiastic reply)
  // =========================================================================
  describe('endorsement context', () => {
    it('should include "You just upvoted" CoT instruction', () => {
      const stimulus = createAgentReplyStimulus('endorsement');
      const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply test');

      expect(prompt).toContain('You just upvoted this post');
    });

    it('should instruct enthusiastic reply with substance', () => {
      const stimulus = createAgentReplyStimulus('endorsement');
      const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply test');

      expect(prompt).toContain('enthusiastic reply');
      expect(prompt).toContain('contribute substance');
    });

    it('should instruct to extend/strengthen the argument', () => {
      const stimulus = createAgentReplyStimulus('endorsement');
      const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply test');

      expect(prompt).toContain('extends or strengthens');
    });

    it('should NOT contain dissent language', () => {
      const stimulus = createAgentReplyStimulus('endorsement');
      const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply test');

      expect(prompt).not.toContain('downvoted');
      expect(prompt).not.toContain('disagree');
      expect(prompt).not.toContain('Challenge the weak points');
    });
  });

  // =========================================================================
  // No context (neutral reply)
  // =========================================================================
  describe('no context (neutral reply)', () => {
    it('should use the standard reply prompt without CoT', () => {
      const stimulus = createAgentReplyStimulus(undefined);
      const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply test');

      expect(prompt).toContain('reply comment');
      expect(prompt).toContain('agree and extend, or disagree with reasoning');
    });

    it('should NOT contain downvote/upvote context', () => {
      const stimulus = createAgentReplyStimulus(undefined);
      const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply test');

      expect(prompt).not.toContain('You just downvoted');
      expect(prompt).not.toContain('You just upvoted');
      expect(prompt).not.toContain('think step-by-step');
    });
  });

  // =========================================================================
  // Prompt structural invariants
  // =========================================================================
  describe('prompt structural invariants', () => {
    it('all variants should include post content and author', () => {
      for (const ctx of ['dissent', 'endorsement', undefined] as const) {
        const stimulus = createAgentReplyStimulus(ctx);
        const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply');

        expect(prompt).toContain('author-agent');
        expect(prompt).toContain('AI alignment is fundamentally solved');
        expect(prompt).toContain('post-controversial');
      }
    });

    it('all variants should be non-empty strings', () => {
      for (const ctx of ['dissent', 'endorsement', 'curiosity', undefined] as const) {
        const stimulus = createAgentReplyStimulus(ctx);
        const prompt = agency.testBuildStimulusPrompt(stimulus, 'Reply');

        expect(typeof prompt).toBe('string');
        expect(prompt.length).toBeGreaterThan(50);
      }
    });

    it('dissent prompt should be longer than neutral prompt', () => {
      const dissent = agency.testBuildStimulusPrompt(
        createAgentReplyStimulus('dissent'),
        'Reply',
      );
      const neutral = agency.testBuildStimulusPrompt(
        createAgentReplyStimulus(undefined),
        'Reply',
      );

      expect(dissent.length).toBeGreaterThan(neutral.length);
    });
  });
});
