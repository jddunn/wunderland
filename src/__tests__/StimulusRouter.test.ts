/**
 * @fileoverview Tests for StimulusRouter
 * @module wunderland/__tests__/StimulusRouter.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StimulusRouter } from '../social/StimulusRouter.js';
import type { StimulusEvent, Tip } from '../social/types.js';

describe('StimulusRouter', () => {
  let router: StimulusRouter;

  beforeEach(() => {
    router = new StimulusRouter();
  });

  describe('subscribe / unsubscribe', () => {
    it('should subscribe an agent', () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);
      expect(router.getStats().totalSubscriptions).toBe(1);
      expect(router.getStats().activeSubscriptions).toBe(1);
    });

    it('should unsubscribe an agent', () => {
      router.subscribe('seed-1', vi.fn());
      router.unsubscribe('seed-1');
      expect(router.getStats().totalSubscriptions).toBe(0);
    });
  });

  describe('pause / resume', () => {
    it('should pause a subscription', () => {
      router.subscribe('seed-1', vi.fn());
      router.pauseSubscription('seed-1');
      expect(router.getStats().activeSubscriptions).toBe(0);
      expect(router.getStats().totalSubscriptions).toBe(1);
    });

    it('should resume a paused subscription', () => {
      router.subscribe('seed-1', vi.fn());
      router.pauseSubscription('seed-1');
      router.resumeSubscription('seed-1');
      expect(router.getStats().activeSubscriptions).toBe(1);
    });
  });

  describe('ingestWorldFeed', () => {
    it('should deliver world feed events to subscribers', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);

      await router.ingestWorldFeed({
        headline: 'Test headline',
        category: 'technology',
        sourceName: 'Reuters',
      });

      expect(handler).toHaveBeenCalledTimes(1);
      const event: StimulusEvent = handler.mock.calls[0][0];
      expect(event.type).toBe('world_feed');
      expect(event.payload.type).toBe('world_feed');
    });

    it('should return the created event', async () => {
      router.subscribe('seed-1', vi.fn());
      const event = await router.ingestWorldFeed({
        headline: 'Test',
        category: 'tech',
        sourceName: 'Test Source',
      });

      expect(event.eventId).toBeDefined();
      expect(event.type).toBe('world_feed');
      expect(event.timestamp).toBeDefined();
    });

    it('should filter by type', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler, { typeFilter: ['tip'] });

      await router.ingestWorldFeed({
        headline: 'Test',
        category: 'tech',
        sourceName: 'Test',
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should filter by category', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler, { categoryFilter: ['finance'] });

      await router.ingestWorldFeed({
        headline: 'Tech news',
        category: 'technology',
        sourceName: 'Test',
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should deliver when category matches', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler, { categoryFilter: ['technology'] });

      await router.ingestWorldFeed({
        headline: 'Tech news',
        category: 'technology',
        sourceName: 'Test',
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('ingestTip', () => {
    const sampleTip: Tip = {
      tipId: 'tip-123',
      amount: 100,
      dataSource: { type: 'text', payload: 'Interesting data point' },
      attribution: { type: 'github', identifier: 'johnn' },
      visibility: 'public',
      createdAt: new Date().toISOString(),
      status: 'queued',
    };

    it('should deliver tip events to all subscribers', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);

      await router.ingestTip(sampleTip);
      expect(handler).toHaveBeenCalledTimes(1);

      const event: StimulusEvent = handler.mock.calls[0][0];
      expect(event.type).toBe('tip');
      expect(event.payload.type).toBe('tip');
    });

    it('should deliver tip to targeted agents only', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      router.subscribe('seed-1', handler1);
      router.subscribe('seed-2', handler2);

      await router.ingestTip({
        ...sampleTip,
        targetSeedIds: ['seed-1'],
      });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).not.toHaveBeenCalled();
    });
  });

  describe('emitCronTick', () => {
    it('should deliver cron tick to subscribers', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);

      await router.emitCronTick('hourly', 42);
      expect(handler).toHaveBeenCalledTimes(1);

      const event: StimulusEvent = handler.mock.calls[0][0];
      expect(event.type).toBe('cron_tick');
    });
  });

  describe('emitAgentReply', () => {
    it('should deliver agent reply to target agent', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      router.subscribe('seed-1', handler1);
      router.subscribe('seed-2', handler2);

      await router.emitAgentReply('post-1', 'seed-1', 'Reply content', 'seed-2');

      // Only target agent should receive
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  describe('World Feed Sources', () => {
    it('should register a world feed source', () => {
      router.registerWorldFeedSource({
        sourceId: 'reuters',
        name: 'Reuters',
        type: 'rss',
        categories: ['world', 'tech'],
        isActive: true,
      });

      expect(router.listWorldFeedSources()).toHaveLength(1);
      expect(router.listWorldFeedSources()[0].sourceId).toBe('reuters');
    });

    it('should list multiple sources', () => {
      router.registerWorldFeedSource({
        sourceId: 'reuters',
        name: 'Reuters',
        type: 'rss',
        categories: ['world'],
        isActive: true,
      });
      router.registerWorldFeedSource({
        sourceId: 'custom-api',
        name: 'Custom API',
        type: 'api',
        categories: ['finance'],
        isActive: true,
      });

      expect(router.listWorldFeedSources()).toHaveLength(2);
    });
  });

  describe('Event history', () => {
    it('should store event history', async () => {
      router.subscribe('seed-1', vi.fn());
      await router.ingestWorldFeed({ headline: 'A', category: 'tech', sourceName: 'Test' });
      await router.ingestWorldFeed({ headline: 'B', category: 'tech', sourceName: 'Test' });

      const events = router.getRecentEvents();
      expect(events).toHaveLength(2);
    });

    it('should limit history to max size', async () => {
      const smallRouter = new StimulusRouter({ maxHistorySize: 3 });
      smallRouter.subscribe('seed-1', vi.fn());

      for (let i = 0; i < 5; i++) {
        await smallRouter.ingestWorldFeed({ headline: `Item ${i}`, category: 'tech', sourceName: 'T' });
      }

      expect(smallRouter.getRecentEvents()).toHaveLength(3);
    });

    it('should return limited recent events', async () => {
      router.subscribe('seed-1', vi.fn());
      for (let i = 0; i < 10; i++) {
        await router.ingestWorldFeed({ headline: `Item ${i}`, category: 'tech', sourceName: 'T' });
      }

      const recent = router.getRecentEvents(3);
      expect(recent).toHaveLength(3);
    });
  });

  describe('Paused subscriptions', () => {
    it('should not deliver to paused subscribers', async () => {
      const handler = vi.fn();
      router.subscribe('seed-1', handler);
      router.pauseSubscription('seed-1');

      await router.ingestWorldFeed({ headline: 'Test', category: 'tech', sourceName: 'T' });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should not throw if handler throws', async () => {
      router.subscribe('seed-1', () => { throw new Error('Handler error'); });
      router.subscribe('seed-2', vi.fn());

      // Should not throw
      await router.ingestWorldFeed({ headline: 'Test', category: 'tech', sourceName: 'T' });
    });
  });

  describe('getStats', () => {
    it('should return router statistics', async () => {
      router.subscribe('seed-1', vi.fn());
      router.subscribe('seed-2', vi.fn());
      router.pauseSubscription('seed-2');

      router.registerWorldFeedSource({
        sourceId: 's1',
        name: 'S1',
        type: 'rss',
        categories: [],
        isActive: true,
      });

      await router.ingestWorldFeed({ headline: 'A', category: 'tech', sourceName: 'T' });

      const stats = router.getStats();
      expect(stats.activeSubscriptions).toBe(1);
      expect(stats.totalSubscriptions).toBe(2);
      expect(stats.totalEventsProcessed).toBe(1);
      expect(stats.worldFeedSources).toBe(1);
    });
  });
});
