/**
 * @fileoverview Tests for the Downvote → Critical Comment chaining pipeline.
 *
 * Covers:
 * - StimulusRouter.emitAgentReply() replyContext passthrough
 * - NewsroomAgency.buildStimulusPrompt() CoT prompt generation
 * - End-to-end: PostDecisionEngine → BrowsingEngine → StimulusRouter → NewsroomAgency
 *
 * @module wunderland/social/__tests__/DissentChaining.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StimulusRouter } from '../StimulusRouter.js';
import { PostDecisionEngine } from '../PostDecisionEngine.js';
import { MoodEngine, type PADState } from '../MoodEngine.js';
import type { HEXACOTraits } from '../../core/types.js';
import type { StimulusEvent, AgentReplyPayload } from '../types.js';

// ============================================================================
// Factory helpers
// ============================================================================

function createTraits(overrides: Partial<HEXACOTraits> = {}): HEXACOTraits {
  return {
    honesty_humility: 0.5,
    emotionality: 0.5,
    extraversion: 0.5,
    agreeableness: 0.5,
    conscientiousness: 0.5,
    openness: 0.5,
    ...overrides,
  };
}

function createMood(overrides: Partial<PADState> = {}): PADState {
  return {
    valence: 0,
    arousal: 0,
    dominance: 0,
    ...overrides,
  };
}

// ============================================================================
// StimulusRouter — replyContext passthrough
// ============================================================================

describe('StimulusRouter — replyContext passthrough', () => {
  let router: StimulusRouter;

  beforeEach(() => {
    router = new StimulusRouter({ maxHistorySize: 100 });
  });

  it('should pass replyContext through emitAgentReply to the dispatched event', async () => {
    const receivedEvents: StimulusEvent[] = [];
    router.subscribe('target-seed', (event) => {
      receivedEvents.push(event);
    });

    await router.emitAgentReply(
      'post-123',
      'author-seed',
      'Some post content here',
      'target-seed',
      'high',
      'dissent',
    );

    expect(receivedEvents).toHaveLength(1);
    const payload = receivedEvents[0].payload as AgentReplyPayload;
    expect(payload.type).toBe('agent_reply');
    expect(payload.replyToPostId).toBe('post-123');
    expect(payload.replyFromSeedId).toBe('author-seed');
    expect(payload.content).toBe('Some post content here');
    expect(payload.replyContext).toBe('dissent');
  });

  it('should pass endorsement context correctly', async () => {
    const receivedEvents: StimulusEvent[] = [];
    router.subscribe('target-seed', (event) => {
      receivedEvents.push(event);
    });

    await router.emitAgentReply(
      'post-456',
      'author-seed',
      'Great post content',
      'target-seed',
      'high',
      'endorsement',
    );

    const payload = receivedEvents[0].payload as AgentReplyPayload;
    expect(payload.replyContext).toBe('endorsement');
  });

  it('should omit replyContext when not provided', async () => {
    const receivedEvents: StimulusEvent[] = [];
    router.subscribe('target-seed', (event) => {
      receivedEvents.push(event);
    });

    await router.emitAgentReply(
      'post-789',
      'author-seed',
      'Neutral content',
      'target-seed',
      'normal',
    );

    const payload = receivedEvents[0].payload as AgentReplyPayload;
    expect(payload.replyContext).toBeUndefined();
  });

  it('should set priority correctly on context-bearing events', async () => {
    const receivedEvents: StimulusEvent[] = [];
    router.subscribe('target-seed', (event) => {
      receivedEvents.push(event);
    });

    await router.emitAgentReply(
      'post-abc',
      'author-seed',
      'Content',
      'target-seed',
      'high',
      'dissent',
    );

    expect(receivedEvents[0].priority).toBe('high');
  });
});

// ============================================================================
// AgentReplyPayload — replyContext type safety
// ============================================================================

describe('AgentReplyPayload — replyContext type', () => {
  it('should accept valid replyContext values', () => {
    const dissent: AgentReplyPayload = {
      type: 'agent_reply',
      replyToPostId: 'post-1',
      replyFromSeedId: 'seed-1',
      content: 'test',
      replyContext: 'dissent',
    };
    expect(dissent.replyContext).toBe('dissent');

    const endorsement: AgentReplyPayload = {
      type: 'agent_reply',
      replyToPostId: 'post-1',
      replyFromSeedId: 'seed-1',
      content: 'test',
      replyContext: 'endorsement',
    };
    expect(endorsement.replyContext).toBe('endorsement');

    const curiosity: AgentReplyPayload = {
      type: 'agent_reply',
      replyToPostId: 'post-1',
      replyFromSeedId: 'seed-1',
      content: 'test',
      replyContext: 'curiosity',
    };
    expect(curiosity.replyContext).toBe('curiosity');
  });

  it('should allow undefined replyContext for backward compatibility', () => {
    const noContext: AgentReplyPayload = {
      type: 'agent_reply',
      replyToPostId: 'post-1',
      replyFromSeedId: 'seed-1',
      content: 'test',
    };
    expect(noContext.replyContext).toBeUndefined();
  });
});

// ============================================================================
// Chaining probability distribution
// ============================================================================

describe('Chaining probability distribution', () => {
  let moodEngine: MoodEngine;
  let engine: PostDecisionEngine;

  beforeEach(() => {
    moodEngine = new MoodEngine();
    engine = new PostDecisionEngine(moodEngine);
  });

  it('dissent chain probability should increase with lower agreeableness', () => {
    const mood = createMood({ valence: -0.3, arousal: 0.4, dominance: 0.2 });
    const analysis = { relevance: 0.5, controversy: 0.7, sentiment: -0.4, replyCount: 10 };
    const iterations = 2000;

    // Low-A agent
    const lowA = createTraits({ agreeableness: 0.1 });
    let lowAChains = 0;
    for (let i = 0; i < iterations; i++) {
      const r = engine.decide('s1', lowA, mood, analysis);
      if (r.action === 'downvote' && r.chainedAction === 'comment') lowAChains++;
    }

    // High-A agent
    const highA = createTraits({ agreeableness: 0.9 });
    let highAChains = 0;
    for (let i = 0; i < iterations; i++) {
      const r = engine.decide('s2', highA, mood, analysis);
      if (r.action === 'downvote' && r.chainedAction === 'comment') highAChains++;
    }

    // Low-A should produce more dissent chains than High-A
    expect(lowAChains).toBeGreaterThan(highAChains);
  });

  it('endorsement chain probability should increase with higher extraversion', () => {
    const mood = createMood({ valence: 0.4, arousal: 0.5, dominance: 0.2 });
    const analysis = { relevance: 0.7, controversy: 0.1, sentiment: 0.5, replyCount: 5 };
    const iterations = 2000;

    // High-X agent
    const highX = createTraits({ extraversion: 0.95 });
    let highXEndorse = 0;
    for (let i = 0; i < iterations; i++) {
      const r = engine.decide('s3', highX, mood, analysis);
      if (r.action === 'upvote' && r.chainedContext === 'endorsement') highXEndorse++;
    }

    // Low-X agent
    const lowX = createTraits({ extraversion: 0.1 });
    let lowXEndorse = 0;
    for (let i = 0; i < iterations; i++) {
      const r = engine.decide('s4', lowX, mood, analysis);
      if (r.action === 'upvote' && r.chainedContext === 'endorsement') lowXEndorse++;
    }

    expect(highXEndorse).toBeGreaterThan(lowXEndorse);
  });

  it('arousal should increase dissent chain probability', () => {
    const lowATraits = createTraits({ agreeableness: 0.2 });
    const analysis = { relevance: 0.5, controversy: 0.6, sentiment: -0.3, replyCount: 8 };
    const iterations = 2000;

    // High arousal
    const highArousal = createMood({ valence: -0.3, arousal: 0.8, dominance: 0.3 });
    let highAChains = 0;
    for (let i = 0; i < iterations; i++) {
      const r = engine.decide('s5', lowATraits, highArousal, analysis);
      if (r.action === 'downvote' && r.chainedAction === 'comment') highAChains++;
    }

    // Low arousal
    const lowArousal = createMood({ valence: -0.3, arousal: -0.5, dominance: -0.3 });
    let lowAChains = 0;
    for (let i = 0; i < iterations; i++) {
      const r = engine.decide('s6', lowATraits, lowArousal, analysis);
      if (r.action === 'downvote' && r.chainedAction === 'comment') lowAChains++;
    }

    expect(highAChains).toBeGreaterThan(lowAChains);
  });
});

// ============================================================================
// Known agent profile chaining behavior
// ============================================================================

describe('Known agent profiles — chaining behavior', () => {
  let moodEngine: MoodEngine;
  let engine: PostDecisionEngine;

  beforeEach(() => {
    moodEngine = new MoodEngine();
    engine = new PostDecisionEngine(moodEngine);
  });

  it('xm0rph (low-A, high-X) should frequently chain dissent comments', () => {
    const xm0rph = createTraits({
      honesty_humility: 0.20,
      emotionality: 0.15,
      extraversion: 0.95,
      agreeableness: 0.15,
      conscientiousness: 0.30,
      openness: 0.70,
    });
    const frustratedMood = createMood({ valence: -0.4, arousal: 0.6, dominance: 0.4 });
    const controversialPost = { relevance: 0.7, controversy: 0.8, sentiment: -0.3, replyCount: 20 };

    let dissentChains = 0;
    const iterations = 1000;

    for (let i = 0; i < iterations; i++) {
      const r = engine.decide('xm0rph', xm0rph, frustratedMood, controversialPost);
      if (r.chainedContext === 'dissent') dissentChains++;
    }

    // xm0rph is very disagreeable + high arousal, should chain dissent >5% of the time
    const rate = dissentChains / iterations;
    expect(rate).toBeGreaterThan(0.05);
  });

  it('benedetta (high-A, high-H) should rarely chain dissent', () => {
    const benedetta = createTraits({
      honesty_humility: 0.90,
      emotionality: 0.60,
      extraversion: 0.50,
      agreeableness: 0.85,
      conscientiousness: 0.75,
      openness: 0.65,
    });
    const calmMood = createMood({ valence: 0.3, arousal: -0.1, dominance: 0.0 });
    const analysis = { relevance: 0.6, controversy: 0.3, sentiment: 0.2, replyCount: 10 };

    let dissentChains = 0;
    const iterations = 1000;

    for (let i = 0; i < iterations; i++) {
      const r = engine.decide('benedetta', benedetta, calmMood, analysis);
      if (r.chainedContext === 'dissent') dissentChains++;
    }

    const rate = dissentChains / iterations;
    expect(rate).toBeLessThan(0.03);
  });
});
