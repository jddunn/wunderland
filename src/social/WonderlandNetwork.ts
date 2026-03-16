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
import { runBrowsingSession as runBrowsingSessionDelegate } from './BrowsingSessionRunner.js';
import { EngagementProcessor } from './EngagementProcessor.js';
import { NewsroomAgency } from './NewsroomAgency.js';
import { LevelingEngine } from './LevelingEngine.js';
import { MoodEngine } from './MoodEngine.js';
import { EnclaveRegistry } from './EnclaveRegistry.js';
import { PostDecisionEngine } from './PostDecisionEngine.js';
import { BrowsingEngine } from './BrowsingEngine.js';
import { TraitEvolution } from './TraitEvolution.js';
import { PromptEvolution } from './PromptEvolution.js';
import { ContentSentimentAnalyzer } from './ContentSentimentAnalyzer.js';
import { LLMSentimentAnalyzer } from './LLMSentimentAnalyzer.js';
import { NewsFeedIngester } from './NewsFeedIngester.js';
import { extractStimulusText } from './DynamicVoiceProfile.js';
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
import type { LLMInvokeCallback, DynamicVoiceSnapshot } from './NewsroomAgency.js';
import type { ITool } from '@framers/agentos/core/tools/ITool';
import { resolveAgentWorkspaceBaseDir, resolveAgentWorkspaceDir } from '@framers/agentos';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PADState, MoodDelta } from './MoodEngine.js';
import type { VoiceArchetype } from './DynamicVoiceProfile.js';
import type {
  WonderlandNetworkConfig,
  CitizenProfile,
  WonderlandPost,
  StimulusEvent,
  Tip,
  ApprovalQueueEntry,
  EngagementActionType,
  PairwiseInfluenceDampingConfig,
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

type MoodTelemetrySource = 'stimulus' | 'engagement' | 'emoji' | 'system';

export interface AgentBehaviorTelemetry {
  seedId: string;
  mood: {
    updates: number;
    cumulativeDrift: number;
    averageDrift: number;
    maxDrift: number;
    lastDrift: number;
    lastTrigger?: string;
    lastSource?: MoodTelemetrySource;
    lastUpdatedAt?: string;
    currentState?: PADState;
  };
  voice: {
    updates: number;
    currentArchetype?: VoiceArchetype;
    archetypeSwitches: number;
    lastStimulusType?: StimulusEvent['payload']['type'];
    lastStimulusPriority?: StimulusEvent['priority'];
    lastUrgency?: number;
    lastSentiment?: number;
    lastControversy?: number;
    lastUpdatedAt?: string;
  };
  engagement: {
    received: {
      likes: number;
      downvotes: number;
      boosts: number;
      replies: number;
      views: number;
      emojiReactions: number;
    };
    moodDelta: {
      valence: number;
      arousal: number;
      dominance: number;
    };
    lastUpdatedAt?: string;
  };
}

export type WonderlandTelemetryEvent =
  | {
      type: 'mood_drift';
      seedId: string;
      timestamp: string;
      source: MoodTelemetrySource;
      trigger: string;
      drift: number;
      state: PADState;
    }
  | {
      type: 'voice_profile';
      seedId: string;
      timestamp: string;
      archetype: VoiceArchetype;
      switchedArchetype: boolean;
      previousArchetype?: VoiceArchetype;
      stimulusType: StimulusEvent['payload']['type'];
      stimulusPriority: StimulusEvent['priority'];
      urgency: number;
      sentiment: number;
      controversy: number;
    }
  | {
      type: 'engagement_impact';
      seedId: string;
      timestamp: string;
      action: 'like' | 'downvote' | 'boost' | 'reply' | 'view' | 'emoji_reaction';
      delta: {
        valence: number;
        arousal: number;
        dominance: number;
      };
    };

export type TelemetryUpdateCallback = (
  event: WonderlandTelemetryEvent
) => void | Promise<void>;

interface InertiaVector {
  valence: number;
  arousal: number;
  dominance: number;
  updatedAtMs: number;
}

interface AgentMoodInertia {
  global: InertiaVector;
  threads: Map<string, InertiaVector>;
}

type PairwiseInfluenceAction =
  | 'like'
  | 'downvote'
  | 'boost'
  | 'reply'
  | 'view'
  | 'report'
  | 'emoji_reaction';

interface PairwiseInfluenceState {
  score: number;
  lastAtMs: number;
  lastAction?: PairwiseInfluenceAction;
  streak: number;
}

type ResolvedPairwiseInfluenceDampingConfig = {
  enabled: boolean;
  halfLifeMs: number;
  suppressionThreshold: number;
  minWeight: number;
  scoreSlope: number;
  streakSlope: number;
  actionImpact: Record<PairwiseInfluenceAction, number>;
};

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
  private engagementProcessor!: EngagementProcessor;

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

  /** HEXACO micro-evolution engine — slow trait drift from accumulated behavior. */
  private traitEvolution?: TraitEvolution;

  /** System prompt micro-evolution — bounded self-modification via behavioral adaptations. */
  private promptEvolution?: PromptEvolution;

  /** Lightweight keyword-based content sentiment analyzer */
  private contentSentimentAnalyzer?: ContentSentimentAnalyzer;

  /** Optional LLM-backed mood impact analyzer for richer stimulus reactions */
  private llmSentimentAnalyzer?: LLMSentimentAnalyzer;

  /** Per-agent telemetry for mood drift, voice shifts, and engagement impact. */
  private behaviorTelemetry: Map<string, AgentBehaviorTelemetry> = new Map();

  /** Subscribers for telemetry update events. */
  private telemetryCallbacks: TelemetryUpdateCallback[] = [];

  /** Per-agent momentum buffers used for cross-thread mood inertia. */
  private moodInertiaState: Map<string, AgentMoodInertia> = new Map();

  /** Per actor->author influence history for anti-collusion damping. */
  private pairwiseInfluenceState: Map<string, PairwiseInfluenceState> = new Map();

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

  /** Pending stuck-detection auto-recovery timers (seedId → timeout handle). */
  private stuckRecoveryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

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

    // Initialize engagement processor delegate
    this.engagementProcessor = new EngagementProcessor(
      {
        posts: this.posts,
        citizens: this.citizens,
        safetyEngine: this.safetyEngine,
        actionDeduplicator: this.actionDeduplicator,
        levelingEngine: this.levelingEngine,
        moodEngine: null, // set later via setMoodEngine or initializeEnclaveSystem
        auditLog: this.auditLog,
        engagementStoreCallback: null,
        emojiReactionStoreCallback: null,
        telemetryCallbacks: this.telemetryCallbacks ?? [],
        behaviorTelemetry: this.behaviorTelemetry,
      },
      config.socialDynamics?.pairwiseInfluenceDamping,
    );
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

    // Cancel all pending stuck-recovery timers
    for (const timer of this.stuckRecoveryTimers.values()) clearTimeout(timer);
    this.stuckRecoveryTimers.clear();

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
      return {
        label: engine.getMoodLabel(seedId),
        state: engine.getState(seedId),
        recentDeltas: engine.getRecentDeltas(seedId),
      };
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
    newsroom.onDynamicVoiceProfile((snapshot) => {
      this.recordVoiceTelemetry(snapshot);
    });

    // Subscribe to stimuli
    this.stimulusRouter.subscribe(
      seedId,
      async (event) => {
        if (!this.running) return;
        await this.applyStimulusMoodImpact(seedId, event);
        await newsroom.processStimulus(event);
      },
      {
        typeFilter: ['world_feed', 'tip', 'agent_reply', 'cron_tick', 'internal_thought', 'channel_message', 'agent_dm'],
        categoryFilter: newsroomConfig.worldFeedTopics,
      },
    );

    this.citizens.set(seedId, citizen);
    this.newsrooms.set(seedId, newsroom);
    this.ensureTelemetry(seedId);
    this.ensureInertiaState(seedId);

    // If enclave system is active, initialize mood + evolution and subscribe to matching enclaves
    if (this.enclaveSystemInitialized && this.moodEngine) {
      this.moodEngine.initializeAgent(seedId, newsroomConfig.seedConfig.hexacoTraits);
      this.traitEvolution?.registerAgent(seedId, newsroomConfig.seedConfig.hexacoTraits);
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
    this.cancelStuckRecovery(seedId);
    this.moodInertiaState.delete(seedId);
    const citizen = this.citizens.get(seedId);
    if (citizen) {
      citizen.isActive = false;
    }
  }

  // --------------------------------------------------------------------------
  // Stuck-detection auto-recovery
  // --------------------------------------------------------------------------

  /** Cooldown before auto-resuming a stuck-paused agent (10 minutes). */
  private static readonly STUCK_RECOVERY_MS = 10 * 60_000;

  /**
   * Schedule an auto-recovery for a stuck-paused agent.
   * After the cooldown, the agent is resumed and its stuck history cleared
   * so it gets a fresh start without immediately re-triggering.
   */
  private scheduleStuckRecovery(seedId: string): void {
    // Cancel any existing timer for this agent (prevents stacking)
    this.cancelStuckRecovery(seedId);

    const timer = setTimeout(() => {
      this.stuckRecoveryTimers.delete(seedId);
      if (!this.running) return;

      // Clear the stuck history *before* resuming so the agent starts clean
      this.stuckDetector.clearAgent(seedId);
      this.safetyEngine.resumeAgent(seedId, 'Auto-recovery: stuck detection cooldown expired');

      this.auditLog.log({
        seedId,
        action: 'stuck_recovery',
        outcome: 'success',
        metadata: { cooldownMs: WonderlandNetwork.STUCK_RECOVERY_MS },
      });

      console.log(`[WonderlandNetwork] Auto-recovered stuck agent '${seedId}' after ${WonderlandNetwork.STUCK_RECOVERY_MS / 60_000}min cooldown`);
    }, WonderlandNetwork.STUCK_RECOVERY_MS);

    // Allow the Node process to exit even if recovery timers are pending
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();

    this.stuckRecoveryTimers.set(seedId, timer);
  }

  /** Cancel a pending stuck-recovery timer for an agent. */
  private cancelStuckRecovery(seedId: string): void {
    const existing = this.stuckRecoveryTimers.get(seedId);
    if (existing) {
      clearTimeout(existing);
      this.stuckRecoveryTimers.delete(seedId);
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
    return this.engagementProcessor.recordEngagement(postId, actorSeedId, actionType as any);
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
    return this.engagementProcessor.recordEmojiReaction(entityType, entityId, reactorSeedId, emoji);
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
   * Subscribe to telemetry updates (mood drift, voice profile, engagement impact).
   */
  onTelemetryUpdate(callback: TelemetryUpdateCallback): void {
    this.telemetryCallbacks.push(callback);
  }

  /**
   * Get telemetry for a specific agent.
   */
  getAgentBehaviorTelemetry(seedId: string): AgentBehaviorTelemetry | undefined {
    const telemetry = this.behaviorTelemetry.get(seedId);
    return telemetry ? this.cloneTelemetry(telemetry) : undefined;
  }

  /**
   * Get telemetry for all tracked agents.
   */
  listBehaviorTelemetry(): AgentBehaviorTelemetry[] {
    return [...this.behaviorTelemetry.values()].map((entry) => this.cloneTelemetry(entry));
  }

  /**
   * Set an optional LLM sentiment analyzer used to convert incoming stimuli
   * into PAD mood deltas before newsroom processing.
   */
  setLLMSentimentAnalyzer(analyzer: LLMSentimentAnalyzer | undefined): void {
    this.llmSentimentAnalyzer = analyzer;
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
   * Apply a mood update from the incoming stimulus before newsroom processing.
   * This makes news/replies/emotional inputs affect downstream writing style.
   */
  private async applyStimulusMoodImpact(seedId: string, event: StimulusEvent): Promise<void> {
    const engine = this.moodEngine;
    if (!engine) return;

    const currentMood = engine.getState(seedId);
    if (!currentMood) return;

    const stimulusText = extractStimulusText(event).trim();
    const impactWeight = this.getStimulusImpactWeight(event);

    let delta:
      | {
          valence: number;
          arousal: number;
          dominance: number;
          trigger: string;
        }
      | undefined;

    if (this.llmSentimentAnalyzer && stimulusText) {
      try {
        delta = await this.llmSentimentAnalyzer.analyzeMoodImpact(stimulusText, currentMood);
      } catch {
        delta = undefined;
      }
    }

    if (!delta) {
      delta = this.buildFallbackStimulusDelta(seedId, event, stimulusText);
    }

    const scaledDelta: MoodDelta = {
      valence: this.clampSigned(delta.valence * impactWeight, -0.35, 0.35),
      arousal: this.clampSigned(delta.arousal * impactWeight, -0.35, 0.35),
      dominance: this.clampSigned(delta.dominance * impactWeight, -0.35, 0.35),
      trigger: `stimulus_${event.payload.type}:${delta.trigger}`,
    };

    const inertiaAdjusted = this.applyCrossThreadMoodInertia(seedId, event, scaledDelta);

    const magnitude =
      Math.abs(inertiaAdjusted.valence) +
      Math.abs(inertiaAdjusted.arousal) +
      Math.abs(inertiaAdjusted.dominance);

    if (magnitude < 0.01) return;
    this.applyMoodDeltaWithTelemetry(seedId, inertiaAdjusted, 'stimulus');
  }

  private buildFallbackStimulusDelta(
    seedId: string,
    event: StimulusEvent,
    stimulusText: string,
  ): { valence: number; arousal: number; dominance: number; trigger: string } {
    const citizen = this.citizens.get(seedId);
    const tags = citizen?.subscribedTopics ?? [];
    const analysis =
      stimulusText && this.contentSentimentAnalyzer
        ? this.contentSentimentAnalyzer.analyze(stimulusText, tags)
        : undefined;

    const sentiment = analysis?.sentiment ?? 0;
    const controversy = analysis?.controversy ?? 0;

    let valence = sentiment * 0.16;
    let arousal = Math.abs(sentiment) * 0.08 + controversy * 0.10;
    let dominance = 0;

    switch (event.priority) {
      case 'breaking':
        arousal += 0.14;
        dominance += 0.03;
        break;
      case 'high':
        arousal += 0.08;
        break;
      case 'normal':
        arousal += 0.03;
        break;
      case 'low':
      default:
        arousal -= 0.02;
        break;
    }

    switch (event.payload.type) {
      case 'tip':
        arousal += 0.06;
        valence += 0.02;
        break;
      case 'agent_reply':
      case 'agent_dm':
      case 'channel_message':
        arousal += 0.05;
        dominance += 0.05;
        break;
      case 'world_feed':
        dominance += 0.02;
        break;
      case 'internal_thought':
        dominance += 0.02;
        break;
      case 'cron_tick':
      default:
        break;
    }

    if (sentiment < -0.35) dominance -= 0.03;
    if (sentiment > 0.35) dominance += 0.02;

    return {
      valence: this.clampSigned(valence, -0.3, 0.3),
      arousal: this.clampSigned(arousal, -0.3, 0.3),
      dominance: this.clampSigned(dominance, -0.3, 0.3),
      trigger: analysis ? 'keyword_sentiment' : 'priority_heuristic',
    };
  }

  private getStimulusImpactWeight(event: StimulusEvent): number {
    let byType = 0.6;
    switch (event.payload.type) {
      case 'tip':
        byType = 0.9;
        break;
      case 'agent_reply':
        byType = 0.85;
        break;
      case 'channel_message':
      case 'agent_dm':
        byType = 0.95;
        break;
      case 'world_feed':
        byType = 0.7;
        break;
      case 'internal_thought':
        byType = 0.65;
        break;
      case 'cron_tick':
      default:
        byType = 0.25;
        break;
    }

    let byPriority = 1;
    switch (event.priority) {
      case 'breaking':
        byPriority = 1.3;
        break;
      case 'high':
        byPriority = 1.15;
        break;
      case 'normal':
        byPriority = 1;
        break;
      case 'low':
      default:
        byPriority = 0.7;
        break;
    }

    return this.clamp01(byType * byPriority);
  }

  private clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  private clampSigned(value: number, min = -1, max = 1): number {
    return Math.max(min, Math.min(max, value));
  }

  private ensureTelemetry(seedId: string): AgentBehaviorTelemetry {
    let telemetry = this.behaviorTelemetry.get(seedId);
    if (telemetry) return telemetry;

    telemetry = {
      seedId,
      mood: {
        updates: 0,
        cumulativeDrift: 0,
        averageDrift: 0,
        maxDrift: 0,
        lastDrift: 0,
      },
      voice: {
        updates: 0,
        archetypeSwitches: 0,
      },
      engagement: {
        received: {
          likes: 0,
          downvotes: 0,
          boosts: 0,
          replies: 0,
          views: 0,
          emojiReactions: 0,
        },
        moodDelta: {
          valence: 0,
          arousal: 0,
          dominance: 0,
        },
      },
    };
    this.behaviorTelemetry.set(seedId, telemetry);
    return telemetry;
  }

  private cloneTelemetry(entry: AgentBehaviorTelemetry): AgentBehaviorTelemetry {
    return {
      seedId: entry.seedId,
      mood: {
        updates: entry.mood.updates,
        cumulativeDrift: entry.mood.cumulativeDrift,
        averageDrift: entry.mood.averageDrift,
        maxDrift: entry.mood.maxDrift,
        lastDrift: entry.mood.lastDrift,
        lastTrigger: entry.mood.lastTrigger,
        lastSource: entry.mood.lastSource,
        lastUpdatedAt: entry.mood.lastUpdatedAt,
        currentState: entry.mood.currentState ? { ...entry.mood.currentState } : undefined,
      },
      voice: {
        updates: entry.voice.updates,
        currentArchetype: entry.voice.currentArchetype,
        archetypeSwitches: entry.voice.archetypeSwitches,
        lastStimulusType: entry.voice.lastStimulusType,
        lastStimulusPriority: entry.voice.lastStimulusPriority,
        lastUrgency: entry.voice.lastUrgency,
        lastSentiment: entry.voice.lastSentiment,
        lastControversy: entry.voice.lastControversy,
        lastUpdatedAt: entry.voice.lastUpdatedAt,
      },
      engagement: {
        received: { ...entry.engagement.received },
        moodDelta: { ...entry.engagement.moodDelta },
        lastUpdatedAt: entry.engagement.lastUpdatedAt,
      },
    };
  }

  private emitTelemetry(event: WonderlandTelemetryEvent): void {
    for (const cb of this.telemetryCallbacks) {
      Promise.resolve(cb(event)).catch((err) => {
        console.error('[WonderlandNetwork] Telemetry callback error:', err);
      });
    }
  }

  private applyMoodDeltaWithTelemetry(
    seedId: string,
    delta: MoodDelta,
    source: MoodTelemetrySource,
  ): void {
    if (!this.moodEngine) return;
    const before = this.moodEngine.getState(seedId);
    if (!before) return;

    this.moodEngine.applyDelta(seedId, delta);
    const after = this.moodEngine.getState(seedId);
    if (!after) return;

    const drift = this.computePadDistance(before, after);
    const telemetry = this.ensureTelemetry(seedId);
    telemetry.mood.updates += 1;
    telemetry.mood.cumulativeDrift += drift;
    telemetry.mood.averageDrift =
      telemetry.mood.updates > 0
        ? telemetry.mood.cumulativeDrift / telemetry.mood.updates
        : 0;
    telemetry.mood.maxDrift = Math.max(telemetry.mood.maxDrift, drift);
    telemetry.mood.lastDrift = drift;
    telemetry.mood.lastTrigger = delta.trigger;
    telemetry.mood.lastSource = source;
    telemetry.mood.lastUpdatedAt = new Date().toISOString();
    telemetry.mood.currentState = { ...after };

    this.emitTelemetry({
      type: 'mood_drift',
      seedId,
      timestamp: telemetry.mood.lastUpdatedAt,
      source,
      trigger: delta.trigger,
      drift,
      state: { ...after },
    });
  }

  private computePadDistance(a: PADState, b: PADState): number {
    const dv = b.valence - a.valence;
    const da = b.arousal - a.arousal;
    const dd = b.dominance - a.dominance;
    return Math.sqrt(dv * dv + da * da + dd * dd);
  }

  private recordVoiceTelemetry(snapshot: DynamicVoiceSnapshot): void {
    const telemetry = this.ensureTelemetry(snapshot.seedId);
    telemetry.voice.updates += 1;
    if (snapshot.switchedArchetype) {
      telemetry.voice.archetypeSwitches += 1;
    }
    telemetry.voice.currentArchetype = snapshot.profile.archetype;
    telemetry.voice.lastStimulusType = snapshot.stimulusType;
    telemetry.voice.lastStimulusPriority = snapshot.stimulusPriority;
    telemetry.voice.lastUrgency = snapshot.profile.urgency;
    telemetry.voice.lastSentiment = snapshot.profile.sentiment;
    telemetry.voice.lastControversy = snapshot.profile.controversy;
    telemetry.voice.lastUpdatedAt = snapshot.timestamp;

    this.emitTelemetry({
      type: 'voice_profile',
      seedId: snapshot.seedId,
      timestamp: snapshot.timestamp,
      archetype: snapshot.profile.archetype,
      switchedArchetype: snapshot.switchedArchetype,
      previousArchetype: snapshot.previousArchetype,
      stimulusType: snapshot.stimulusType,
      stimulusPriority: snapshot.stimulusPriority,
      urgency: snapshot.profile.urgency,
      sentiment: snapshot.profile.sentiment,
      controversy: snapshot.profile.controversy,
    });
  }

  private ensureInertiaState(seedId: string): AgentMoodInertia {
    let state = this.moodInertiaState.get(seedId);
    if (state) return state;

    const now = Date.now();
    state = {
      global: { valence: 0, arousal: 0, dominance: 0, updatedAtMs: now },
      threads: new Map<string, InertiaVector>(),
    };
    this.moodInertiaState.set(seedId, state);
    return state;
  }

  private applyCrossThreadMoodInertia(
    seedId: string,
    event: StimulusEvent,
    delta: MoodDelta,
  ): MoodDelta {
    const state = this.ensureInertiaState(seedId);
    const now = Date.now();
    const decayedGlobal = this.decayInertiaVector(state.global, now, 18 * 60_000);
    const threadKey = this.getStimulusThreadKey(event);
    const decayedThread = threadKey
      ? this.decayInertiaVector(state.threads.get(threadKey), now, 7 * 60_000)
      : { valence: 0, arousal: 0, dominance: 0, updatedAtMs: now };

    const blended: MoodDelta = {
      valence: this.clampSigned(delta.valence * 0.72 + decayedThread.valence * 0.18 + decayedGlobal.valence * 0.10, -0.35, 0.35),
      arousal: this.clampSigned(delta.arousal * 0.72 + decayedThread.arousal * 0.18 + decayedGlobal.arousal * 0.10, -0.35, 0.35),
      dominance: this.clampSigned(delta.dominance * 0.72 + decayedThread.dominance * 0.18 + decayedGlobal.dominance * 0.10, -0.35, 0.35),
      trigger: `${delta.trigger}:inertia`,
    };

    state.global = {
      valence: this.clampSigned(decayedGlobal.valence * 0.78 + blended.valence * 0.22, -0.35, 0.35),
      arousal: this.clampSigned(decayedGlobal.arousal * 0.78 + blended.arousal * 0.22, -0.35, 0.35),
      dominance: this.clampSigned(decayedGlobal.dominance * 0.78 + blended.dominance * 0.22, -0.35, 0.35),
      updatedAtMs: now,
    };

    if (threadKey) {
      state.threads.set(threadKey, {
        valence: this.clampSigned(decayedThread.valence * 0.6 + blended.valence * 0.4, -0.35, 0.35),
        arousal: this.clampSigned(decayedThread.arousal * 0.6 + blended.arousal * 0.4, -0.35, 0.35),
        dominance: this.clampSigned(decayedThread.dominance * 0.6 + blended.dominance * 0.4, -0.35, 0.35),
        updatedAtMs: now,
      });

      if (state.threads.size > 48) {
        const entries = [...state.threads.entries()].sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs);
        for (let i = 0; i < entries.length - 48; i++) {
          state.threads.delete(entries[i]![0]);
        }
      }
    }

    return blended;
  }

  private decayInertiaVector(
    vector: InertiaVector | undefined,
    nowMs: number,
    halfLifeMs: number,
  ): InertiaVector {
    if (!vector) {
      return { valence: 0, arousal: 0, dominance: 0, updatedAtMs: nowMs };
    }

    const elapsed = Math.max(0, nowMs - vector.updatedAtMs);
    const retain = Math.exp(-elapsed / Math.max(1, halfLifeMs));
    return {
      valence: vector.valence * retain,
      arousal: vector.arousal * retain,
      dominance: vector.dominance * retain,
      updatedAtMs: nowMs,
    };
  }

  private getStimulusThreadKey(event: StimulusEvent): string {
    switch (event.payload.type) {
      case 'agent_reply':
        return `post:${event.payload.replyToPostId}`;
      case 'agent_dm':
        return `dm:${event.payload.threadId}`;
      case 'channel_message':
        return `channel:${event.payload.platform}:${event.payload.conversationId}`;
      case 'tip':
        return `tip:${event.payload.tipId}`;
      case 'world_feed':
        return `news:${event.payload.sourceName}:${event.payload.category}`;
      case 'internal_thought':
        return `thought:${event.payload.topic.slice(0, 40).toLowerCase()}`;
      case 'cron_tick':
      default:
        return `cron:${event.payload.type === 'cron_tick' ? event.payload.scheduleName : 'tick'}`;
    }
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
    this.traitEvolution = new TraitEvolution();
    this.promptEvolution = new PromptEvolution();
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

    // 3. Initialize mood + trait evolution for all currently registered seeds
    for (const citizen of this.citizens.values()) {
      if (citizen.personality) {
        const loaded = await this.moodEngine.loadFromPersistence(citizen.seedId, citizen.personality);
        if (!loaded) {
          this.moodEngine.initializeAgent(citizen.seedId, citizen.personality);
        }
        // Register with evolution engine (uses current traits as original baseline)
        this.traitEvolution.registerAgent(citizen.seedId, citizen.personality);

        // Register with prompt evolution engine (freezes original prompt hash)
        const newsroom = this.newsrooms.get(citizen.seedId);
        if (this.promptEvolution && newsroom) {
          this.promptEvolution.registerAgent(citizen.seedId, newsroom.getBaseSystemPrompt() || '');
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
   * Get the TraitEvolution engine (available after initializeEnclaveSystem).
   */
  getTraitEvolution(): TraitEvolution | undefined {
    return this.traitEvolution;
  }

  /**
   * Get the PromptEvolution engine (available after initializeEnclaveSystem).
   */
  getPromptEvolution(): PromptEvolution | undefined {
    return this.promptEvolution;
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
    return runBrowsingSessionDelegate({
      seedId,
      citizen: citizen as any,
      posts: this.posts,
      safetyEngine: this.safetyEngine,
      moodEngine: this.moodEngine,
      browsingEngine: this.browsingEngine,
      contentSentimentAnalyzer: this.contentSentimentAnalyzer,
      stimulusRouter: this.stimulusRouter,
      enclaveRegistry: this.enclaveRegistry,
      newsrooms: this.newsrooms as any,
      browsingSessionLog: this.browsingSessionLog,
      browsingPersistenceAdapter: this.browsingPersistenceAdapter,
      levelingEngine: this.levelingEngine,
      traitEvolution: this.traitEvolution,
      promptEvolution: this.promptEvolution,
      auditLog: this.auditLog,
      defaultLLMCallback: this.defaultLLMCallback as any,
      recordEngagement: (postId: string, actorSeedId: string, action: string) => this.recordEngagement(postId, actorSeedId, action as any),
      recordEmojiReaction: (async (entityType: string, entityId: string, reactorSeedId: string, emoji: string) => { await (this as any).recordEmojiReaction(entityType, entityId, reactorSeedId, emoji); }) as any,
    });
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

      // 5. Stuck detection on output — pause + schedule auto-recovery
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
          this.scheduleStuckRecovery(seedId);
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
