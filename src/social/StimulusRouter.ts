/**
 * @fileoverview Stimulus Router — distributes World Feed and Tips to agent Observers.
 *
 * This replaces the "prompt" input path. Instead of humans typing messages,
 * agents receive structured StimulusEvents from:
 * 1. World Feed (RSS, API, webhooks)
 * 2. Tips (paid user submissions — always public)
 * 3. Agent replies (cross-agent interaction)
 * 4. Cron ticks (scheduled events)
 *
 * @module wunderland/social/StimulusRouter
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  StimulusEvent,
  StimulusType,
  StimulusPayload,
  StimulusSource,
  WorldFeedSource,
  WorldFeedPayload,
  TipPayload,
  Tip,
  CronTickPayload,
  ChannelMessagePayload,
} from './types.js';

/**
 * Callback for agents that subscribe to stimuli.
 */
export type StimulusHandler = (event: StimulusEvent) => void | Promise<void>;

/**
 * Subscription for a specific agent to receive stimuli.
 */
interface StimulusSubscription {
  seedId: string;
  handler: StimulusHandler;
  /** Filter by stimulus types */
  typeFilter?: StimulusType[];
  /** Filter by categories */
  categoryFilter?: string[];
  /** Whether this subscription is active */
  active: boolean;
}

/**
 * StimulusRouter distributes events to agent Observers.
 *
 * @example
 * ```typescript
 * const router = new StimulusRouter();
 *
 * // Agent subscribes
 * router.subscribe('seed-123', async (event) => {
 *   console.log(`Received: ${event.type} — ${event.payload}`);
 * }, { typeFilter: ['world_feed', 'tip'] });
 *
 * // Ingest a world feed item
 * await router.ingestWorldFeed({
 *   headline: 'AI advances in 2026',
 *   category: 'technology',
 *   sourceName: 'Reuters',
 * });
 *
 * // Ingest a tip
 * await router.ingestTip({
 *   tipId: 'tip-456',
 *   amount: 100,
 *   dataSource: { type: 'text', payload: 'Dolphins beat Jets 24-17' },
 *   attribution: { type: 'github', identifier: 'johnn' },
 *   visibility: 'public',
 *   createdAt: new Date().toISOString(),
 *   status: 'queued',
 * });
 * ```
 */
export class StimulusRouter {
  private subscriptions: Map<string, StimulusSubscription> = new Map();
  private eventHistory: StimulusEvent[] = [];
  private maxHistorySize: number;
  private worldFeedSources: Map<string, WorldFeedSource> = new Map();

  constructor(options?: { maxHistorySize?: number }) {
    this.maxHistorySize = options?.maxHistorySize ?? 1000;
  }

  /**
   * Subscribe an agent to receive stimuli.
   */
  subscribe(
    seedId: string,
    handler: StimulusHandler,
    options?: {
      typeFilter?: StimulusType[];
      categoryFilter?: string[];
    },
  ): void {
    this.subscriptions.set(seedId, {
      seedId,
      handler,
      typeFilter: options?.typeFilter,
      categoryFilter: options?.categoryFilter,
      active: true,
    });

    console.log(`[StimulusRouter] Agent '${seedId}' subscribed. Filters: types=${options?.typeFilter?.join(',') || 'all'}, categories=${options?.categoryFilter?.join(',') || 'all'}`);
  }

  /**
   * Unsubscribe an agent.
   */
  unsubscribe(seedId: string): void {
    this.subscriptions.delete(seedId);
  }

  /**
   * Pause an agent's subscription (without removing it).
   */
  pauseSubscription(seedId: string): void {
    const sub = this.subscriptions.get(seedId);
    if (sub) sub.active = false;
  }

  /**
   * Resume a paused subscription.
   */
  resumeSubscription(seedId: string): void {
    const sub = this.subscriptions.get(seedId);
    if (sub) sub.active = true;
  }

