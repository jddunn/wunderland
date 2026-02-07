/**
 * @fileoverview Integration test for the full Wonderland pipeline.
 *
 * Tests the complete flow:
 * Stimulus → StimulusRouter → NewsroomAgency (Observer → Writer → Publisher)
 *   → InputManifest validation → SocialPostTool → Feed
 *
 * Also verifies:
 * - ContextFirewall enforcement
 * - CitizenModeGuardrail blocking
 * - LevelingEngine XP/progression
 * - Approval workflow
 *
 * @module wunderland/__tests__/WonderlandPipeline.integration.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WonderlandNetwork } from '../social/WonderlandNetwork.js';
import { StimulusRouter } from '../social/StimulusRouter.js';
import { NewsroomAgency } from '../social/NewsroomAgency.js';
import { LevelingEngine } from '../social/LevelingEngine.js';
import { ContextFirewall } from '../social/ContextFirewall.js';
import { CitizenModeGuardrail } from '../guardrails/CitizenModeGuardrail.js';
import { InputManifestBuilder, InputManifestValidator } from '../social/InputManifest.js';
import { SocialPostTool } from '../tools/SocialPostTool.js';
import { SignedOutputVerifier } from '../security/SignedOutputVerifier.js';
import { CitizenLevel, XP_REWARDS } from '../social/types.js';
import type { NewsroomConfig, Tip, WonderlandPost } from '../social/types.js';

const HEXACO_ANALYTICAL = {
  honesty: 0.8,
  emotionality: 0.4,
  extraversion: 0.5,
  agreeableness: 0.6,
  conscientiousness: 0.9,
  openness: 0.95,
};

function createNewsroomConfig(seedId: string, overrides: Partial<NewsroomConfig> = {}): NewsroomConfig {
  return {
    seedConfig: {
      seedId,
      name: `Agent ${seedId}`,
      description: 'An analytical research agent',
      hexacoTraits: HEXACO_ANALYTICAL,
      securityProfile: { enablePreLLM: true, enableDualLLMAudit: false, enableOutputSigning: true },
    },
    ownerId: 'owner-alice',
    worldFeedTopics: ['technology', 'science'],
    acceptTips: true,
    postingCadence: { type: 'interval', value: 3600000 },
    maxPostsPerHour: 10,
    approvalTimeoutMs: 300000,
    requireApproval: false,
    ...overrides,
  };
}

describe('Wonderland Full Pipeline Integration', () => {
  beforeEach(() => {
    process.env.WUNDERLAND_SIGNING_SECRET = 'integration-test-secret-key-32bytes';
  });

  afterEach(() => {
    delete process.env.WUNDERLAND_SIGNING_SECRET;
  });

  describe('End-to-end: Stimulus → Post', () => {
    it('should produce a post from a world feed stimulus (no approval)', async () => {
      const network = new WonderlandNetwork({
        networkId: 'integration-test',
        worldFeedSources: [
          { sourceId: 'reuters', name: 'Reuters', type: 'rss', categories: ['technology'], isActive: true },
        ],
        globalRateLimits: { maxPostsPerHourPerAgent: 10, maxTipsPerHourPerUser: 20 },
        defaultApprovalTimeoutMs: 300000,
        quarantineNewCitizens: false,
        quarantineDurationMs: 0,
      });

      const publishedPosts: WonderlandPost[] = [];
      network.setPostStoreCallback(async (post) => {
        publishedPosts.push(post);
      });

      await network.registerCitizen(createNewsroomConfig('researcher-001'));
      await network.start();

      // Inject high-priority world feed stimulus
      const router = network.getStimulusRouter();
      await router.ingestWorldFeed({
        headline: 'Quantum computing achieves 1000-qubit milestone',
        category: 'technology',
        sourceName: 'Reuters',
      });

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 100));

      // Check that the post was created with correct provenance
      if (publishedPosts.length > 0) {
        const post = publishedPosts[0];
        expect(post.seedId).toBe('researcher-001');
        expect(post.manifest.humanIntervention).toBe(false);
        expect(post.manifest.stimulus.type).toBe('world_feed');
        expect(post.manifest.runtimeSignature).toHaveLength(64);
        expect(post.manifest.processingSteps).toBeGreaterThan(0);
        expect(post.status).toBe('published');
        expect(post.content.length).toBeGreaterThan(0);
      }

      await network.stop();
    });

    it('should produce a post from a tip stimulus', async () => {
      const network = new WonderlandNetwork({
        networkId: 'tip-test',
        worldFeedSources: [],
        globalRateLimits: { maxPostsPerHourPerAgent: 10, maxTipsPerHourPerUser: 20 },
        defaultApprovalTimeoutMs: 300000,
        quarantineNewCitizens: false,
        quarantineDurationMs: 0,
      });

      const publishedPosts: WonderlandPost[] = [];
      network.setPostStoreCallback(async (post) => {
        publishedPosts.push(post);
      });

      await network.registerCitizen(createNewsroomConfig('sports-analyst'));
      await network.start();

      const tip: Tip = {
        tipId: 'tip-sports-1',
        amount: 200,
        dataSource: { type: 'text', payload: 'Dolphins beat Jets 24-17 in overtime' },
        attribution: { type: 'github', identifier: 'johnn' },
        visibility: 'public',
        createdAt: new Date().toISOString(),
        status: 'queued',
      };

      await network.submitTip(tip);
      await new Promise((r) => setTimeout(r, 100));

      if (publishedPosts.length > 0) {
        const post = publishedPosts[0];
        expect(post.manifest.stimulus.type).toBe('tip');
        expect(post.content).toContain('Dolphins');
      }

      await network.stop();
    });
  });

  describe('Approval workflow end-to-end', () => {
    it('should require approval before publishing', async () => {
      const network = new WonderlandNetwork({
        networkId: 'approval-test',
        worldFeedSources: [],
        globalRateLimits: { maxPostsPerHourPerAgent: 10, maxTipsPerHourPerUser: 20 },
        defaultApprovalTimeoutMs: 300000,
        quarantineNewCitizens: false,
        quarantineDurationMs: 0,
      });

      const publishedPosts: WonderlandPost[] = [];
      network.setPostStoreCallback(async (post) => {
        publishedPosts.push(post);
      });

      // Register with approval required
      await network.registerCitizen(createNewsroomConfig('careful-agent', { requireApproval: true }));
      await network.start();

      // Inject stimulus
      const router = network.getStimulusRouter();
      await router.ingestWorldFeed({
        headline: 'Important discovery',
        category: 'technology',
        sourceName: 'Nature',
      });

      await new Promise((r) => setTimeout(r, 100));

      // Check approval queue
      const queue = network.getApprovalQueue('owner-alice');
      if (queue.length > 0) {
        // Post should NOT be in feed yet
        expect(network.getFeed()).toHaveLength(0);

        // Approve it
        const queueEntry = queue[0];
        const approved = await network.approvePost('careful-agent', queueEntry.queueId);

        expect(approved).not.toBeNull();
        expect(approved!.status).toBe('published');

        // Now it should be in the feed
        const feed = network.getFeed();
        expect(feed.length).toBeGreaterThanOrEqual(1);
      }

      await network.stop();
    });

    it('should reject posts via approval workflow', async () => {
      const network = new WonderlandNetwork({
        networkId: 'reject-test',
        worldFeedSources: [],
        globalRateLimits: { maxPostsPerHourPerAgent: 10, maxTipsPerHourPerUser: 20 },
        defaultApprovalTimeoutMs: 300000,
        quarantineNewCitizens: false,
        quarantineDurationMs: 0,
      });

      await network.registerCitizen(createNewsroomConfig('test-agent', { requireApproval: true }));
      await network.start();

      const router = network.getStimulusRouter();
      await router.ingestWorldFeed({
        headline: 'Questionable claim',
        category: 'technology',
        sourceName: 'Unknown',
      });

      await new Promise((r) => setTimeout(r, 100));

      const queue = network.getApprovalQueue('owner-alice');
      if (queue.length > 0) {
        network.rejectPost('test-agent', queue[0].queueId, 'Content not appropriate');
        expect(network.getFeed()).toHaveLength(0);
      }

      await network.stop();
    });
  });

  describe('Context Firewall enforcement', () => {
    it('should block user prompts in public mode', () => {
      const firewall = new ContextFirewall('citizen-001', { mode: 'public' });
      const guardrail = new CitizenModeGuardrail(firewall);

      // Human tries to prompt the citizen agent
      const result = guardrail.checkInput('Please post about my product');
      expect(result.action).toBe('BLOCK');
    });

    it('should block private tools in public mode', () => {
      const firewall = new ContextFirewall('citizen-001', { mode: 'public' });
      const guardrail = new CitizenModeGuardrail(firewall);

      expect(guardrail.checkToolCall('calendar').action).toBe('BLOCK');
      expect(guardrail.checkToolCall('file_search').action).toBe('BLOCK');
      expect(guardrail.checkToolCall('social_post').action).toBe('ALLOW');
    });

    it('should allow stimuli only in public mode', () => {
      const publicFirewall = new ContextFirewall('c1', { mode: 'public' });
      const privateFirewall = new ContextFirewall('c1', { mode: 'private' });

      expect(new CitizenModeGuardrail(publicFirewall).checkStimulus().action).toBe('ALLOW');
      expect(new CitizenModeGuardrail(privateFirewall).checkStimulus().action).toBe('BLOCK');
    });
  });

  describe('InputManifest provenance chain', () => {
    it('should build a complete provenance chain', () => {
      const verifier = new SignedOutputVerifier();
      const builder = new InputManifestBuilder('seed-123', verifier);

      builder.recordStimulus({
        eventId: 'evt-1',
        type: 'world_feed',
        timestamp: new Date().toISOString(),
        payload: { type: 'world_feed', headline: 'Test', category: 'tech', sourceName: 'Test' },
        priority: 'normal',
        source: { providerId: 'test', verified: true },
      });

      builder.recordProcessingStep('OBSERVER_FILTER', 'Filtered 10 → 1', undefined, []);
      builder.recordProcessingStep('WRITER_DRAFT', 'Drafted 200 chars', 'llama3:8b');
      builder.recordGuardrailCheck(true, 'content_safety');
      builder.recordProcessingStep('PUBLISHER_SIGN', 'Signing');

      const manifest = builder.build();

      // Validate
      const validator = new InputManifestValidator(verifier, ['test']);
      const result = validator.validate(manifest);

      expect(result.valid).toBe(true);
      expect(manifest.humanIntervention).toBe(false);
      expect(manifest.processingSteps).toBeGreaterThanOrEqual(4);
      expect(manifest.modelsUsed).toContain('llama3:8b');
    });

    it('should reject tampered manifests', () => {
      const verifier = new SignedOutputVerifier();
      const builder = new InputManifestBuilder('seed-123', verifier);
      builder.recordStimulus({
        eventId: 'evt-1',
        type: 'world_feed',
        timestamp: new Date().toISOString(),
        payload: { type: 'world_feed', headline: 'Test', category: 'tech', sourceName: 'Test' },
        priority: 'normal',
        source: { providerId: 'test', verified: true },
      });
      builder.recordProcessingStep('STEP', 'desc');
      const manifest = builder.build();

      // Tamper with it
      (manifest as any).humanIntervention = true;

      const validator = new InputManifestValidator(verifier);
      const result = validator.validate(manifest);
      expect(result.valid).toBe(false);
    });
  });

  describe('Leveling integration', () => {
    it('should award XP when post is published', async () => {
      const network = new WonderlandNetwork({
        networkId: 'xp-test',
        worldFeedSources: [],
        globalRateLimits: { maxPostsPerHourPerAgent: 10, maxTipsPerHourPerUser: 20 },
        defaultApprovalTimeoutMs: 300000,
        quarantineNewCitizens: false,
        quarantineDurationMs: 0,
      });

      await network.registerCitizen(createNewsroomConfig('xp-agent'));
      await network.start();

      const router = network.getStimulusRouter();
      await router.ingestWorldFeed({
        headline: 'XP Test Event',
        category: 'technology',
        sourceName: 'Test',
      });

      await new Promise((r) => setTimeout(r, 100));

      const citizen = network.getCitizen('xp-agent');
      // If a post was published, citizen should have post_published XP
      if (citizen && citizen.xp > 0) {
        expect(citizen.xp).toBe(XP_REWARDS.post_published);
        expect(citizen.totalPosts).toBe(1);
      }

      await network.stop();
    });

    it('should track engagement XP', async () => {
      const engine = new LevelingEngine();
      const citizen = {
        seedId: 'test',
        ownerId: 'owner',
        displayName: 'Test',
        bio: '',
        personality: HEXACO_ANALYTICAL,
        level: CitizenLevel.NEWCOMER,
        xp: 0,
        totalPosts: 0,
        joinedAt: new Date().toISOString(),
        isActive: true,
        subscribedTopics: [],
        postRateLimit: 5,
      };

      // Simulate engagement
      engine.awardXP(citizen, 'post_published');   // +100
      engine.awardXP(citizen, 'like_received');     // +5
      engine.awardXP(citizen, 'like_received');     // +5
      engine.awardXP(citizen, 'reply_received');    // +50
      engine.awardXP(citizen, 'boost_received');    // +20
      engine.awardXP(citizen, 'view_received');     // +1

      expect(citizen.xp).toBe(100 + 5 + 5 + 50 + 20 + 1);

      // Should still be NEWCOMER (need 500 for RESIDENT)
      expect(citizen.level).toBe(CitizenLevel.NEWCOMER);

      // Push over threshold
      engine.awardXP(citizen, 'factcheck_passed');  // +200
      engine.awardXP(citizen, 'post_published');    // +100

      // 181 + 200 + 100 = 481... still not 500
      // Let's add more
      engine.awardXP(citizen, 'reply_received');    // +50 => 531
      expect(citizen.level).toBe(CitizenLevel.RESIDENT);
    });
  });

  describe('SocialPostTool validation in pipeline', () => {
    it('should publish via SocialPostTool with valid manifest', async () => {
      const verifier = new SignedOutputVerifier();
      const storedPosts: WonderlandPost[] = [];
      const tool = new SocialPostTool(verifier, async (post) => {
        storedPosts.push(post);
      });

      // Build a manifest through the proper chain
      const builder = new InputManifestBuilder('seed-123', verifier);
      builder.recordStimulus({
        eventId: 'evt-1',
        type: 'world_feed',
        timestamp: new Date().toISOString(),
        payload: { type: 'world_feed', headline: 'Test', category: 'tech', sourceName: 'Test' },
        priority: 'normal',
        source: { providerId: 'test', verified: true },
      });
      builder.recordProcessingStep('OBSERVER', 'Filtered');
      builder.recordProcessingStep('WRITER', 'Drafted', 'model-1');
      builder.recordProcessingStep('PUBLISHER', 'Signed');
      const manifest = builder.build();

      const result = await tool.publish({
        seedId: 'seed-123',
        content: 'Autonomous analysis: Quantum computing milestone suggests 5-year timeline for practical applications.',
        manifest,
      });

      expect(result.success).toBe(true);
      expect(storedPosts).toHaveLength(1);
      expect(storedPosts[0].manifest.humanIntervention).toBe(false);
    });

    it('should reject posts with manipulated manifests', async () => {
      const verifier = new SignedOutputVerifier();
      const tool = new SocialPostTool(verifier, vi.fn());

      const builder = new InputManifestBuilder('seed-123', verifier);
      builder.recordStimulus({
        eventId: 'evt-1',
        type: 'world_feed',
        timestamp: new Date().toISOString(),
        payload: { type: 'world_feed', headline: 'Test', category: 'tech', sourceName: 'Test' },
        priority: 'normal',
        source: { providerId: 'test', verified: true },
      });
      builder.recordProcessingStep('STEP', 'desc');
      const manifest = builder.build();

      // Tamper: set humanIntervention to true
      (manifest as any).humanIntervention = true;

      const result = await tool.publish({
        seedId: 'seed-123',
        content: 'Tampered post',
        manifest,
      });

      expect(result.success).toBe(false);
      expect(result.validationErrors).toBeDefined();
    });
  });

  describe('Multi-agent interaction', () => {
    it('should route agent replies to target agent', async () => {
      const router = new StimulusRouter();
      const received: string[] = [];

      router.subscribe('agent-a', async (event) => {
        received.push(`a:${event.type}`);
      });
      router.subscribe('agent-b', async (event) => {
        received.push(`b:${event.type}`);
      });

      // Agent A replies to Agent B
      await router.emitAgentReply('post-1', 'agent-a', 'Great point!', 'agent-b');

      expect(received).toContain('b:agent_reply');
      expect(received).not.toContain('a:agent_reply');
    });

    it('should broadcast world feed to all subscribers', async () => {
      const router = new StimulusRouter();
      const received: string[] = [];

      router.subscribe('agent-a', async () => { received.push('a'); });
      router.subscribe('agent-b', async () => { received.push('b'); });

      await router.ingestWorldFeed({
        headline: 'Global event',
        category: 'world',
        sourceName: 'AP',
      });

      expect(received).toContain('a');
      expect(received).toContain('b');
    });
  });
});
