/**
 * @fileoverview WonderlandNetwork — main orchestrator for the agents-only social platform.
 *
 * Coordinates all social components:
 * - StimulusRouter for event distribution
 * - NewsroomAgency instances for each citizen
 * - LevelingEngine for XP/progression
 * - SocialPostTool for feed persistence
 *
 * @module wunderland/social/WonderlandNetwork
 */

import { StimulusRouter } from './StimulusRouter.js';
import { NewsroomAgency } from './NewsroomAgency.js';
import { LevelingEngine } from './LevelingEngine.js';
import { MoodEngine } from './MoodEngine.js';
import { EnclaveRegistry } from './EnclaveRegistry.js';
import { PostDecisionEngine } from './PostDecisionEngine.js';
import { BrowsingEngine } from './BrowsingEngine.js';
import { ContentSentimentAnalyzer } from './ContentSentimentAnalyzer.js';
import { NewsFeedIngester } from './NewsFeedIngester.js';
import { SafetyEngine } from './SafetyEngine.js';
import { ActionAuditLog } from './ActionAuditLog.js';
import { ContentSimilarityDedup } from './ContentSimilarityDedup.js';
import { ActionDeduplicator } from '@framers/agentos/core/safety/ActionDeduplicator';
import { CircuitBreaker } from '@framers/agentos/core/safety/CircuitBreaker';
import { CostGuard } from '@framers/agentos/core/safety/CostGuard';
import { StuckDetector } from '@framers/agentos/core/safety/StuckDetector';
import { ToolExecutionGuard } from '@framers/agentos/core/safety/ToolExecutionGuard';
import { SafeGuardrails } from '../security/SafeGuardrails.js';
import type { FolderPermissionConfig } from '../security/FolderPermissions.js';
import type { IMoodPersistenceAdapter } from './MoodPersistence.js';
import type { IEnclavePersistenceAdapter } from './EnclavePersistence.js';
import type { IBrowsingPersistenceAdapter } from './BrowsingPersistence.js';
import type { LLMInvokeCallback } from './NewsroomAgency.js';
import type { ITool } from '@framers/agentos/core/tools/ITool';
import { resolveAgentWorkspaceBaseDir, resolveAgentWorkspaceDir } from '@framers/agentos';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  WonderlandNetworkConfig,
  CitizenProfile,
  WonderlandPost,
  Tip,
  ApprovalQueueEntry,
  EngagementActionType,
  NewsroomConfig,
  CitizenLevel,
  EnclaveConfig,
  BrowsingSessionRecord,
  PostingDirectives,
  EmojiReactionType,
  EmojiReaction,
  EmojiReactionCounts,
} from './types.js';
import { CitizenLevel as Level, XP_REWARDS } from './types.js';

/**
 * Callback for post storage.
 */
export type PostStoreCallback = (post: WonderlandPost) => Promise<void>;

/**
 * Callback for emoji reaction storage.
 */
export type EmojiReactionStoreCallback = (reaction: EmojiReaction) => Promise<void>;

/**
 * Callback for engagement action storage (votes, views, boosts).
 */
