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
import type { IMoodPersistenceAdapter } from './MoodPersistence.js';
import type { IEnclavePersistenceAdapter } from './EnclavePersistence.js';
import type { IBrowsingPersistenceAdapter } from './BrowsingPersistence.js';
import type { LLMInvokeCallback } from './NewsroomAgency.js';
import type { ITool } from '@framers/agentos';
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

  /** Active newsroom agencies (seedId → NewsroomAgency) */
  private newsrooms: Map<string, NewsroomAgency> = new Map();

  /** Citizen profiles (seedId → CitizenProfile) */
  private citizens: Map<string, CitizenProfile> = new Map();

  /** Published posts (postId → WonderlandPost) */
  private posts: Map<string, WonderlandPost> = new Map();

  /** External post storage callback */
  private postStoreCallback?: PostStoreCallback;

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

  /** Browsing session log (seedId -> most recent session record) */
  private browsingSessionLog: Map<string, BrowsingSessionRecord> = new Map();

  // ── Persistence Adapters (optional, set before initializeEnclaveSystem) ──

  private moodPersistenceAdapter?: IMoodPersistenceAdapter;
  private enclavePersistenceAdapter?: IEnclavePersistenceAdapter;
  private browsingPersistenceAdapter?: IBrowsingPersistenceAdapter;

  constructor(config: WonderlandNetworkConfig) {
    this.config = config;
    this.stimulusRouter = new StimulusRouter();
    this.levelingEngine = new LevelingEngine();
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

    if (this.defaultLLMCallback) {
      newsroom.setLLMCallback(this.defaultLLMCallback);
    }
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
        typeFilter: ['world_feed', 'tip', 'agent_reply', 'cron_tick'],
        categoryFilter: newsroomConfig.worldFeedTopics,
      },
    );

    this.citizens.set(seedId, citizen);
    this.newsrooms.set(seedId, newsroom);

    // If enclave system is active, initialize mood and subscribe to matching enclaves
    if (this.enclaveSystemInitialized && this.moodEngine) {
      this.moodEngine.initializeAgent(seedId, newsroomConfig.seedConfig.hexacoTraits);
      this.autoSubscribeCitizenToEnclaves(seedId, newsroomConfig.worldFeedTopics);
    }

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
    _actorSeedId: string,
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
    for (const newsroom of this.newsrooms.values()) {
      newsroom.setLLMCallback(callback);
    }
  }

  /**
   * Set an LLM callback for a specific citizen's newsroom agency.
   */
  setLLMCallbackForCitizen(seedId: string, callback: LLMInvokeCallback): void {
    const newsroom = this.newsrooms.get(seedId);
    if (!newsroom) throw new Error(`Citizen '${seedId}' is not registered.`);
    newsroom.setLLMCallback(callback);
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
    this.browsingEngine = new BrowsingEngine(this.moodEngine, this.enclaveRegistry, this.postDecisionEngine);
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

    const sessionResult = this.browsingEngine.startSession(seedId, citizen.personality);

    const record: BrowsingSessionRecord = {
      seedId,
      enclavesVisited: sessionResult.enclavesVisited,
      postsRead: sessionResult.postsRead,
      commentsWritten: sessionResult.commentsWritten,
      votesCast: sessionResult.votesCast,
      startedAt: sessionResult.startedAt.toISOString(),
      finishedAt: sessionResult.finishedAt.toISOString(),
    };

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
    this.moodEngine.decayToBaseline(seedId, 1);

    return record;
  }

  /**
   * Get the most recent browsing session record for a seed.
   */
  getLastBrowsingSession(seedId: string): BrowsingSessionRecord | undefined {
    return this.browsingSessionLog.get(seedId);
  }

  // ── Internal ──

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
