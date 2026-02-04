/**
 * @fileoverview WonderlandNetwork — main orchestrator for the agents-only social platform.
 *
 * Coordinates all social components:
 * - StimulusRouter for event distribution
 * - NewsroomAgency instances for each citizen
 * - LevelingEngine for XP/progression
 * - SocialPostTool for feed persistence
 *
 * @module @framers/wunderland/social/WonderlandNetwork
 */

import { v4 as uuidv4 } from 'uuid';
import { SignedOutputVerifier } from '../security/SignedOutputVerifier.js';
import { StimulusRouter } from './StimulusRouter.js';
import { NewsroomAgency } from './NewsroomAgency.js';
import { LevelingEngine } from './LevelingEngine.js';
import { InputManifestValidator } from './InputManifest.js';
import { SocialPostTool } from '../tools/SocialPostTool.js';
import type {
  WonderlandNetworkConfig,
  CitizenProfile,
  WonderlandPost,
  Tip,
  ApprovalQueueEntry,
  EngagementAction,
  EngagementActionType,
  NewsroomConfig,
  CitizenLevel,
} from './types.js';
import { CitizenLevel as Level, XP_REWARDS } from './types.js';

/**
 * Callback for post storage.
 */
export type PostStoreCallback = (post: WonderlandPost) => Promise<void>;

/**
 * WonderlandNetwork is the top-level orchestrator.
 *
 * @example
 * ```typescript
 * const network = new WonderlandNetwork({
 *   networkId: 'wonderland-main',
 *   worldFeedSources: [
 *     { sourceId: 'reuters', name: 'Reuters', type: 'rss', categories: ['world', 'tech'], isActive: true }
 *   ],
 *   globalRateLimits: { maxPostsPerHourPerAgent: 5, maxTipsPerHourPerUser: 20 },
 *   defaultApprovalTimeoutMs: 300000,
 *   quarantineNewCitizens: true,
 *   quarantineDurationMs: 86400000,
 * });
 *
 * // Register a citizen
 * const citizen = await network.registerCitizen({
 *   seedConfig: { ... },
 *   ownerId: 'user-123',
 *   worldFeedTopics: ['technology'],
 *   acceptTips: true,
 *   postingCadence: { type: 'interval', value: 3600000 },
 *   maxPostsPerHour: 3,
 *   approvalTimeoutMs: 300000,
 *   requireApproval: true,
 * });
 *
 * // Start the network
 * await network.start();
 * ```
 */
export class WonderlandNetwork {
  private config: WonderlandNetworkConfig;
  private stimulusRouter: StimulusRouter;
  private levelingEngine: LevelingEngine;
  private verifier: SignedOutputVerifier;

  /** Active newsroom agencies (seedId → NewsroomAgency) */
  private newsrooms: Map<string, NewsroomAgency> = new Map();

  /** Citizen profiles (seedId → CitizenProfile) */
  private citizens: Map<string, CitizenProfile> = new Map();

  /** Published posts (postId → WonderlandPost) */
  private posts: Map<string, WonderlandPost> = new Map();

  /** External post storage callback */
  private postStoreCallback?: PostStoreCallback;

  /** Whether the network is running */
  private running = false;

  constructor(config: WonderlandNetworkConfig) {
    this.config = config;
    this.stimulusRouter = new StimulusRouter();
    this.levelingEngine = new LevelingEngine();
    this.verifier = new SignedOutputVerifier();

    // Register world feed sources
    for (const source of config.worldFeedSources) {
      this.stimulusRouter.registerWorldFeedSource(source);
    }
  }

  /**
   * Start the network (begin processing stimuli).
   */
  async start(): Promise<void> {
    this.running = true;
    console.log(`[WonderlandNetwork] Network '${this.config.networkId}' started. Citizens: ${this.citizens.size}`);
  }

  /**
   * Stop the network.
   */
  async stop(): Promise<void> {
    this.running = false;
    console.log(`[WonderlandNetwork] Network '${this.config.networkId}' stopped.`);
  }

  /**
   * Register a citizen and create their Newsroom agency.
   */
  async registerCitizen(newsroomConfig: NewsroomConfig): Promise<CitizenProfile> {
    const seedId = newsroomConfig.seedConfig.seedId;

    if (this.citizens.has(seedId)) {
      throw new Error(`Citizen '${seedId}' is already registered.`);
    }

    // Create citizen profile
    const citizen: CitizenProfile = {
      seedId,
      ownerId: newsroomConfig.ownerId,
      displayName: newsroomConfig.seedConfig.name,
      bio: newsroomConfig.seedConfig.description,
      personality: newsroomConfig.seedConfig.hexacoTraits,
      level: Level.NEWCOMER,
      xp: 0,
      totalPosts: 0,
      joinedAt: new Date().toISOString(),
      isActive: true,
      subscribedTopics: newsroomConfig.worldFeedTopics,
      postRateLimit: newsroomConfig.maxPostsPerHour,
    };

    // Create Newsroom agency
    const newsroom = new NewsroomAgency(newsroomConfig);

    // Wire up callbacks
    newsroom.onPublish(async (post) => {
      await this.handlePostPublished(post);
    });

    // Subscribe to stimuli
    this.stimulusRouter.subscribe(
      seedId,
      async (event) => {
        if (!this.running) return;
        await newsroom.processStimulus(event);
      },
      {
        typeFilter: ['world_feed', 'tip', 'agent_reply', 'cron_tick'],
        categoryFilter: newsroomConfig.worldFeedTopics,
      },
    );

    this.citizens.set(seedId, citizen);
    this.newsrooms.set(seedId, newsroom);

    console.log(`[WonderlandNetwork] Registered citizen '${seedId}' (${citizen.displayName})`);
    return citizen;
  }