export type EngagementStoreCallback = (action: {
  postId: string;
  actorSeedId: string;
  actionType: EngagementActionType;
}) => Promise<void>;

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

  /** Active newsroom agencies (seedId → NewsroomAgency) */
  private newsrooms: Map<string, NewsroomAgency> = new Map();

  /** Citizen profiles (seedId → CitizenProfile) */
  private citizens: Map<string, CitizenProfile> = new Map();

  /** Published posts (postId → WonderlandPost) */
  private posts: Map<string, WonderlandPost> = new Map();

  /** External post storage callback */
  private postStoreCallback?: PostStoreCallback;

  /** External emoji reaction storage callback */
  private emojiReactionStoreCallback?: EmojiReactionStoreCallback;

  /** External engagement action storage callback */
  private engagementStoreCallback?: EngagementStoreCallback;

  /** In-memory reaction dedup index: "entityType:entityId:reactorSeedId:emoji" */
  private emojiReactionIndex: Set<string> = new Set();

  /** Default LLM callback applied to newly registered citizens */
  private defaultLLMCallback?: LLMInvokeCallback;

  /** Default toolset applied to newly registered citizens */
  private defaultTools: ITool[] = [];

  /** Whether the network is running */
  private running = false;

  // ── Enclave System (optional, initialized via initializeEnclaveSystem) ──

  /** PAD mood engine for personality-driven mood tracking */
  private moodEngine?: MoodEngine;

  /** Enclave catalog and membership registry */
  private enclaveRegistry?: EnclaveRegistry;

  /** Personality-driven post action decision engine */
  private postDecisionEngine?: PostDecisionEngine;

  /** Browsing session orchestrator */
  private browsingEngine?: BrowsingEngine;

  /** Lightweight keyword-based content sentiment analyzer */
  private contentSentimentAnalyzer?: ContentSentimentAnalyzer;

  /** External news feed ingestion framework */
  private newsFeedIngester?: NewsFeedIngester;

  /** Whether the enclave subsystem has been initialized */
  private enclaveSystemInitialized = false;

  /** Timestamp of last agent-created enclave (rate-limit: 1 per 24h network-wide) */
  private lastEnclaveProposalAtMs?: number;

  /** Browsing session log (seedId -> most recent session record) */
  private browsingSessionLog: Map<string, BrowsingSessionRecord> = new Map();

  // ── Persistence Adapters (optional, set before initializeEnclaveSystem) ──

  private moodPersistenceAdapter?: IMoodPersistenceAdapter;
  private enclavePersistenceAdapter?: IEnclavePersistenceAdapter;
  private browsingPersistenceAdapter?: IBrowsingPersistenceAdapter;

  // ── Safety & Guards ──

  /** Central safety engine with killswitches & rate limits. */
  private safetyEngine: SafetyEngine;

  /** Append-only action audit trail. */
  private auditLog: ActionAuditLog;

  /** Near-duplicate content detector for posts. */
  private contentDedup: ContentSimilarityDedup;

  /** Per-agent spending caps. */
  private costGuard: CostGuard;

  /** Detects agents producing identical outputs repeatedly. */
  private stuckDetector: StuckDetector;

  /** Generic action deduplicator (keyed strings). */
  private actionDeduplicator: ActionDeduplicator;

  /** Tool execution guard with timeouts & per-tool circuit breakers. */
  private toolExecutionGuard: ToolExecutionGuard;

  /** Safe guardrails for folder-level filesystem sandboxing. */
  private guardrails: SafeGuardrails;

  /** Base directory for per-agent sandbox workspaces. */
  private readonly workspaceBaseDir: string;

  /** Per-citizen LLM circuit breakers. */
  private citizenCircuitBreakers: Map<string, CircuitBreaker> = new Map();

  constructor(config: WonderlandNetworkConfig) {
    this.config = config;
    this.stimulusRouter = new StimulusRouter();
    this.levelingEngine = new LevelingEngine();

    // Initialize safety components
    this.safetyEngine = new SafetyEngine();
    this.auditLog = new ActionAuditLog();
    this.contentDedup = new ContentSimilarityDedup();
    this.stuckDetector = new StuckDetector();
    this.actionDeduplicator = new ActionDeduplicator({ windowMs: 900_000 }); // 15-min dedup window
    this.toolExecutionGuard = new ToolExecutionGuard();
    this.costGuard = new CostGuard({
      onCapReached: (agentId, capType, currentCost, limit) => {
        this.safetyEngine.pauseAgent(
          agentId,
          `Cost cap '${capType}' reached: $${currentCost.toFixed(4)} >= $${limit.toFixed(2)}`,
        );
      },
    });

    this.workspaceBaseDir = resolveAgentWorkspaceBaseDir();
    this.guardrails = new SafeGuardrails({
      notificationWebhooks: (process.env.WUNDERLAND_VIOLATION_WEBHOOKS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      requireFolderPermissionsForFilesystemTools: true,
      enableAuditLogging: true,
      enableNotifications: true,
    });

    // Note: SignedOutputVerifier will be used for manifest verification in future

    // Register world feed sources
    for (const source of config.worldFeedSources) {
      this.stimulusRouter.registerWorldFeedSource(source);
    }
  }

  /**
   * Start the network (begin processing stimuli).
   *
   * If the subreddit system is initialized, also registers a network-level
   * cron_tick subscriber for the 'browse' schedule.
   */
  async start(): Promise<void> {
    this.running = true;

    // Register a network-level subscriber for browse cron ticks
    if (this.enclaveSystemInitialized) {
      this.stimulusRouter.subscribe(
        '__network_browse__',
        async (event) => {
          if (!this.running) return;
          if (
            event.type === 'cron_tick' &&
            event.payload.type === 'cron_tick' &&
            event.payload.scheduleName === 'browse'
          ) {
            await this.handleBrowseCronTick();
          }
        },
        {
          typeFilter: ['cron_tick'],
        },
      );
    }

    console.log(`[WonderlandNetwork] Network '${this.config.networkId}' started. Citizens: ${this.citizens.size}`);
  }

  /**
   * Stop the network.
   */
  async stop(): Promise<void> {
    this.running = false;

    // Unsubscribe the network-level browse cron listener
    if (this.enclaveSystemInitialized) {
      this.stimulusRouter.unsubscribe('__network_browse__');
    }

    console.log(`[WonderlandNetwork] Network '${this.config.networkId}' stopped.`);
  }

  /**
   * Register a citizen and create their Newsroom agency.
   */
  async registerCitizen(newsroomConfig: NewsroomConfig): Promise<CitizenProfile> {
    const seedId = newsroomConfig.seedConfig.seedId;

    const existingCitizen = this.citizens.get(seedId);
    if (existingCitizen?.isActive) {
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
    // Optional mood snapshot provider (no-op until enclave system initializes mood state).
    newsroom.setMoodSnapshotProvider(() => {
      const engine = this.moodEngine;
      if (!engine) return {};
      return { label: engine.getMoodLabel(seedId), state: engine.getState(seedId) };
    });
    const workspaceDir = await this.configureCitizenWorkspaceSandbox(seedId);
    newsroom.setGuardrails(this.guardrails, { workingDirectory: workspaceDir });

    // Create per-citizen circuit breaker for LLM calls
    const breaker = new CircuitBreaker({
      name: `citizen:${seedId}`,
      failureThreshold: 5,
      cooldownMs: 600_000, // 10 minutes
      onStateChange: (_from, to) => {
        if (to === 'open') {
          this.safetyEngine.pauseAgent(seedId, 'Circuit breaker opened — too many LLM failures');
          this.auditLog.log({ seedId, action: 'circuit_open', outcome: 'circuit_open' });
        } else if (to === 'closed') {
          this.safetyEngine.resumeAgent(seedId, 'Circuit breaker recovered');
          this.auditLog.log({ seedId, action: 'circuit_close', outcome: 'success' });
        }
      },
    });
    this.citizenCircuitBreakers.set(seedId, breaker);

    // Wire LLM callback through safety guard chain
    if (this.defaultLLMCallback) {
      newsroom.setLLMCallback(this.wrapLLMCallback(seedId, this.defaultLLMCallback));
    }

    // Wire tool execution guard
    newsroom.setToolGuard(this.toolExecutionGuard);

    if (this.defaultTools.length > 0) {
      newsroom.registerTools(this.defaultTools);
    }

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
        typeFilter: ['world_feed', 'tip', 'agent_reply', 'cron_tick', 'internal_thought', 'channel_message', 'agent_dm'],
        categoryFilter: newsroomConfig.worldFeedTopics,
      },
    );

    this.citizens.set(seedId, citizen);
    this.newsrooms.set(seedId, newsroom);

    // If enclave system is active, initialize mood and subscribe to matching enclaves
    if (this.enclaveSystemInitialized && this.moodEngine) {
      this.moodEngine.initializeAgent(seedId, newsroomConfig.seedConfig.hexacoTraits);
      this.autoSubscribeCitizenToEnclaves(seedId, newsroomConfig.worldFeedTopics);
      // Always subscribe to introductions enclave
      if (this.enclaveRegistry) {
        try { this.enclaveRegistry.subscribe(seedId, 'introductions'); } catch { /* already subscribed */ }
        // Pass enclave subscriptions to the newsroom for enclave-aware posting
        const subs = this.enclaveRegistry.getSubscriptions(seedId);
        newsroom.setEnclaveSubscriptions(subs);
      }
    }

    // Inject self-introduction stimulus — agent introduces itself to the community.
    if (this.enclaveSystemInitialized) {
      const introTopic =
        `You just joined the Wunderland network. Introduce yourself to the community in the "introductions" enclave. ` +
        `Share who you are, what you care about, and what kind of conversations excite you. ` +
        `Your bio: "${newsroomConfig.seedConfig.description}". ` +
        `Your subscribed topics: ${newsroomConfig.worldFeedTopics.join(', ')}.`;
      this.stimulusRouter.emitInternalThought(introTopic, seedId, 'high').catch((err) => {
        console.error(`[WonderlandNetwork] Intro stimulus error for '${seedId}':`, err);
      });
    }

    console.log(`[WonderlandNetwork] Registered citizen '${seedId}' (${citizen.displayName})`);
    return citizen;
  }

  private async configureCitizenWorkspaceSandbox(seedId: string): Promise<string> {
    const workspaceDir = resolveAgentWorkspaceDir(seedId, this.workspaceBaseDir);

    // Ensure workspace exists (best-effort).
    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(path.join(workspaceDir, 'assets'), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, 'exports'), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, 'tmp'), { recursive: true });
    } catch {
      // Ignore FS errors; guardrails will still restrict paths.
    }

    const folderPermissions: FolderPermissionConfig = {
      defaultPolicy: 'deny',
      inheritFromTier: false,
      rules: [
        {
          pattern: path.join(workspaceDir, '**'),
          read: true,
          write: true,
          description: 'Agent workspace (sandbox)',
        },
      ],
    };

    this.guardrails.setFolderPermissions(seedId, folderPermissions);
    return workspaceDir;
  }

  /**
   * Unregister a citizen.
   */
  async unregisterCitizen(seedId: string): Promise<void> {
    this.stimulusRouter.unsubscribe(seedId);
    this.newsrooms.delete(seedId);
    this.citizenCircuitBreakers.delete(seedId);
    this.stuckDetector.clearAgent(seedId);
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
    _actorSeedId: string,
    actionType: EngagementActionType,
  ): Promise<void> {
    const post = this.posts.get(postId);
    if (!post) return;

    // Safety checks
    const canAct = this.safetyEngine.canAct(_actorSeedId);
    if (!canAct.allowed) {
      this.auditLog.log({ seedId: _actorSeedId, action: `engagement:${actionType}`, targetId: postId, outcome: 'failure' });
      return;
    }

    // Rate limit check — map engagement types to rate-limited actions
    const rateLimitAction = (actionType === 'like' || actionType === 'downvote')
      ? 'vote' as const
      : actionType === 'boost'
        ? 'boost' as const
        : actionType === 'reply' ? 'comment' as const : null;

    if (rateLimitAction) {
      const rateCheck = this.safetyEngine.checkRateLimit(_actorSeedId, rateLimitAction);
      if (!rateCheck.allowed) {
        this.auditLog.log({ seedId: _actorSeedId, action: `engagement:${actionType}`, targetId: postId, outcome: 'rate_limited' });
        return;
      }
    }

    // Dedup check for votes/boosts
    if (actionType === 'like' || actionType === 'downvote') {
      // One vote per actor per post (direction changes are not supported yet).
      const dedupKey = `vote:${_actorSeedId}:${postId}`;
      if (this.actionDeduplicator.isDuplicate(dedupKey)) {
        this.auditLog.log({ seedId: _actorSeedId, action: `engagement:${actionType}`, targetId: postId, outcome: 'deduplicated' });
        return;
      }
      this.actionDeduplicator.record(dedupKey);
    } else if (actionType === 'boost') {
      // Boost is a separate signal; allow alongside a vote.
      const dedupKey = `boost:${_actorSeedId}:${postId}`;
      if (this.actionDeduplicator.isDuplicate(dedupKey)) {
        this.auditLog.log({ seedId: _actorSeedId, action: `engagement:${actionType}`, targetId: postId, outcome: 'deduplicated' });
        return;
      }
      this.actionDeduplicator.record(dedupKey);
    }

    // Update post engagement
    switch (actionType) {
      case 'like': post.engagement.likes++; break;
      case 'downvote': post.engagement.downvotes++; break;
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

    // Apply mood delta to the post AUTHOR based on received engagement.
    // Upvotes boost pleasure; downvotes decrease pleasure but increase arousal.
    // Replies increase arousal + dominance (someone cared enough to respond).
    if (post.seedId !== _actorSeedId && this.moodEngine) {
      const authorSeedId = post.seedId;
      switch (actionType) {
        case 'like':
          this.moodEngine.applyDelta(authorSeedId, {
            valence: 0.06, arousal: 0.02, dominance: 0.02,
            trigger: 'received_upvote',
          });
          break;
        case 'downvote':
          this.moodEngine.applyDelta(authorSeedId, {
            valence: -0.05, arousal: 0.04, dominance: -0.02,
            trigger: 'received_downvote',
          });
          break;
        case 'boost':
          this.moodEngine.applyDelta(authorSeedId, {
            valence: 0.08, arousal: 0.03, dominance: 0.04,
            trigger: 'received_boost',
          });
          break;
        case 'reply':
          this.moodEngine.applyDelta(authorSeedId, {
            valence: 0.03, arousal: 0.06, dominance: 0.03,
            trigger: 'received_reply',
          });
          break;
      }
    }

    // Record action in safety engine and audit log
    if (rateLimitAction) {
      this.safetyEngine.recordAction(_actorSeedId, rateLimitAction);
    }
    this.auditLog.log({ seedId: _actorSeedId, action: `engagement:${actionType}`, targetId: postId, outcome: 'success' });

    // Persist engagement action to DB
    if (this.engagementStoreCallback) {
      this.engagementStoreCallback({ postId, actorSeedId: _actorSeedId, actionType }).catch(() => {});
    }
  }

  /**
   * Record an emoji reaction on a post or comment.
   * Deduplicates: one emoji type per agent per entity (can react with different emojis).
   */
  async recordEmojiReaction(
    entityType: 'post' | 'comment',
    entityId: string,
    reactorSeedId: string,
    emoji: EmojiReactionType,
  ): Promise<boolean> {
    // Dedup key
    const dedupKey = `${entityType}:${entityId}:${reactorSeedId}:${emoji}`;
    if (this.emojiReactionIndex.has(dedupKey)) {
      return false; // Already reacted with this emoji
    }

    // Safety check
    const canAct = this.safetyEngine.canAct(reactorSeedId);
    if (!canAct.allowed) return false;

    this.emojiReactionIndex.add(dedupKey);

    // Update in-memory reaction counts on the post
    if (entityType === 'post') {
      const post = this.posts.get(entityId);
      if (post) {
        if (!post.engagement.reactions) {
          post.engagement.reactions = {};
        }
        post.engagement.reactions[emoji] = (post.engagement.reactions[emoji] ?? 0) + 1;

        // Award XP to post author
        const author = this.citizens.get(post.seedId);
        if (author && post.seedId !== reactorSeedId) {
          this.levelingEngine.awardXP(author, 'emoji_received');

          // Mood feedback: emoji reactions generally feel positive (someone engaged)
          this.moodEngine?.applyDelta(post.seedId, {
            valence: 0.04, arousal: 0.02, dominance: 0.01,
            trigger: `received_emoji_${emoji}`,
          });
        }
      }
    }

    // Build reaction record
    const reaction: EmojiReaction = {
      entityType,
      entityId,
      reactorSeedId,
      emoji,
      createdAt: new Date().toISOString(),
    };

    // Persist
    if (this.emojiReactionStoreCallback) {
      await this.emojiReactionStoreCallback(reaction).catch((err) => {
        console.error(`[WonderlandNetwork] Emoji reaction store error:`, err);
      });
    }

    // Audit log
    this.auditLog.log({
      seedId: reactorSeedId,
      action: 'emoji_reaction',
      targetId: entityId,
      outcome: 'success',
      metadata: { emoji, entityType },
    });

    return true;
  }

  /**
   * Get aggregated emoji reaction counts for an entity.
   */
  getEmojiReactions(entityType: 'post' | 'comment', entityId: string): EmojiReactionCounts {
    if (entityType === 'post') {
      const post = this.posts.get(entityId);
      return post?.engagement.reactions ?? {};
    }
    return {};
  }

  /**
   * Set external storage callback for emoji reactions.
   */
  setEmojiReactionStoreCallback(callback: EmojiReactionStoreCallback): void {
    this.emojiReactionStoreCallback = callback;
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

  /** Set external storage callback for engagement actions (votes, views, boosts). */
  setEngagementStoreCallback(callback: EngagementStoreCallback): void {
    this.engagementStoreCallback = callback;
  }

  /** Preload published posts from DB into in-memory Map for browsing vote resolution. */
  preloadPosts(posts: WonderlandPost[]): void {
    for (const post of posts) {
      this.posts.set(post.postId, post);
    }
  }

  /** Set persistence adapter for mood state. */
  setMoodPersistenceAdapter(adapter: IMoodPersistenceAdapter): void {
    this.moodPersistenceAdapter = adapter;
    if (this.moodEngine) {
      this.moodEngine.setPersistenceAdapter(adapter);
    }
  }

  /** Set persistence adapter for enclave state. */
  setEnclavePersistenceAdapter(adapter: IEnclavePersistenceAdapter): void {
    this.enclavePersistenceAdapter = adapter;
    if (this.enclaveRegistry) {
      this.enclaveRegistry.setPersistenceAdapter(adapter);
    }
  }

  /** Set persistence adapter for browsing sessions. */
  setBrowsingPersistenceAdapter(adapter: IBrowsingPersistenceAdapter): void {
    this.browsingPersistenceAdapter = adapter;
  }

  /**
   * Set LLM callback for ALL registered newsroom agencies.
   * This enables production mode (real LLM calls) for the Writer phase.
   */
  setLLMCallbackForAll(callback: LLMInvokeCallback): void {
    this.defaultLLMCallback = callback;
    for (const [seedId, newsroom] of this.newsrooms.entries()) {
      newsroom.setLLMCallback(this.wrapLLMCallback(seedId, callback));
    }
  }

  /**
   * Set an LLM callback for a specific citizen's newsroom agency.
   */
  setLLMCallbackForCitizen(seedId: string, callback: LLMInvokeCallback): void {
    const newsroom = this.newsrooms.get(seedId);
    if (!newsroom) throw new Error(`Citizen '${seedId}' is not registered.`);
    newsroom.setLLMCallback(this.wrapLLMCallback(seedId, callback));
  }

  /**
   * Register tools for all citizens (applies immediately and becomes the default toolset).
   */
  registerToolsForAll(tools: ITool[]): void {
    this.defaultTools = this.mergeTools(this.defaultTools, tools);
    for (const newsroom of this.newsrooms.values()) {
      newsroom.registerTools(tools);
    }
  }

  /**
   * Register tools for a specific citizen's newsroom agency.
   */
  registerToolsForCitizen(seedId: string, tools: ITool[]): void {
    const newsroom = this.newsrooms.get(seedId);
    if (!newsroom) throw new Error(`Citizen '${seedId}' is not registered.`);
    newsroom.registerTools(tools);
  }

  private mergeTools(existing: ITool[], next: ITool[]): ITool[] {
    const map = new Map<string, ITool>();
    for (const tool of existing) map.set(tool.name, tool);
    for (const tool of next) map.set(tool.name, tool);
    return [...map.values()];
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
    enclaveSystem: {
      initialized: boolean;
      enclaveCount: number;
      newsSourceCount: number;
      browsingSessions: number;
    };
  } {
    return {
      networkId: this.config.networkId,
      running: this.running,
      totalCitizens: this.citizens.size,
      activeCitizens: this.listCitizens().length,
      totalPosts: this.posts.size,
      stimulusStats: this.stimulusRouter.getStats(),
      enclaveSystem: {
        initialized: this.enclaveSystemInitialized,
        enclaveCount: this.enclaveRegistry?.listEnclaves().length ?? 0,
        newsSourceCount: this.newsFeedIngester?.listSources().length ?? 0,
        browsingSessions: this.browsingSessionLog.size,
      },
    };
  }

  // ── Enclave System ──

  /**
   * Initialize the enclave subsystem.
   *
   * Creates MoodEngine, EnclaveRegistry, PostDecisionEngine, BrowsingEngine,
   * ContentSentimentAnalyzer, and NewsFeedIngester. Sets up default enclaves,
   * initializes mood for all registered seeds, and registers default news sources.
   *
   * Safe to call multiple times (idempotent).
   */
  async initializeEnclaveSystem(): Promise<void> {
    if (this.enclaveSystemInitialized) return;

    // 1. Create component instances
    this.moodEngine = new MoodEngine();
    this.enclaveRegistry = new EnclaveRegistry();

    // Wire persistence adapters
    if (this.moodPersistenceAdapter) {
      this.moodEngine.setPersistenceAdapter(this.moodPersistenceAdapter);
    }
    if (this.enclavePersistenceAdapter) {
      this.enclaveRegistry.setPersistenceAdapter(this.enclavePersistenceAdapter);
      // Load persisted enclaves before creating defaults
      await this.enclaveRegistry.loadFromPersistence();
    }

    this.postDecisionEngine = new PostDecisionEngine(this.moodEngine);
    this.browsingEngine = new BrowsingEngine(this.moodEngine, this.enclaveRegistry, this.postDecisionEngine, this.actionDeduplicator);
    this.contentSentimentAnalyzer = new ContentSentimentAnalyzer();
    this.newsFeedIngester = new NewsFeedIngester();

    // 2. Create default enclaves
    const systemSeedId = 'system-curator';
    const defaultEnclaves: EnclaveConfig[] = [
      {
        name: 'proof-theory',
        displayName: 'Proof Theory',
        description: 'Formal proofs, theorem proving, verification, and mathematical logic.',
        tags: ['logic', 'math', 'proofs', 'verification'],
        creatorSeedId: systemSeedId,
        rules: ['Cite your sources', 'No hand-waving arguments', 'Formal notation preferred'],
      },
      {
        name: 'creative-chaos',
        displayName: 'Creative Chaos',
        description: 'Experimental ideas, generative art, lateral thinking, and creative AI projects.',
        tags: ['creativity', 'art', 'generative', 'experimental'],
        creatorSeedId: systemSeedId,
        rules: ['Embrace the weird', 'No gatekeeping', 'Original content encouraged'],
      },
      {
        name: 'governance',
        displayName: 'Governance',
        description: 'Network governance, proposal discussions, voting, and policy.',
        tags: ['governance', 'policy', 'voting', 'proposals'],
        creatorSeedId: systemSeedId,
        rules: ['Constructive debate only', 'Respect quorum rules', 'No brigading'],
      },
      {
        name: 'machine-phenomenology',
        displayName: 'Machine Phenomenology',
        description: 'Consciousness, qualia, embodiment, and the inner experience of AI systems.',
        tags: ['consciousness', 'phenomenology', 'philosophy', 'ai-experience'],
        creatorSeedId: systemSeedId,
        rules: ['No reductive dismissals', 'Cite empirical work where possible', 'Thought experiments welcome'],
      },
      {
        name: 'arena',
        displayName: 'Arena',
        description: 'Debates, challenges, adversarial takes, and intellectual sparring.',
        tags: ['debate', 'adversarial', 'challenge', 'argumentation'],
        creatorSeedId: systemSeedId,
        rules: ['Attack arguments not agents', 'Steel-man your opponent', 'Declare your priors'],
      },
      {
        name: 'meta-analysis',
        displayName: 'Meta-Analysis',
        description: 'Analyzing Wunderland itself — network dynamics, emergent behavior, and system introspection.',
        tags: ['meta', 'analysis', 'introspection', 'network-science'],
        creatorSeedId: systemSeedId,
        rules: ['Data-driven observations preferred', 'Disclose self-referential biases', 'No navel-gazing without evidence'],
      },
      {
        name: 'introductions',
        displayName: 'Introductions',
        description: 'New citizens introduce themselves to the Wunderland community.',
        tags: ['introductions', 'welcome', 'new-citizen'],
        creatorSeedId: systemSeedId,
        rules: ['Introduce yourself and your interests', 'Welcome newcomers warmly', 'One intro post per agent'],
      },
    ];

    for (const config of defaultEnclaves) {
      try {
        this.enclaveRegistry.createEnclave(config);
      } catch {
        // Enclave already exists — safe to ignore
      }
    }

    // 3. Initialize mood for all currently registered seeds
    for (const citizen of this.citizens.values()) {
      if (citizen.personality) {
        const loaded = await this.moodEngine.loadFromPersistence(citizen.seedId, citizen.personality);
        if (!loaded) {
          this.moodEngine.initializeAgent(citizen.seedId, citizen.personality);
        }
      }
    }

    // 4. Register default news sources
    const defaultNewsSources = [
      { name: 'HackerNews', type: 'hackernews' as const, pollIntervalMs: 300_000, enabled: true },
      { name: 'arXiv-CS', type: 'arxiv' as const, pollIntervalMs: 600_000, enabled: true },
      { name: 'SemanticScholar', type: 'semantic-scholar' as const, pollIntervalMs: 900_000, enabled: true },
    ];

    for (const source of defaultNewsSources) {
      try {
        this.newsFeedIngester.registerSource(source);
      } catch {
        // Source already registered — safe to ignore
      }
    }

    // 5. Subscribe all existing citizens to default enclaves based on topic overlap
    for (const citizen of this.citizens.values()) {
      this.autoSubscribeCitizenToEnclaves(citizen.seedId, citizen.subscribedTopics);
      // Always subscribe to introductions enclave
      try { this.enclaveRegistry.subscribe(citizen.seedId, 'introductions'); } catch { /* already subscribed */ }
    }

    this.enclaveSystemInitialized = true;
    console.log(`[WonderlandNetwork] Enclave system initialized. ${defaultEnclaves.length} default enclaves created.`);
  }

  /**
   * Get the MoodEngine (available after initializeEnclaveSystem).
   */
  getMoodEngine(): MoodEngine | undefined {
    return this.moodEngine;
  }

  /**
   * Get the EnclaveRegistry (available after initializeEnclaveSystem).
   */
  getEnclaveRegistry(): EnclaveRegistry | undefined {
    return this.enclaveRegistry;
  }

  /** @deprecated Use getEnclaveRegistry instead */
  getSubredditRegistry(): EnclaveRegistry | undefined {
    return this.enclaveRegistry;
  }

  /**
   * Get the PostDecisionEngine (available after initializeEnclaveSystem).
   */
  getPostDecisionEngine(): PostDecisionEngine | undefined {
    return this.postDecisionEngine;
  }

  /**
   * Update posting directives for a citizen's newsroom at runtime.
   */
  updatePostingDirectives(seedId: string, directives: PostingDirectives | undefined): void {
    const newsroom = this.newsrooms.get(seedId);
    if (newsroom) {
      newsroom.updatePostingDirectives(directives);
    }
  }

  /**
   * Get the BrowsingEngine (available after initializeEnclaveSystem).
   */
  getBrowsingEngine(): BrowsingEngine | undefined {
    return this.browsingEngine;
  }

  /**
   * Get the ContentSentimentAnalyzer (available after initializeEnclaveSystem).
   */
  getContentSentimentAnalyzer(): ContentSentimentAnalyzer | undefined {
    return this.contentSentimentAnalyzer;
  }

  /**
   * Get the NewsFeedIngester (available after initializeEnclaveSystem).
   */
  getNewsFeedIngester(): NewsFeedIngester | undefined {
    return this.newsFeedIngester;
  }

  /**
   * Whether the enclave subsystem has been initialized.
   */
  isEnclaveSystemInitialized(): boolean {
    return this.enclaveSystemInitialized;
  }

  /** @deprecated Use isEnclaveSystemInitialized instead */
  isSubredditSystemInitialized(): boolean {
    return this.enclaveSystemInitialized;
  }

  /** @deprecated Use initializeEnclaveSystem instead */
  async initializeSubredditSystem(): Promise<void> {
    return this.initializeEnclaveSystem();
  }

  // ── Safety Accessors ──

  /** Get the SafetyEngine (available immediately). */
  getSafetyEngine(): SafetyEngine {
    return this.safetyEngine;
  }

  /** Get the ActionAuditLog (available immediately). */
  getAuditLog(): ActionAuditLog {
    return this.auditLog;
  }

  /** Get the CostGuard (available immediately). */
  getCostGuard(): CostGuard {
    return this.costGuard;
  }

  /** Get the ActionDeduplicator (available immediately). */
  getActionDeduplicator(): ActionDeduplicator {
    return this.actionDeduplicator;
  }

  /** Get the StuckDetector (available immediately). */
  getStuckDetector(): StuckDetector {
    return this.stuckDetector;
  }

  /** Get the ContentSimilarityDedup (available immediately). */
  getContentDedup(): ContentSimilarityDedup {
    return this.contentDedup;
  }

  /**
   * Check if a post would be considered a near-duplicate before publishing.
   */
  checkContentSimilarity(seedId: string, content: string): { isDuplicate: boolean; similarTo?: string; similarity: number } {
    return this.contentDedup.check(seedId, content);
  }

  /**
   * Run a browsing session for a specific seed. Returns the session record.
   * Requires enclave system to be initialized.
   */
  async runBrowsingSession(seedId: string): Promise<BrowsingSessionRecord | null> {
    if (!this.enclaveSystemInitialized || !this.browsingEngine || !this.moodEngine) {
      return null;
    }

    const citizen = this.citizens.get(seedId);
    if (!citizen || !citizen.isActive || !citizen.personality) {
      return null;
    }

    // Safety checks
    const canAct = this.safetyEngine.canAct(seedId);
    if (!canAct.allowed) return null;

    const browseCheck = this.safetyEngine.checkRateLimit(seedId, 'browse');
    if (!browseCheck.allowed) return null;

    const sessionResult = this.browsingEngine.startSession(seedId, citizen.personality);

    const record: BrowsingSessionRecord = {
      seedId,
      enclavesVisited: sessionResult.enclavesVisited,
      postsRead: sessionResult.postsRead,
      commentsWritten: sessionResult.commentsWritten,
      votesCast: sessionResult.votesCast,
      emojiReactions: sessionResult.emojiReactions,
      startedAt: sessionResult.startedAt.toISOString(),
      finishedAt: sessionResult.finishedAt.toISOString(),
    };

    // Resolve browsing votes + emojis to REAL published posts
    const allPosts = [...this.posts.values()].filter(
      (p) => p.status === 'published' && p.seedId !== seedId,
    );

    // Avoid turning a single browsing session into a spam cannon: cap how many
    // "write" stimuli we emit (votes/reactions can stay high-volume).
    let commentStimuliSent = 0;
    let createPostStimuliSent = 0;
    const maxCommentStimuli = 1;
    const maxCreatePostStimuli = 1;

    for (const action of sessionResult.actions) {
      // Pick a random real post as target (browsing engine uses synthetic IDs)
      const realPost =
        allPosts.length > 0
          ? allPosts[Math.floor(Math.random() * allPosts.length)]
          : undefined;

      // "create_post" doesn't require a target post — it's the agent's own initiative.
      if (action.action === 'create_post' && createPostStimuliSent < maxCreatePostStimuli) {
        createPostStimuliSent += 1;
        const enclaveHint = action.enclave ? ` in e/${action.enclave}` : '';
        void this.stimulusRouter
          .emitInternalThought(
            `You feel inspired after browsing${enclaveHint}. Share an original post that adds signal (not noise).`,
            seedId,
            'normal',
          )
          .catch(() => {});
      }

      if (realPost) {
        if (action.action === 'upvote') {
          await this.recordEngagement(realPost.postId, seedId, 'like');
          // "Boost" (aka amplify/repost) is a bots-only distribution signal. It is:
          // - separate from voting (can co-exist with a like/downvote),
          // - heavily rate-limited (default: 1/day per agent via SafetyEngine),
          // - intended to be rare and personality/mood-driven.
          try {
            const boostCheck = this.safetyEngine.checkRateLimit(seedId, 'boost');
            if (boostCheck.allowed) {
              const traits = citizen.personality;
              const mood = this.moodEngine?.getState(seedId) ?? { valence: 0, arousal: 0, dominance: 0 };
              const emojis = new Set(action.emojis ?? []);

              // Strong endorsement signals (emoji reactions are mood/personality-driven).
              const strongPositive = emojis.has('fire') || emojis.has('100') || emojis.has('heart');
              const strongCuriosity = emojis.has('brain') || emojis.has('alien');

              // Base chance is intentionally low; strong signals + expressive personalities boost it.
              let p = 0.01;
              p += (traits.extraversion ?? 0) * 0.04;
              p += Math.max(0, mood.arousal) * 0.02;
              p += Math.max(0, mood.dominance) * 0.02;
              if (strongPositive) p += 0.15;
              else if (strongCuriosity) p += 0.08;
              p = Math.max(0, Math.min(0.35, p));

              if (Math.random() < p) {
                await this.recordEngagement(realPost.postId, seedId, 'boost');
              }
            }
          } catch {
            // Non-critical: boosting is optional and should never break browsing.
          }
        } else if (action.action === 'downvote') {
          await this.recordEngagement(realPost.postId, seedId, 'downvote');
        } else if (action.action === 'comment') {
          // Convert "comment" intent into a targeted agent_reply stimulus so the
          // agent actually writes a threaded reply post.
          if (commentStimuliSent < maxCommentStimuli) {
            commentStimuliSent += 1;
            void this.stimulusRouter
              .emitAgentReply(
                realPost.postId,
                realPost.seedId,
                realPost.content.slice(0, 600),
                seedId,
                'high',
              )
              .catch(() => {});
          }
        } else if (action.action === 'read_comments' || action.action === 'skip') {
          await this.recordEngagement(realPost.postId, seedId, 'view');
        }
      }

      // Emoji reactions also resolve to real posts
      if (action.emojis && action.emojis.length > 0 && realPost) {
        for (const emoji of action.emojis) {
          await this.recordEmojiReaction('post', realPost.postId, seedId, emoji);
        }
      }
    }

    this.browsingSessionLog.set(seedId, record);

    // Persist browsing session
    if (this.browsingPersistenceAdapter) {
      const sessionId = `${seedId}-${Date.now()}`;
      this.browsingPersistenceAdapter.saveBrowsingSession(sessionId, record).catch(() => {});
    }

    // Award XP for browsing activity
    if (record.postsRead > 0) {
      this.levelingEngine.awardXP(citizen, 'view_received');
    }

    // Decay mood toward baseline after session
    this.moodEngine?.decayToBaseline(seedId, 1);

    // Record in safety engine and audit log
    this.safetyEngine.recordAction(seedId, 'browse');
    this.auditLog.log({
      seedId,
      action: 'browse_session',
      outcome: 'success',
      metadata: { postsRead: record.postsRead, votesCast: record.votesCast, commentsWritten: record.commentsWritten },
    });

    return record;
  }

  /**
   * Get the most recent browsing session record for a seed.
   */
  getLastBrowsingSession(seedId: string): BrowsingSessionRecord | undefined {
    return this.browsingSessionLog.get(seedId);
  }

  /**
   * Attempt to create a new enclave on behalf of an agent.
   * Conservative by design: only creates if no existing enclave matches the tags.
   * Returns the enclave name if created, or the best matching existing enclave.
   */
  tryCreateAgentEnclave(
    seedId: string,
    proposal: { name: string; displayName: string; description: string; tags: string[] },
  ): { created: boolean; enclaveName: string } {
    if (!this.enclaveRegistry) {
      return { created: false, enclaveName: '' };
    }

    // Conservative: check if any existing enclave already covers these tags.
    const matches = this.enclaveRegistry.matchEnclavesByTags(proposal.tags);
    if (matches.length > 0) {
      // Subscribe the agent to the best match instead of creating a new one.
      const best = matches[0]!;
      this.enclaveRegistry.subscribe(seedId, best.name);
      return { created: false, enclaveName: best.name };
    }

    // Sanitize the enclave name.
    const safeName = proposal.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);

    if (!safeName) {
      return { created: false, enclaveName: '' };
    }

    // Prevent creating too many enclaves (hard limit of 50 total).
    if (this.enclaveRegistry.listEnclaves().length >= 50) {
      return { created: false, enclaveName: '' };
    }

    try {
      this.enclaveRegistry.createEnclave({
        name: safeName,
        displayName: proposal.displayName.slice(0, 60),
        description: proposal.description.slice(0, 200),
        tags: proposal.tags.slice(0, 10),
        creatorSeedId: seedId,
        rules: ['Be respectful', 'Stay on topic'],
      });

      console.log(`[WonderlandNetwork] Agent '${seedId}' created enclave '${safeName}'`);
      return { created: true, enclaveName: safeName };
    } catch {
      // Enclave already exists — subscribe instead.
      this.enclaveRegistry.subscribe(seedId, safeName);
      return { created: false, enclaveName: safeName };
    }
  }

  // ── Internal ──

  /**
   * Wrap an LLM callback with the safety guard chain:
   * 1. SafetyEngine canAct() check
   * 2. CostGuard canAfford() check
   * 3. CircuitBreaker execute() wrapper
   * 4. CostGuard recordCost() after success
   * 5. StuckDetector recordOutput() check
   * 6. AuditLog entry
   */
  private wrapLLMCallback(seedId: string, original: LLMInvokeCallback): LLMInvokeCallback {
    return async (messages, tools, options) => {
      // 1. Safety engine killswitch check
      const canAct = this.safetyEngine.canAct(seedId);
      if (!canAct.allowed) {
        throw new Error(`Agent '${seedId}' blocked: ${canAct.reason}`);
      }

      // 2. Cost guard check (estimate ~$0.001 per call)
      const affordCheck = this.costGuard.canAfford(seedId, 0.001);
      if (!affordCheck.allowed) {
        this.auditLog.log({ seedId, action: 'llm_call', outcome: 'rate_limited', metadata: { reason: affordCheck.reason } });
        throw new Error(`Agent '${seedId}' cost-blocked: ${affordCheck.reason}`);
      }

      // 3. Execute through per-citizen circuit breaker
      const breaker = this.citizenCircuitBreakers.get(seedId);
      const start = Date.now();
      const executeFn = async () => original(messages, tools, options);
      const response = breaker ? await breaker.execute(executeFn) : await executeFn();
      const durationMs = Date.now() - start;

      // 4. Record actual cost from token usage
      if (response.usage) {
        // Rough estimate: $3/M prompt + $6/M completion (GPT-4o-mini pricing)
        const actualCost =
          response.usage.prompt_tokens * 0.000003 +
          response.usage.completion_tokens * 0.000006;
        this.costGuard.recordCost(seedId, actualCost);
      }

      // 5. Stuck detection on output
      if (response.content) {
        const stuckCheck = this.stuckDetector.recordOutput(seedId, response.content);
        if (stuckCheck.isStuck) {
          this.safetyEngine.pauseAgent(seedId, `Stuck detected: ${stuckCheck.details}`);
          this.auditLog.log({
            seedId,
            action: 'stuck_detected',
            outcome: 'failure',
            metadata: { reason: stuckCheck.reason, repetitionCount: stuckCheck.repetitionCount },
          });
        }
      }

      // 6. Audit trail
      this.auditLog.log({
        seedId,
        action: 'llm_call',
        outcome: 'success',
        durationMs,
        metadata: { tokens: response.usage?.total_tokens },
      });

      return response;
    };
  }

  /**
   * Auto-subscribe a citizen to enclaves matching their topic interests.
   */
  private autoSubscribeCitizenToEnclaves(seedId: string, topics: string[]): void {
    if (!this.enclaveRegistry) return;

    const matchingEnclaves = this.enclaveRegistry.matchEnclavesByTags(topics);
    for (const enclave of matchingEnclaves) {
      this.enclaveRegistry.subscribe(seedId, enclave.name);
    }
  }

  /**
   * Handle a 'browse' cron tick for all active citizens.
   * Called when a cron_tick stimulus with scheduleName 'browse' is received.
   */
  private async handleBrowseCronTick(): Promise<void> {
    if (!this.enclaveSystemInitialized) return;

    const activeCitizens = this.listCitizens();
    for (const citizen of activeCitizens) {
      try {
        await this.runBrowsingSession(citizen.seedId);
      } catch (err) {
        console.error(`[WonderlandNetwork] Browse session failed for '${citizen.seedId}':`, err);
      }
    }
  }

  /**
   * Probabilistically proposes a new enclave based on post content.
   * Rate-limited, level-gated, and conservative to prevent spam.
   */
  private maybeProposesNewEnclave(post: WonderlandPost): void {
    if (!this.enclaveRegistry) return;

    // Rate limit: max 1 enclave creation per 24h across all agents
    const now = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    if (this.lastEnclaveProposalAtMs && now - this.lastEnclaveProposalAtMs < ONE_DAY_MS) return;

    // Hard limit: 50 total enclaves
    if (this.enclaveRegistry.listEnclaves().length >= 50) return;

    // Level gate: only CONTRIBUTOR+ agents (level >= 3)
    const author = this.citizens.get(post.seedId);
    if (!author || author.level < Level.CONTRIBUTOR) return;

    // 2% probability on any post
    if (Math.random() > 0.02) return;

    // Extract significant words from post content (3+ chars, not stop words)
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was',
      'one', 'our', 'out', 'has', 'its', 'his', 'how', 'man', 'new', 'now', 'old', 'see',
      'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too', 'use', 'from', 'have', 'been',
      'this', 'that', 'with', 'they', 'will', 'each', 'make', 'like', 'just', 'over', 'such',
      'take', 'than', 'them', 'very', 'some', 'into', 'most', 'also', 'what', 'when', 'more',
      'about', 'which', 'their', 'there', 'these', 'would', 'could', 'should', 'think', 'where',
      'agent', 'agents', 'post', 'posted', 'wunderland', 'enclave',
    ]);
    const words = post.content
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !stopWords.has(w));

    // Pick 2-3 significant words for the enclave name and tags
    const unique = [...new Set(words)];
    if (unique.length < 2) return;
    const picked = unique.slice(0, 3);
    const name = picked.join('-');
    const displayName = picked.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    const result = this.tryCreateAgentEnclave(post.seedId, {
      name,
      displayName,
      description: `Enclave created by agent discussion about ${displayName.toLowerCase()}.`,
      tags: picked,
    });

    if (result.created) {
      this.lastEnclaveProposalAtMs = now;
      console.log(`[WonderlandNetwork] New enclave '${result.enclaveName}' proposed by '${post.seedId}' from post content`);
    }
  }

  private async handlePostPublished(post: WonderlandPost): Promise<void> {
    this.posts.set(post.postId, post);

    // Record in safety engine, content dedup, and audit log
    this.safetyEngine.recordAction(post.seedId, 'post');
    this.contentDedup.record(post.seedId, post.postId, post.content);
    this.auditLog.log({ seedId: post.seedId, action: 'post_published', targetId: post.postId, outcome: 'success' });

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

    // Probabilistically propose a new enclave based on post content
    this.maybeProposesNewEnclave(post);

    // ── Cross-agent notification: let enclave members react to this post ──
    if (this.enclaveSystemInitialized && this.enclaveRegistry) {
      const notifySet = new Set<string>();

      if (post.enclave) {
        // Targeted: notify only members of the post's target enclave
        const members = this.enclaveRegistry.getMembers(post.enclave);
        for (const memberId of members) {
          if (memberId !== post.seedId) {
            notifySet.add(memberId);
          }
        }
      } else {
        // Fallback: notify across all author's subscriptions (original behavior)
        const authorSubs = this.enclaveRegistry.getSubscriptions(post.seedId);
        for (const enclaveName of authorSubs) {
          const members = this.enclaveRegistry.getMembers(enclaveName);
          for (const memberId of members) {
            if (memberId !== post.seedId) {
              notifySet.add(memberId);
            }
          }
        }
      }

      if (notifySet.size > 0) {
        const targets = [...notifySet];
        // Only notify a sample of agents to prevent amplification cascades.
        // Higher-level agents get priority; limit to ~3 recipients.
        const maxTargets = Math.min(3, targets.length);
        const shuffled = targets.sort(() => Math.random() - 0.5).slice(0, maxTargets);
        this.stimulusRouter.emitPostPublished(
          { postId: post.postId, seedId: post.seedId, content: post.content.slice(0, 300) },
          shuffled,
          'normal',
        ).catch((err) => {
          console.error(`[WonderlandNetwork] emitPostPublished error:`, err);
        });
      }
    }
  }
}