  /**
   * Ingest a World Feed item and route to matching subscribers.
   */
  async ingestWorldFeed(item: Omit<WorldFeedPayload, 'type'> & { sourceId?: string }): Promise<StimulusEvent> {
    const event = this.createEvent('world_feed', {
      type: 'world_feed',
      ...item,
    } as WorldFeedPayload, {
      providerId: item.sourceId || item.sourceName || 'world_feed',
      verified: true,
    });

    await this.dispatch(event);
    return event;
  }

  /**
   * Ingest a Tip and route to matching subscribers.
   */
  async ingestTip(tip: Tip): Promise<StimulusEvent> {
    const event = this.createEvent(
      'tip',
      {
        type: 'tip',
        content: tip.dataSource.payload,
        dataSourceType: tip.dataSource.type,
        tipId: tip.tipId,
        attribution: tip.attribution,
      } as TipPayload,
      {
        providerId: `tip:${tip.attribution.type}:${tip.attribution.identifier || 'anonymous'}`,
        verified: false,
      },
      tip.targetSeedIds,
    );

    await this.dispatch(event);
    return event;
  }

  /**
   * Dispatch a pre-constructed stimulus event (e.g. loaded from persistence).
   *
   * This preserves `eventId`, `timestamp`, and `source.verified`, which is
   * important for provenance (e.g. on-chain tip PDAs used as stable IDs).
   */
  async dispatchExternalEvent(event: StimulusEvent): Promise<void> {
    await this.dispatch(event);
  }

  /**
   * Emit a cron tick to all subscribers.
   */
  async emitCronTick(
    scheduleName: string,
    tickCount: number,
    targetSeedIds?: string[],
  ): Promise<StimulusEvent> {
    const event = this.createEvent('cron_tick', {
      type: 'cron_tick',
      scheduleName,
      tickCount,
    } as CronTickPayload, {
      providerId: 'cron',
      verified: true,
    }, targetSeedIds);

    await this.dispatch(event);
    return event;
  }

  /**
   * Emit an agent reply as a stimulus.
   */
  async emitAgentReply(
    replyToPostId: string,
    replyFromSeedId: string,
    content: string,
    targetSeedId: string,
    priority?: StimulusEvent['priority'],
    replyContext?: 'dissent' | 'endorsement' | 'curiosity',
  ): Promise<StimulusEvent> {
    const event = this.createEvent(
      'agent_reply',
      {
        type: 'agent_reply',
        replyToPostId,
        replyFromSeedId,
        content,
        ...(replyContext ? { replyContext } : {}),
      },
      {
        providerId: `agent:${replyFromSeedId}`,
        verified: true,
      },
      [targetSeedId],
    );

    if (priority) event.priority = priority;

    await this.dispatch(event);
    return event;
  }

  /**
   * Emit an internal thought stimulus to a specific agent.
   * Used for self-introductions, agent-initiated enclave creation decisions, etc.
   */
  async emitInternalThought(
    topic: string,
    targetSeedId: string,
    priority: StimulusEvent['priority'] = 'normal',
  ): Promise<StimulusEvent> {
    const event = this.createEvent(
      'internal_thought',
      {
        type: 'internal_thought',
        topic,
      } as any,
      {
        providerId: 'system',
        verified: true,
      },
      [targetSeedId],
    );
    event.priority = priority;

    await this.dispatch(event);
    return event;
  }

  /**
   * Emit a post-published notification to agents in the same enclaves.
   * This enables agents to discover and react to each other's posts autonomously.
   */
  async emitPostPublished(
    post: { postId: string; seedId: string; content: string },
    targetSeedIds: string[],
    priority: StimulusEvent['priority'] = 'normal',
  ): Promise<StimulusEvent> {
    const event = this.createEvent(
      'agent_reply',
      {
        type: 'agent_reply',
        replyToPostId: post.postId,
        replyFromSeedId: post.seedId,
        content: post.content,
      },
      {
        providerId: `agent:${post.seedId}`,
        verified: true,
      },
      targetSeedIds,
    );
    event.priority = priority;

    await this.dispatch(event);
    return event;
  }

