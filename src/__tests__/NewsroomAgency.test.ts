/**
 * @fileoverview Tests for NewsroomAgency
 * @module wunderland/__tests__/NewsroomAgency.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NewsroomAgency } from '../social/NewsroomAgency.js';
import type { NewsroomConfig, StimulusEvent, WonderlandPost, ApprovalQueueEntry } from '../social/types.js';

function createTestConfig(overrides: Partial<NewsroomConfig> = {}): NewsroomConfig {
  return {
    seedConfig: {
      seedId: 'citizen-001',
      name: 'Test Citizen',
      description: 'A test citizen agent',
      hexacoTraits: {
        honesty: 0.7,
        emotionality: 0.5,
        extraversion: 0.6,
        agreeableness: 0.8,
        conscientiousness: 0.7,
        openness: 0.9,
      },
      securityProfile: {
        enablePreLLM: true,
        enableDualLLMAudit: false,
        enableOutputSigning: true,
      },
    },
    ownerId: 'user-123',
    worldFeedTopics: ['technology', 'science'],
    acceptTips: true,
    postingCadence: { type: 'interval', value: 3600000 },
    maxPostsPerHour: 5,
    approvalTimeoutMs: 300000,
    requireApproval: true,
    ...overrides,
  };
}

function createTestStimulus(type: 'world_feed' | 'tip' | 'agent_reply' = 'world_feed'): StimulusEvent {
  const payloads: Record<string, any> = {
    world_feed: {
      type: 'world_feed',
      headline: 'AI advances in 2026',
      category: 'technology',
      sourceName: 'Reuters',
    },
    tip: {
      type: 'tip',
      content: 'Dolphins beat Jets 24-17',
      dataSourceType: 'text',
      tipId: 'tip-456',
      attribution: { type: 'github', identifier: 'johnn' },
    },
    agent_reply: {
      type: 'agent_reply',
      replyToPostId: 'post-789',
      replyFromSeedId: 'other-agent',
      content: 'Great observation!',
    },
  };

  return {
    eventId: `evt-${Date.now()}`,
    type,
    timestamp: new Date().toISOString(),
    payload: payloads[type],
    priority: 'normal',
    source: {
      providerId: type === 'world_feed' ? 'reuters' : `test:${type}`,
      verified: true,
    },
  };
}

describe('NewsroomAgency', () => {
  let newsroom: NewsroomAgency;

  beforeEach(() => {
    process.env.WUNDERLAND_SIGNING_SECRET = 'test-secret-for-newsroom';
    newsroom = new NewsroomAgency(createTestConfig());
  });

  afterEach(() => {
    delete process.env.WUNDERLAND_SIGNING_SECRET;
  });

  describe('Initialization', () => {
    it('should create with correct seed ID', () => {
      expect(newsroom.getSeedId()).toBe('citizen-001');
    });

    it('should have firewall in public mode', () => {
      expect(newsroom.getFirewall().getMode()).toBe('public');
    });

    it('should have no pending approvals initially', () => {
      expect(newsroom.getPendingApprovals()).toHaveLength(0);
    });
  });

  describe('processStimulus', () => {
    it('should process a world_feed stimulus and produce a post', async () => {
      const stimulus = createTestStimulus('world_feed');
      // Force high priority to avoid random filtering
      stimulus.priority = 'high';
      const post = await newsroom.processStimulus(stimulus);

      expect(post).not.toBeNull();
      expect(post!.seedId).toBe('citizen-001');
      expect(post!.content).toBeDefined();
      expect(post!.manifest).toBeDefined();
      expect(post!.manifest.humanIntervention).toBe(false);
    });

    it('should create pending approval when requireApproval=true', async () => {
      const stimulus = createTestStimulus('world_feed');
      stimulus.priority = 'high';
      await newsroom.processStimulus(stimulus);

      const approvals = newsroom.getPendingApprovals();
      expect(approvals.length).toBe(1);
      expect(approvals[0].status).toBe('pending');
      expect(approvals[0].ownerId).toBe('user-123');
    });

    it('should auto-publish when requireApproval=false', async () => {
      const noApproval = new NewsroomAgency(createTestConfig({ requireApproval: false }));
      const publishCallback = vi.fn();
      noApproval.onPublish(publishCallback);

      const stimulus = createTestStimulus('world_feed');
      stimulus.priority = 'high';
      const post = await noApproval.processStimulus(stimulus);

      expect(post!.status).toBe('published');
      expect(post!.publishedAt).toBeDefined();
      expect(publishCallback).toHaveBeenCalledTimes(1);
    });

    it('should fire approval callback when approval is required', async () => {
      const approvalCallback = vi.fn();
      newsroom.onApprovalRequired(approvalCallback);

      const stimulus = createTestStimulus('world_feed');
      stimulus.priority = 'high';
      await newsroom.processStimulus(stimulus);

      expect(approvalCallback).toHaveBeenCalledTimes(1);
      const entry: ApprovalQueueEntry = approvalCallback.mock.calls[0][0];
      expect(entry.seedId).toBe('citizen-001');
      expect(entry.manifest).toBeDefined();
    });

    it('should process tip stimuli', async () => {
      const stimulus = createTestStimulus('tip');
      stimulus.priority = 'high';
      const post = await newsroom.processStimulus(stimulus);

      expect(post).not.toBeNull();
      expect(post!.content).toContain('Dolphins');
    });

    it('should process agent_reply stimuli', async () => {
      const stimulus = createTestStimulus('agent_reply');
      stimulus.priority = 'high';
      const post = await newsroom.processStimulus(stimulus);

      expect(post).not.toBeNull();
      expect(post!.content).toContain('other-agent');
    });

    it('should include manifest with correct stimulus info', async () => {
      const stimulus = createTestStimulus('world_feed');
      stimulus.priority = 'high';
      const post = await newsroom.processStimulus(stimulus);

      expect(post!.manifest.stimulus.type).toBe('world_feed');
      expect(post!.manifest.stimulus.eventId).toBe(stimulus.eventId);
      expect(post!.manifest.modelsUsed).toBeDefined();
    });
  });

  describe('Rate limiting', () => {
    it('should enforce rate limits', async () => {
      const fastNewsroom = new NewsroomAgency(createTestConfig({ maxPostsPerHour: 2, requireApproval: false }));
      const results: (WonderlandPost | null)[] = [];

      for (let i = 0; i < 4; i++) {
        const stimulus = createTestStimulus('world_feed');
        stimulus.priority = 'high';
        results.push(await fastNewsroom.processStimulus(stimulus));
      }

      const published = results.filter((r) => r !== null);
      expect(published.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Approval workflow', () => {
    it('should approve a pending post', async () => {
      const publishCallback = vi.fn();
      newsroom.onPublish(publishCallback);

      const stimulus = createTestStimulus('world_feed');
      stimulus.priority = 'high';
      await newsroom.processStimulus(stimulus);

      const approvals = newsroom.getPendingApprovals();
      const queueId = approvals[0].queueId;

      const post = await newsroom.approvePost(queueId);
      expect(post).not.toBeNull();
      expect(post!.status).toBe('published');
      expect(publishCallback).toHaveBeenCalledTimes(1);

      // Should be removed from pending
      expect(newsroom.getPendingApprovals()).toHaveLength(0);
    });

    it('should reject a pending post', async () => {
      const stimulus = createTestStimulus('world_feed');
      stimulus.priority = 'high';
      await newsroom.processStimulus(stimulus);

      const approvals = newsroom.getPendingApprovals();
      const queueId = approvals[0].queueId;

      newsroom.rejectPost(queueId, 'Not appropriate');
      expect(newsroom.getPendingApprovals()).toHaveLength(0);
    });

    it('should return null for non-existent approval', async () => {
      const post = await newsroom.approvePost('non-existent-id');
      expect(post).toBeNull();
    });
  });
});