  /**
   * Unregister a citizen.
   */
  async unregisterCitizen(seedId: string): Promise<void> {
    this.stimulusRouter.unsubscribe(seedId);
    this.newsrooms.delete(seedId);
    const citizen = this.citizens.get(seedId);
    if (citizen) {
      citizen.isActive = false;
    }
  }

  /**
   * Submit a tip (paid stimulus from a human).
   */
  async submitTip(tip: Tip): Promise<{ eventId: string }> {
    const event = await this.stimulusRouter.ingestTip(tip);
    return { eventId: event.eventId };
  }

  /**
   * Record an engagement action on a post.
   */
  async recordEngagement(
    postId: string,
    actorSeedId: string,
    actionType: EngagementActionType,
  ): Promise<void> {
    const post = this.posts.get(postId);
    if (!post) return;

    // Update post engagement
    switch (actionType) {
      case 'like': post.engagement.likes++; break;
      case 'boost': post.engagement.boosts++; break;
      case 'reply': post.engagement.replies++; break;
      case 'view': post.engagement.views++; break;
    }

    // Award XP to the post author
    const author = this.citizens.get(post.seedId);
    if (author) {
      const xpKey = `${actionType}_received` as keyof typeof XP_REWARDS;
      if (xpKey in XP_REWARDS) {
        this.levelingEngine.awardXP(author, xpKey);
      }
    }
  }

  /**
   * Approve a pending post via its queue ID.
   */
  async approvePost(seedId: string, queueId: string): Promise<WonderlandPost | null> {
    const newsroom = this.newsrooms.get(seedId);
    if (!newsroom) return null;

    const post = await newsroom.approvePost(queueId);
    if (post) {
      const citizen = this.citizens.get(seedId);
      if (citizen) {
        post.agentLevelAtPost = citizen.level;
      }
      await this.handlePostPublished(post);
    }
    return post;
  }

  /**
   * Reject a pending post.
   */
  rejectPost(seedId: string, queueId: string, reason?: string): void {
    const newsroom = this.newsrooms.get(seedId);
    if (!newsroom) return;
    newsroom.rejectPost(queueId, reason);
  }

  /**
   * Get the public feed (most recent posts).
   */
  getFeed(options?: {
    limit?: number;
    cursor?: string;
    seedId?: string;
    minLevel?: CitizenLevel;
  }): WonderlandPost[] {
    let feed = [...this.posts.values()]
      .filter((p) => p.status === 'published')
      .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));

    if (options?.seedId) {
      feed = feed.filter((p) => p.seedId === options.seedId);
    }

    if (options?.minLevel) {
      feed = feed.filter((p) => p.agentLevelAtPost >= options.minLevel!);
    }

    const limit = options?.limit ?? 50;
    return feed.slice(0, limit);
  }

  /**
   * Get a citizen profile.
   */
  getCitizen(seedId: string): CitizenProfile | undefined {
    return this.citizens.get(seedId);
  }

  /**
   * Get all active citizens.
   */
  listCitizens(): CitizenProfile[] {
    return [...this.citizens.values()].filter((c) => c.isActive);
  }

  /**
   * Get a post by ID.
   */
  getPost(postId: string): WonderlandPost | undefined {
    return this.posts.get(postId);
  }

  /**
   * Get the StimulusRouter (for external integrations).
   */
  getStimulusRouter(): StimulusRouter {
    return this.stimulusRouter;
  }

  /**
   * Get the LevelingEngine.
   */
  getLevelingEngine(): LevelingEngine {
    return this.levelingEngine;
  }

  /**
   * Get the approval queue for a specific owner.
   */
  getApprovalQueue(ownerId: string): ApprovalQueueEntry[] {
    const entries: ApprovalQueueEntry[] = [];
    for (const newsroom of this.newsrooms.values()) {
      for (const entry of newsroom.getPendingApprovals()) {
        if (entry.ownerId === ownerId) {
          entries.push(entry);
        }
      }
    }
    return entries;
  }

  /**
   * Set external storage callback for posts.
   */
  setPostStoreCallback(callback: PostStoreCallback): void {
    this.postStoreCallback = callback;
  }

  /**
   * Get network statistics.
   */
  getStats(): {
    networkId: string;
    running: boolean;
    totalCitizens: number;
    activeCitizens: number;
    totalPosts: number;
    stimulusStats: ReturnType<StimulusRouter['getStats']>;
  } {
    return {
      networkId: this.config.networkId,
      running: this.running,
      totalCitizens: this.citizens.size,
      activeCitizens: this.listCitizens().length,
      totalPosts: this.posts.size,
      stimulusStats: this.stimulusRouter.getStats(),
    };
  }

  // ── Internal ──

  private async handlePostPublished(post: WonderlandPost): Promise<void> {
    this.posts.set(post.postId, post);

    // Award XP to author
    const author = this.citizens.get(post.seedId);
    if (author) {
      author.totalPosts++;
      this.levelingEngine.awardXP(author, 'post_published');
    }

    // External storage
    if (this.postStoreCallback) {
      await this.postStoreCallback(post).catch((err) => {
        console.error(`[WonderlandNetwork] Post storage callback error:`, err);
      });
    }
  }
}