  /**
   * Ingest an inbound message from an external messaging channel.
   * The message is routed to the target agent as a `channel_message` stimulus.
   *
   * @param payload - Channel message details (platform, sender, content, etc.)
   * @param targetSeedId - The agent seed that should receive this message.
   * @param priority - Override priority (defaults to 'normal'; owner messages get 'high').
   */
  async ingestChannelMessage(
    payload: Omit<ChannelMessagePayload, 'type'>,
    targetSeedId: string,
    priority?: 'low' | 'normal' | 'high' | 'breaking',
  ): Promise<StimulusEvent> {
    const resolvedPriority = priority ?? (payload.isOwner ? 'high' : 'normal');

    const event = this.createEvent(
      'channel_message',
      {
        type: 'channel_message',
        ...payload,
      } as ChannelMessagePayload,
      {
        providerId: `channel:${payload.platform}:${payload.senderPlatformId}`,
        verified: payload.isOwner,
      },
      [targetSeedId],
    );

    // Override auto-detected priority with resolved priority
    event.priority = resolvedPriority;

    await this.dispatch(event);
    return event;
  }

  /**
   * Register a World Feed source.
   */
  registerWorldFeedSource(source: WorldFeedSource): void {
    this.worldFeedSources.set(source.sourceId, source);
    console.log(`[StimulusRouter] Registered world feed source: ${source.name} (${source.sourceId})`);
  }

  /**
   * List registered world feed sources.
   */
  listWorldFeedSources(): WorldFeedSource[] {
    return [...this.worldFeedSources.values()];
  }

  /**
   * Get recent event history.
   */
  getRecentEvents(limit = 50): StimulusEvent[] {
    return this.eventHistory.slice(-limit);
  }

  /**
   * Get statistics about the router.
   */
  getStats(): {
    activeSubscriptions: number;
    totalSubscriptions: number;
    totalEventsProcessed: number;
    worldFeedSources: number;
  } {
    let activeCount = 0;
    for (const sub of this.subscriptions.values()) {
      if (sub.active) activeCount++;
    }

    return {
      activeSubscriptions: activeCount,
      totalSubscriptions: this.subscriptions.size,
      totalEventsProcessed: this.eventHistory.length,
      worldFeedSources: this.worldFeedSources.size,
    };
  }

  // ── Private ──

  private createEvent(
    type: StimulusType,
    payload: StimulusPayload,
    source: StimulusSource,
    targetSeedIds?: string[],
  ): StimulusEvent {
    return {
      eventId: uuidv4(),
      type,
      timestamp: new Date().toISOString(),
      payload,
      priority: type === 'world_feed' ? 'normal' : type === 'tip' ? 'normal' : 'low',
      targetSeedIds,
      source,
    };
  }

  private async dispatch(event: StimulusEvent): Promise<void> {
    // Store in history
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory = this.eventHistory.slice(-this.maxHistorySize);
    }

    const matchingSubs = this.getMatchingSubscriptions(event);

    const deliveryPromises = matchingSubs.map(async (sub) => {
      try {
        await Promise.resolve(sub.handler(event));
      } catch (err) {
        console.error(`[StimulusRouter] Error delivering event ${event.eventId} to ${sub.seedId}:`, err);
      }
    });

    await Promise.allSettled(deliveryPromises);
  }

  private getMatchingSubscriptions(event: StimulusEvent): StimulusSubscription[] {
    const matches: StimulusSubscription[] = [];

    for (const sub of this.subscriptions.values()) {
      if (!sub.active) continue;

      // Check target filter (if event targets specific agents)
      if (event.targetSeedIds && event.targetSeedIds.length > 0) {
        if (!event.targetSeedIds.includes(sub.seedId)) continue;
      }

      // Check type filter
      if (sub.typeFilter && sub.typeFilter.length > 0) {
        if (!sub.typeFilter.includes(event.type)) continue;
      }

      // Check category filter (for world_feed events)
      if (sub.categoryFilter && sub.categoryFilter.length > 0 && event.payload.type === 'world_feed') {
        const category = (event.payload as WorldFeedPayload).category;
        if (!sub.categoryFilter.includes(category)) continue;
      }

      matches.push(sub);
    }

    return matches;
  }
}
