/**
 * @fileoverview Tests for StimulusRouter — event distribution to agent Observers
 * @module wunderland/social/__tests__/StimulusRouter.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StimulusRouter, type StimulusHandler } from '../StimulusRouter.js';
import type {
  StimulusEvent,
  Tip,
  WorldFeedSource,
  WorldFeedPayload,
  ChannelMessagePayload,
} from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTip(overrides: Partial<Tip> = {}): Tip {
  return {
    tipId: 'tip-001',
    amount: 100,
    dataSource: { type: 'text', payload: 'Dolphins beat Jets 24-17' },
    attribution: { type: 'github', identifier: 'johnn' },
    visibility: 'public',
    createdAt: new Date().toISOString(),
    status: 'queued',
    ...overrides,
  };
}

function createWorldFeedSource(overrides: Partial<WorldFeedSource> = {}): WorldFeedSource {
  return {
    sourceId: 'reuters',
    name: 'Reuters',
    type: 'rss',
    categories: ['world', 'technology'],
    isActive: true,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('StimulusRouter', () => {
  let router: StimulusRouter;

  beforeEach(() => {
    router = new StimulusRouter();
    // Suppress console.log/error noise in test output
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. Subscribe / Unsubscribe / Pause / Resume
  // ══════════════════════════════════════════════════════════════════════════

  describe('subscribe / unsubscribe / pause / resume', () => {
    it('should register a subscription and deliver events', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);

      await router.ingestWorldFeed({
        headline: 'Test headline',
        category: 'world',
        sourceName: 'AP',
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].type).toBe('world_feed');
    });

    it('should remove a subscription via unsubscribe', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);
      router.unsubscribe('seed-1');

      await router.ingestWorldFeed({
        headline: 'Test',
        category: 'world',
        sourceName: 'AP',
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should stop delivering events when paused', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);
      router.pauseSubscription('seed-1');

      await router.ingestWorldFeed({
        headline: 'Paused event',
        category: 'world',
        sourceName: 'AP',
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should resume delivering events after resumeSubscription', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);
      router.pauseSubscription('seed-1');
      router.resumeSubscription('seed-1');

      await router.ingestWorldFeed({
        headline: 'Resumed event',
        category: 'world',
        sourceName: 'AP',
      });

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should be a no-op when pausing/resuming a non-existent subscription', () => {
      // These should not throw
      router.pauseSubscription('non-existent');
      router.resumeSubscription('non-existent');
    });

    it('should replace handler when subscribing the same seedId twice', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      router.subscribe('seed-1', handler1);
      router.subscribe('seed-1', handler2);

      await router.ingestWorldFeed({
        headline: 'Replaced',
        category: 'world',
        sourceName: 'AP',
      });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledOnce();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. ingestWorldFeed delivers to matching subscribers
  // ══════════════════════════════════════════════════════════════════════════

  describe('ingestWorldFeed', () => {
    it('should broadcast to all active subscribers with no filters', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      router.subscribe('seed-1', handler1);
      router.subscribe('seed-2', handler2);

      const event = await router.ingestWorldFeed({
        headline: 'Breaking: AI achieves AGI',
        category: 'technology',
        sourceName: 'Reuters',
      });

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
      expect(event.type).toBe('world_feed');
      expect(event.eventId).toBeDefined();
      expect(event.timestamp).toBeDefined();
      expect(event.source.providerId).toBe('Reuters');
      expect(event.source.verified).toBe(true);
    });

    it('should set priority to normal for world_feed events', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);

      const event = await router.ingestWorldFeed({
        headline: 'Test',
        category: 'world',
        sourceName: 'AP',
      });

      expect(event.priority).toBe('normal');
    });

    it('should use sourceId for providerId when provided', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);

      const event = await router.ingestWorldFeed({
        headline: 'Test',
        category: 'world',
        sourceName: 'AP',
        sourceId: 'custom-source-id',
      });

      expect(event.source.providerId).toBe('custom-source-id');
    });

    it('should return a StimulusEvent with correct payload structure', async () => {
      router.subscribe('seed-1', vi.fn());

      const event = await router.ingestWorldFeed({
        headline: 'AI Update',
        body: 'Detailed body text',
        category: 'technology',
        sourceName: 'Reuters',
        sourceUrl: 'https://reuters.com/article',
      });

      const payload = event.payload as WorldFeedPayload;
      expect(payload.type).toBe('world_feed');
      expect(payload.headline).toBe('AI Update');
      expect(payload.body).toBe('Detailed body text');
      expect(payload.category).toBe('technology');
      expect(payload.sourceName).toBe('Reuters');
      expect(payload.sourceUrl).toBe('https://reuters.com/article');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Type filtering (only gets subscribed types)
  // ══════════════════════════════════════════════════════════════════════════

  describe('type filtering', () => {
    it('should only deliver events matching the typeFilter', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler, { typeFilter: ['tip'] });

      // world_feed should be filtered out
      await router.ingestWorldFeed({
        headline: 'Filtered out',
        category: 'world',
        sourceName: 'AP',
      });
      expect(handler).not.toHaveBeenCalled();

      // tip should pass through
      await router.ingestTip(createTip());
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].type).toBe('tip');
    });

    it('should deliver all types when no typeFilter is set', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler); // no filter

      await router.ingestWorldFeed({
        headline: 'World feed',
        category: 'world',
        sourceName: 'AP',
      });
      await router.ingestTip(createTip());
      await router.emitCronTick('hourly', 1);

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('should support multiple type filters', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler, {
        typeFilter: ['world_feed', 'cron_tick'],
      });

      await router.ingestWorldFeed({
        headline: 'Feed',
        category: 'world',
        sourceName: 'AP',
      });
      await router.ingestTip(createTip());
      await router.emitCronTick('daily', 1);

      expect(handler).toHaveBeenCalledTimes(2);
      const types = handler.mock.calls.map((c: any) => c[0].type);
      expect(types).toEqual(['world_feed', 'cron_tick']);
    });

    it('should filter agent_reply events via typeFilter', async () => {
      const handler = vi.fn();
      router.subscribe('seed-target', handler, { typeFilter: ['agent_reply'] });

      await router.emitAgentReply('post-1', 'seed-author', 'Great post!', 'seed-target');

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].type).toBe('agent_reply');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Category filtering for world_feed
  // ══════════════════════════════════════════════════════════════════════════

  describe('category filtering', () => {
    it('should only deliver world_feed events with matching categories', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler, { categoryFilter: ['technology'] });

      await router.ingestWorldFeed({
        headline: 'Tech news',
        category: 'technology',
        sourceName: 'Wired',
      });
      expect(handler).toHaveBeenCalledOnce();

      await router.ingestWorldFeed({
        headline: 'Sports news',
        category: 'sports',
        sourceName: 'ESPN',
      });
      // Should NOT be called again — sports is filtered out
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should not apply category filter to non-world_feed events', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler, { categoryFilter: ['technology'] });

      // Tips don't have categories in the filter sense — should pass through
      await router.ingestTip(createTip());
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should support multiple category filters', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler, {
        categoryFilter: ['technology', 'science'],
      });

      await router.ingestWorldFeed({
        headline: 'Tech',
        category: 'technology',
        sourceName: 'Wired',
      });
      await router.ingestWorldFeed({
        headline: 'Science',
        category: 'science',
        sourceName: 'Nature',
      });
      await router.ingestWorldFeed({
        headline: 'Sports',
        category: 'sports',
        sourceName: 'ESPN',
      });

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should combine type and category filters', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler, {
        typeFilter: ['world_feed'],
        categoryFilter: ['technology'],
      });

      // Matching both filters — should deliver
      await router.ingestWorldFeed({
        headline: 'Tech',
        category: 'technology',
        sourceName: 'Wired',
      });
      expect(handler).toHaveBeenCalledOnce();

      // Wrong category — should not deliver
      await router.ingestWorldFeed({
        headline: 'Sports',
        category: 'sports',
        sourceName: 'ESPN',
      });
      expect(handler).toHaveBeenCalledOnce();

      // Wrong type — should not deliver (tip excluded by typeFilter)
      await router.ingestTip(createTip());
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. Target filtering (tip targeted to specific agent)
  // ══════════════════════════════════════════════════════════════════════════

  describe('target filtering', () => {
    it('should only deliver targeted tips to the specified agent', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      router.subscribe('seed-1', handler1);
      router.subscribe('seed-2', handler2);

      await router.ingestTip(createTip({ targetSeedIds: ['seed-1'] }));

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should deliver untargeted tips to all subscribers', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      router.subscribe('seed-1', handler1);
      router.subscribe('seed-2', handler2);

      await router.ingestTip(createTip({ targetSeedIds: undefined }));

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('should deliver targeted cron ticks only to specified agents', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();
      router.subscribe('seed-1', handler1);
      router.subscribe('seed-2', handler2);
      router.subscribe('seed-3', handler3);

      await router.emitCronTick('hourly', 5, ['seed-1', 'seed-3']);

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).not.toHaveBeenCalled();
      expect(handler3).toHaveBeenCalledOnce();
    });

    it('should broadcast cron ticks to all when no targetSeedIds', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      router.subscribe('seed-1', handler1);
      router.subscribe('seed-2', handler2);

      await router.emitCronTick('daily', 1);

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('should deliver agent replies only to the targeted agent', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      router.subscribe('seed-target', handler1);
      router.subscribe('seed-other', handler2);

      await router.emitAgentReply('post-1', 'seed-author', 'Reply content', 'seed-target');

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should deliver internal thought only to the targeted agent', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      router.subscribe('seed-target', handler1);
      router.subscribe('seed-other', handler2);

      await router.emitInternalThought('self-introduction', 'seed-target');

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should deliver post published to multiple target agents', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();
      router.subscribe('seed-1', handler1);
      router.subscribe('seed-2', handler2);
      router.subscribe('seed-3', handler3);

      await router.emitPostPublished(
        { postId: 'post-1', seedId: 'seed-author', content: 'My post' },
        ['seed-1', 'seed-3'],
      );

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).not.toHaveBeenCalled();
      expect(handler3).toHaveBeenCalledOnce();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 6. Event history + maxHistorySize trimming
  // ══════════════════════════════════════════════════════════════════════════

  describe('event history and maxHistorySize', () => {
    it('should store events in history', async () => {
      router.subscribe('seed-1', vi.fn());

      await router.ingestWorldFeed({
        headline: 'Event 1',
        category: 'world',
        sourceName: 'AP',
      });
      await router.ingestWorldFeed({
        headline: 'Event 2',
        category: 'tech',
        sourceName: 'Reuters',
      });

      const events = router.getRecentEvents();
      expect(events).toHaveLength(2);
      expect((events[0].payload as WorldFeedPayload).headline).toBe('Event 1');
      expect((events[1].payload as WorldFeedPayload).headline).toBe('Event 2');
    });

    it('should respect the limit parameter in getRecentEvents', async () => {
      router.subscribe('seed-1', vi.fn());

      for (let i = 0; i < 10; i++) {
        await router.ingestWorldFeed({
          headline: `Event ${i}`,
          category: 'world',
          sourceName: 'AP',
        });
      }

      const events = router.getRecentEvents(3);
      expect(events).toHaveLength(3);
      // Should be the 3 most recent
      expect((events[0].payload as WorldFeedPayload).headline).toBe('Event 7');
      expect((events[1].payload as WorldFeedPayload).headline).toBe('Event 8');
      expect((events[2].payload as WorldFeedPayload).headline).toBe('Event 9');
    });

    it('should trim history when maxHistorySize is exceeded', async () => {
      const smallRouter = new StimulusRouter({ maxHistorySize: 5 });
      smallRouter.subscribe('seed-1', vi.fn());

      for (let i = 0; i < 10; i++) {
        await smallRouter.ingestWorldFeed({
          headline: `Event ${i}`,
          category: 'world',
          sourceName: 'AP',
        });
      }

      const events = smallRouter.getRecentEvents(100);
      expect(events).toHaveLength(5);
      // Should keep only the last 5 events
      expect((events[0].payload as WorldFeedPayload).headline).toBe('Event 5');
      expect((events[4].payload as WorldFeedPayload).headline).toBe('Event 9');
    });

    it('should default maxHistorySize to 1000', async () => {
      // The default router should accept up to 1000 events without trimming.
      // We just verify we can store multiple events — testing the full 1000 would be slow.
      router.subscribe('seed-1', vi.fn());

      for (let i = 0; i < 20; i++) {
        await router.ingestWorldFeed({
          headline: `Event ${i}`,
          category: 'world',
          sourceName: 'AP',
        });
      }

      expect(router.getRecentEvents(100)).toHaveLength(20);
    });

    it('should store events even with no subscribers', async () => {
      // No subscribers — event should still be recorded in history
      await router.ingestWorldFeed({
        headline: 'No one is listening',
        category: 'world',
        sourceName: 'AP',
      });

      const events = router.getRecentEvents();
      expect(events).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 7. getStats
  // ══════════════════════════════════════════════════════════════════════════

  describe('getStats', () => {
    it('should return correct initial stats', () => {
      const stats = router.getStats();
      expect(stats).toEqual({
        activeSubscriptions: 0,
        totalSubscriptions: 0,
        totalEventsProcessed: 0,
        worldFeedSources: 0,
      });
    });

    it('should count active and total subscriptions', () => {
      router.subscribe('seed-1', vi.fn());
      router.subscribe('seed-2', vi.fn());
      router.subscribe('seed-3', vi.fn());
      router.pauseSubscription('seed-2');

      const stats = router.getStats();
      expect(stats.totalSubscriptions).toBe(3);
      expect(stats.activeSubscriptions).toBe(2);
    });

    it('should track total events processed', async () => {
      router.subscribe('seed-1', vi.fn());

      await router.ingestWorldFeed({
        headline: 'Event',
        category: 'world',
        sourceName: 'AP',
      });
      await router.ingestTip(createTip());

      const stats = router.getStats();
      expect(stats.totalEventsProcessed).toBe(2);
    });

    it('should count world feed sources', () => {
      router.registerWorldFeedSource(createWorldFeedSource({ sourceId: 'reuters' }));
      router.registerWorldFeedSource(createWorldFeedSource({ sourceId: 'ap' }));

      const stats = router.getStats();
      expect(stats.worldFeedSources).toBe(2);
    });

    it('should update stats after unsubscribe', () => {
      router.subscribe('seed-1', vi.fn());
      router.subscribe('seed-2', vi.fn());
      router.unsubscribe('seed-1');

      const stats = router.getStats();
      expect(stats.totalSubscriptions).toBe(1);
      expect(stats.activeSubscriptions).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 8. registerWorldFeedSource / listWorldFeedSources
  // ══════════════════════════════════════════════════════════════════════════

  describe('registerWorldFeedSource / listWorldFeedSources', () => {
    it('should register and list sources', () => {
      const source = createWorldFeedSource({
        sourceId: 'reuters',
        name: 'Reuters',
      });
      router.registerWorldFeedSource(source);

      const sources = router.listWorldFeedSources();
      expect(sources).toHaveLength(1);
      expect(sources[0].sourceId).toBe('reuters');
      expect(sources[0].name).toBe('Reuters');
    });

    it('should return empty array when no sources registered', () => {
      expect(router.listWorldFeedSources()).toEqual([]);
    });

    it('should support multiple sources', () => {
      router.registerWorldFeedSource(createWorldFeedSource({ sourceId: 'reuters', name: 'Reuters' }));
      router.registerWorldFeedSource(createWorldFeedSource({ sourceId: 'ap', name: 'Associated Press' }));
      router.registerWorldFeedSource(createWorldFeedSource({ sourceId: 'bbc', name: 'BBC News' }));

      const sources = router.listWorldFeedSources();
      expect(sources).toHaveLength(3);
      const ids = sources.map((s) => s.sourceId);
      expect(ids).toContain('reuters');
      expect(ids).toContain('ap');
      expect(ids).toContain('bbc');
    });

    it('should overwrite a source with the same sourceId', () => {
      router.registerWorldFeedSource(createWorldFeedSource({
        sourceId: 'reuters',
        name: 'Reuters v1',
      }));
      router.registerWorldFeedSource(createWorldFeedSource({
        sourceId: 'reuters',
        name: 'Reuters v2',
      }));

      const sources = router.listWorldFeedSources();
      expect(sources).toHaveLength(1);
      expect(sources[0].name).toBe('Reuters v2');
    });

    it('should return a copy (not a reference to internal map)', () => {
      router.registerWorldFeedSource(createWorldFeedSource({ sourceId: 'test' }));

      const sources1 = router.listWorldFeedSources();
      const sources2 = router.listWorldFeedSources();
      expect(sources1).not.toBe(sources2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 9. ingestChannelMessage with owner priority
  // ══════════════════════════════════════════════════════════════════════════

  describe('ingestChannelMessage', () => {
    const basePayload: Omit<ChannelMessagePayload, 'type'> = {
      platform: 'telegram',
      conversationId: 'chat-123',
      conversationType: 'direct',
      content: 'Hello agent!',
      senderName: 'John',
      senderPlatformId: 'user-456',
      messageId: 'msg-789',
      isOwner: false,
    };

    it('should deliver channel message to the target agent', async () => {
      const handler = vi.fn();
      router.subscribe('seed-target', handler);

      const event = await router.ingestChannelMessage(basePayload, 'seed-target');

      expect(handler).toHaveBeenCalledOnce();
      expect(event.type).toBe('channel_message');
      expect(event.targetSeedIds).toEqual(['seed-target']);
    });

    it('should auto-assign high priority for owner messages', async () => {
      const handler = vi.fn();
      router.subscribe('seed-target', handler);

      const event = await router.ingestChannelMessage(
        { ...basePayload, isOwner: true },
        'seed-target',
      );

      expect(event.priority).toBe('high');
    });

    it('should default to normal priority for non-owner messages', async () => {
      const handler = vi.fn();
      router.subscribe('seed-target', handler);

      const event = await router.ingestChannelMessage(
        { ...basePayload, isOwner: false },
        'seed-target',
      );

      expect(event.priority).toBe('normal');
    });

    it('should allow explicit priority override', async () => {
      const handler = vi.fn();
      router.subscribe('seed-target', handler);

      const event = await router.ingestChannelMessage(
        { ...basePayload, isOwner: false },
        'seed-target',
        'breaking',
      );

      expect(event.priority).toBe('breaking');
    });

    it('should allow explicit priority override even for owner messages', async () => {
      const handler = vi.fn();
      router.subscribe('seed-target', handler);

      const event = await router.ingestChannelMessage(
        { ...basePayload, isOwner: true },
        'seed-target',
        'low',
      );

      expect(event.priority).toBe('low');
    });

    it('should set source.verified to true for owner messages', async () => {
      router.subscribe('seed-target', vi.fn());

      const event = await router.ingestChannelMessage(
        { ...basePayload, isOwner: true },
        'seed-target',
      );

      expect(event.source.verified).toBe(true);
    });

    it('should set source.verified to false for non-owner messages', async () => {
      router.subscribe('seed-target', vi.fn());

      const event = await router.ingestChannelMessage(
        { ...basePayload, isOwner: false },
        'seed-target',
      );

      expect(event.source.verified).toBe(false);
    });

    it('should construct the correct providerId from platform and sender', async () => {
      router.subscribe('seed-target', vi.fn());

      const event = await router.ingestChannelMessage(
        { ...basePayload, platform: 'discord', senderPlatformId: 'user-xyz' },
        'seed-target',
      );

      expect(event.source.providerId).toBe('channel:discord:user-xyz');
    });

    it('should not deliver to non-target agents', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      router.subscribe('seed-target', handler1);
      router.subscribe('seed-other', handler2);

      await router.ingestChannelMessage(basePayload, 'seed-target');

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should include full payload fields in delivered event', async () => {
      const handler = vi.fn();
      router.subscribe('seed-target', handler);

      await router.ingestChannelMessage(
        {
          platform: 'discord',
          conversationId: 'guild-abc#channel-123',
          conversationType: 'group',
          content: 'Hello from Discord!',
          senderName: 'Alice',
          senderPlatformId: 'discord-user-001',
          messageId: 'discord-msg-999',
          isOwner: false,
        },
        'seed-target',
      );

      const payload = handler.mock.calls[0][0].payload as ChannelMessagePayload;
      expect(payload.type).toBe('channel_message');
      expect(payload.platform).toBe('discord');
      expect(payload.conversationId).toBe('guild-abc#channel-123');
      expect(payload.conversationType).toBe('group');
      expect(payload.content).toBe('Hello from Discord!');
      expect(payload.senderName).toBe('Alice');
      expect(payload.senderPlatformId).toBe('discord-user-001');
      expect(payload.messageId).toBe('discord-msg-999');
      expect(payload.isOwner).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 10. Error handling in handler doesn't break other deliveries
  // ══════════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    it('should deliver to other subscribers even if one handler throws', async () => {
      const failHandler = vi.fn().mockImplementation(() => {
        throw new Error('Handler exploded!');
      });
      const successHandler = vi.fn();

      router.subscribe('seed-fail', failHandler);
      router.subscribe('seed-success', successHandler);

      // Should NOT throw
      await router.ingestWorldFeed({
        headline: 'Event',
        category: 'world',
        sourceName: 'AP',
      });

      expect(failHandler).toHaveBeenCalledOnce();
      expect(successHandler).toHaveBeenCalledOnce();
    });

    it('should handle async handler rejections without breaking delivery', async () => {
      const failHandler = vi.fn().mockRejectedValue(new Error('Async failure'));
      const successHandler = vi.fn();

      router.subscribe('seed-fail', failHandler);
      router.subscribe('seed-success', successHandler);

      await router.ingestWorldFeed({
        headline: 'Event',
        category: 'world',
        sourceName: 'AP',
      });

      expect(failHandler).toHaveBeenCalledOnce();
      expect(successHandler).toHaveBeenCalledOnce();
    });

    it('should log errors to console.error', async () => {
      const errorSpy = vi.spyOn(console, 'error');
      const failHandler = vi.fn().mockImplementation(() => {
        throw new Error('kaboom');
      });
      router.subscribe('seed-fail', failHandler);

      await router.ingestWorldFeed({
        headline: 'Event',
        category: 'world',
        sourceName: 'AP',
      });

      expect(errorSpy).toHaveBeenCalled();
      const errorCall = errorSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('Error delivering event'),
      );
      expect(errorCall).toBeDefined();
    });

    it('should still record event in history when handler fails', async () => {
      const failHandler = vi.fn().mockImplementation(() => {
        throw new Error('fail');
      });
      router.subscribe('seed-fail', failHandler);

      await router.ingestWorldFeed({
        headline: 'Recorded despite failure',
        category: 'world',
        sourceName: 'AP',
      });

      const events = router.getRecentEvents();
      expect(events).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Additional: emitAgentReply, emitInternalThought, emitPostPublished,
  //             emitCronTick, ingestTip, dispatchExternalEvent
  // ══════════════════════════════════════════════════════════════════════════

  describe('emitAgentReply', () => {
    it('should create event with correct payload and priority', async () => {
      const handler = vi.fn();
      router.subscribe('seed-target', handler);

      const event = await router.emitAgentReply(
        'post-42', 'seed-author', 'I disagree!', 'seed-target', 'high', 'dissent',
      );

      expect(event.type).toBe('agent_reply');
      expect(event.priority).toBe('high');
      expect(event.source.providerId).toBe('agent:seed-author');
      expect(event.source.verified).toBe(true);

      const payload = event.payload as any;
      expect(payload.replyToPostId).toBe('post-42');
      expect(payload.replyFromSeedId).toBe('seed-author');
      expect(payload.content).toBe('I disagree!');
      expect(payload.replyContext).toBe('dissent');
    });

    it('should use default priority (low) when none specified', async () => {
      const handler = vi.fn();
      router.subscribe('seed-target', handler);

      const event = await router.emitAgentReply(
        'post-1', 'seed-author', 'content', 'seed-target',
      );

      // createEvent sets default priority to 'low' for agent_reply; no override applied
      expect(event.priority).toBe('low');
    });

    it('should omit replyContext when not provided', async () => {
      const handler = vi.fn();
      router.subscribe('seed-target', handler);

      const event = await router.emitAgentReply(
        'post-1', 'seed-author', 'content', 'seed-target',
      );

      const payload = event.payload as any;
      expect(payload.replyContext).toBeUndefined();
    });
  });

  describe('emitInternalThought', () => {
    it('should create an internal_thought event with specified priority', async () => {
      const handler = vi.fn();
      router.subscribe('seed-target', handler);

      const event = await router.emitInternalThought('existential-crisis', 'seed-target', 'high');

      expect(event.type).toBe('internal_thought');
      expect(event.priority).toBe('high');
      expect(event.targetSeedIds).toEqual(['seed-target']);
      expect(event.source.providerId).toBe('system');
      expect((event.payload as any).topic).toBe('existential-crisis');
    });

    it('should default to normal priority', async () => {
      const handler = vi.fn();
      router.subscribe('seed-target', handler);

      const event = await router.emitInternalThought('intro', 'seed-target');

      expect(event.priority).toBe('normal');
    });
  });

  describe('emitPostPublished', () => {
    it('should route to multiple target agents with correct payload', async () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      router.subscribe('seed-a', h1);
      router.subscribe('seed-b', h2);

      const event = await router.emitPostPublished(
        { postId: 'post-99', seedId: 'seed-author', content: 'Hello world' },
        ['seed-a', 'seed-b'],
        'high',
      );

      expect(event.type).toBe('agent_reply');
      expect(event.priority).toBe('high');
      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();

      const payload = event.payload as any;
      expect(payload.replyToPostId).toBe('post-99');
      expect(payload.replyFromSeedId).toBe('seed-author');
      expect(payload.content).toBe('Hello world');
    });
  });

  describe('emitCronTick', () => {
    it('should create a cron_tick event with correct payload', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);

      const event = await router.emitCronTick('every-15-min', 42);

      expect(event.type).toBe('cron_tick');
      expect(event.source.providerId).toBe('cron');
      expect(event.source.verified).toBe(true);

      const payload = event.payload as any;
      expect(payload.scheduleName).toBe('every-15-min');
      expect(payload.tickCount).toBe(42);
    });
  });

  describe('ingestTip', () => {
    it('should create event with correct tip payload', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);

      const tip = createTip({
        tipId: 'tip-abc',
        dataSource: { type: 'url', payload: 'https://example.com/article' },
        attribution: { type: 'wallet', identifier: '0xDEAD' },
      });

      const event = await router.ingestTip(tip);

      expect(event.type).toBe('tip');
      expect(event.source.providerId).toBe('tip:wallet:0xDEAD');
      expect(event.source.verified).toBe(false);

      const payload = event.payload as any;
      expect(payload.tipId).toBe('tip-abc');
      expect(payload.content).toBe('https://example.com/article');
      expect(payload.dataSourceType).toBe('url');
    });

    it('should handle anonymous attribution', async () => {
      router.subscribe('seed-1', vi.fn());

      const tip = createTip({
        attribution: { type: 'anonymous' },
      });

      const event = await router.ingestTip(tip);
      expect(event.source.providerId).toBe('tip:anonymous:anonymous');
    });
  });

  describe('dispatchExternalEvent', () => {
    it('should deliver a pre-constructed event to matching subscribers', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);

      const externalEvent: StimulusEvent = {
        eventId: 'ext-event-001',
        type: 'world_feed',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: {
          type: 'world_feed',
          headline: 'External event',
          category: 'world',
          sourceName: 'External',
        },
        priority: 'breaking',
        source: { providerId: 'external', verified: true },
      };

      await router.dispatchExternalEvent(externalEvent);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0]).toBe(externalEvent);
    });

    it('should preserve eventId and timestamp from external event', async () => {
      router.subscribe('seed-1', vi.fn());

      const externalEvent: StimulusEvent = {
        eventId: 'preserved-id',
        type: 'tip',
        timestamp: '2025-06-15T12:00:00.000Z',
        payload: {
          type: 'tip',
          content: 'Preserved',
          dataSourceType: 'text',
          tipId: 'tip-ext',
          attribution: { type: 'anonymous' },
        },
        priority: 'high',
        source: { providerId: 'external-system', verified: true },
      };

      await router.dispatchExternalEvent(externalEvent);

      const events = router.getRecentEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventId).toBe('preserved-id');
      expect(events[0].timestamp).toBe('2025-06-15T12:00:00.000Z');
    });

    it('should respect target filtering for external events', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      router.subscribe('seed-1', handler1);
      router.subscribe('seed-2', handler2);

      const externalEvent: StimulusEvent = {
        eventId: 'targeted-ext',
        type: 'tip',
        timestamp: new Date().toISOString(),
        payload: {
          type: 'tip',
          content: 'Targeted',
          dataSourceType: 'text',
          tipId: 'tip-targeted',
          attribution: { type: 'anonymous' },
        },
        priority: 'normal',
        targetSeedIds: ['seed-1'],
        source: { providerId: 'ext', verified: false },
      };

      await router.dispatchExternalEvent(externalEvent);

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).not.toHaveBeenCalled();
    });
  });
});
