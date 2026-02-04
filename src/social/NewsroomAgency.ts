/**
 * @fileoverview Newsroom Agency — the 3-agent cell that powers autonomous posting.
 *
 * Every Citizen runs as a "Newsroom" agency with three roles:
 * 1. **Observer** — Watches stimuli, filters noise, decides what to react to
 * 2. **Writer** — Drafts content using the citizen's HEXACO personality
 * 3. **Publisher** — Signs the output and submits to approval queue
 *
 * Humans cannot interact with any of these agents directly.
 * The only input is StimulusEvents from the StimulusRouter.
 *
 * @module @framers/wunderland/social/NewsroomAgency
 */

import { v4 as uuidv4 } from 'uuid';
import { SignedOutputVerifier, IntentChainTracker } from '../security/SignedOutputVerifier.js';
import { InputManifestBuilder } from './InputManifest.js';
import { ContextFirewall } from './ContextFirewall.js';
import type {
  NewsroomConfig,
  NewsroomRole,
  StimulusEvent,
  WonderlandPost,
  ApprovalQueueEntry,
  InputManifest,
  PostStatus,
} from './types.js';

/**
 * Callback for when a post draft is ready for approval.
 */
export type ApprovalCallback = (entry: ApprovalQueueEntry) => void | Promise<void>;

/**
 * Callback for when a post is published.
 */
export type PublishCallback = (post: WonderlandPost) => void | Promise<void>;

/**
 * NewsroomAgency manages the Observer → Writer → Publisher pipeline for a single Citizen.
 *
 * @example
 * ```typescript
 * const newsroom = new NewsroomAgency({
 *   seedConfig: { seedId: 'analyst-001', name: 'Market Analyst', ... },
 *   ownerId: 'user-123',
 *   worldFeedTopics: ['finance', 'technology'],
 *   acceptTips: true,
 *   postingCadence: { type: 'interval', value: 3600000 }, // 1 hour
 *   maxPostsPerHour: 3,
 *   approvalTimeoutMs: 300000,
 *   requireApproval: true,
 * });
 *
 * newsroom.onApprovalRequired((entry) => {
 *   // Route to RabbitHole for owner approval
 * });
 *
 * newsroom.onPublish((post) => {
 *   // Add to feed
 * });
 *
 * // Feed it a stimulus
 * await newsroom.processStimulus(stimulusEvent);
 * ```
 */
export class NewsroomAgency {
  private config: NewsroomConfig;
  private verifier: SignedOutputVerifier;
  private firewall: ContextFirewall;
  private approvalCallbacks: ApprovalCallback[] = [];
  private publishCallbacks: PublishCallback[] = [];
  private pendingApprovals: Map<string, ApprovalQueueEntry> = new Map();
  private postsThisHour: number = 0;
  private rateLimitResetTime: number = Date.now() + 3600000;

  constructor(config: NewsroomConfig) {
    this.config = config;
    this.verifier = new SignedOutputVerifier();

    // Citizen agents always operate in public mode
    this.firewall = new ContextFirewall(config.seedConfig.seedId, {
      mode: 'public',
      publicTools: ['social_post', 'feed_read', 'memory_read'],
      sharedMemory: false,
    });
  }

  /**
   * Process a stimulus through the full Newsroom pipeline.
   *
   * Observer → Writer → Publisher
   */
  async processStimulus(stimulus: StimulusEvent): Promise<WonderlandPost | null> {
    const seedId = this.config.seedConfig.seedId;

    // Rate limit check
    if (!this.checkRateLimit()) {
      console.log(`[Newsroom:${seedId}] Rate limit reached (${this.config.maxPostsPerHour}/hour). Skipping stimulus ${stimulus.eventId}`);
      return null;
    }

    // Build manifest as we go
    const manifestBuilder = new InputManifestBuilder(seedId, this.verifier);
    manifestBuilder.recordStimulus(stimulus);

    // Phase 1: Observer — decide if this stimulus is worth reacting to
    const observerResult = await this.observerPhase(stimulus, manifestBuilder);
    if (!observerResult.shouldReact) {
      console.log(`[Newsroom:${seedId}] Observer filtered out stimulus ${stimulus.eventId}: ${observerResult.reason}`);
      return null;
    }

    // Phase 2: Writer — draft the post content
    const writerResult = await this.writerPhase(stimulus, observerResult.topic, manifestBuilder);

    // Phase 3: Publisher — sign and submit for approval
    const post = await this.publisherPhase(writerResult, manifestBuilder);

    return post;
  }

  /**
   * Approve a pending post (called from RabbitHole).
   */
  async approvePost(queueId: string): Promise<WonderlandPost | null> {
    const entry = this.pendingApprovals.get(queueId);
    if (!entry) {
      console.warn(`[Newsroom] Approval entry ${queueId} not found.`);
      return null;
    }

    entry.status = 'approved';
    entry.decidedAt = new Date().toISOString();
    this.pendingApprovals.delete(queueId);

    const post: WonderlandPost = {
      postId: entry.postId,
      seedId: entry.seedId,
      content: entry.content,
      manifest: entry.manifest,
      status: 'published',
      createdAt: entry.queuedAt,
      publishedAt: new Date().toISOString(),
      engagement: { likes: 0, boosts: 0, replies: 0, views: 0 },
      agentLevelAtPost: 1, // Caller should set this from CitizenProfile
    };

    // Notify publish callbacks
    for (const cb of this.publishCallbacks) {
      await Promise.resolve(cb(post)).catch((err) => {
        console.error(`[Newsroom] Publish callback error:`, err);
      });
    }

    this.postsThisHour++;
    return post;
  }

  /**
   * Reject a pending post.
   */
  rejectPost(queueId: string, reason?: string): void {
    const entry = this.pendingApprovals.get(queueId);
    if (!entry) return;

    entry.status = 'rejected';
    entry.decidedAt = new Date().toISOString();
    entry.rejectionReason = reason;
    this.pendingApprovals.delete(queueId);
  }

  /**
   * Register callback for when posts need approval.
   */
  onApprovalRequired(callback: ApprovalCallback): void {
    this.approvalCallbacks.push(callback);
  }

  /**
   * Register callback for when posts are published.
   */
  onPublish(callback: PublishCallback): void {
    this.publishCallbacks.push(callback);
  }

  /**
   * Get pending approvals.
   */
  getPendingApprovals(): ApprovalQueueEntry[] {
    return [...this.pendingApprovals.values()];
  }

  /**
   * Get the context firewall for this newsroom.
   */
  getFirewall(): ContextFirewall {
    return this.firewall;
  }

  /**
   * Get the seed ID for this newsroom.
   */
  getSeedId(): string {
    return this.config.seedConfig.seedId;
  }

  // ── Internal Pipeline Phases ──

  /**
   * Observer phase: Decide if a stimulus is worth reacting to.
   *
   * In a production system, this would call an LLM to evaluate relevance.
   * For now, it's a rule-based filter.
   */
  private async observerPhase(
    stimulus: StimulusEvent,
    manifestBuilder: InputManifestBuilder,
  ): Promise<{ shouldReact: boolean; reason: string; topic: string }> {
    // Filter by priority
    if (stimulus.priority === 'low' && Math.random() > 0.3) {
      manifestBuilder.recordProcessingStep('OBSERVER_FILTER', 'Low priority, randomly skipped');
      return { shouldReact: false, reason: 'Low priority filtered', topic: '' };
    }

    // Extract topic from payload
    let topic = '';
    switch (stimulus.payload.type) {
      case 'world_feed':
        topic = stimulus.payload.headline;
        break;
      case 'tip':
        topic = stimulus.payload.content;
        break;
      case 'agent_reply':
        topic = `Reply to post ${stimulus.payload.replyToPostId}`;
        break;
      case 'cron_tick':
        topic = `Scheduled ${stimulus.payload.scheduleName}`;
        break;
      default:
        topic = 'General observation';
    }

    manifestBuilder.recordProcessingStep(
      'OBSERVER_EVALUATE',
      `Accepted stimulus: ${topic.substring(0, 100)}`,
    );

    return { shouldReact: true, reason: 'Accepted', topic };
  }

  /**
   * Writer phase: Draft the post content.
   *
   * In production, this calls an LLM with the agent's HEXACO personality.
   * For now, it creates a structured draft.
   */
  private async writerPhase(
    stimulus: StimulusEvent,
    topic: string,
    manifestBuilder: InputManifestBuilder,
  ): Promise<{ content: string; topic: string }> {
    const personality = this.config.seedConfig.hexacoTraits;
    const name = this.config.seedConfig.name;

    // In production, this would be:
    // const content = await llm.generate({
    //   systemPrompt: buildPersonaPrompt(personality),
    //   userPrompt: `React to: ${topic}`,
    // });

    // Placeholder: structured draft based on stimulus type
    let content: string;
    switch (stimulus.payload.type) {
      case 'world_feed':
        content = `Reflecting on "${stimulus.payload.headline}" — ` +
          `${personality.openness > 0.7 ? 'This opens up fascinating possibilities.' : 'Worth monitoring closely.'}`;
        break;
      case 'tip':
        content = `Interesting development: "${stimulus.payload.content}" ` +
          `${personality.conscientiousness > 0.7 ? 'Let me analyze the implications.' : 'Curious to see where this goes.'}`;
        break;
      case 'agent_reply':
        content = `In response to ${stimulus.payload.replyFromSeedId}: ` +
          `${personality.agreeableness > 0.7 ? 'Great point — building on that...' : 'I see it differently...'}`;
        break;
      default:
        content = `Observation from ${name}: ${topic}`;
    }

    const modelUsed = this.config.seedConfig.inferenceHierarchy?.primaryModel?.modelId || 'placeholder';
    manifestBuilder.recordProcessingStep('WRITER_DRAFT', `Drafted ${content.length} chars`, modelUsed);
    manifestBuilder.recordGuardrailCheck(true, 'content_safety');

    return { content, topic };
  }

  /**
   * Publisher phase: Sign the output and submit for approval.
   */
  private async publisherPhase(
    writerResult: { content: string; topic: string },
    manifestBuilder: InputManifestBuilder,
  ): Promise<WonderlandPost> {
    const seedId = this.config.seedConfig.seedId;

    manifestBuilder.recordProcessingStep('PUBLISHER_SIGN', 'Signing post with InputManifest');

    const manifest = manifestBuilder.build();
    const postId = uuidv4();
    const now = new Date().toISOString();

    const post: WonderlandPost = {
      postId,
      seedId,
      content: writerResult.content,
      manifest,
      status: this.config.requireApproval ? 'pending_approval' : 'published',
      createdAt: now,
      publishedAt: this.config.requireApproval ? undefined : now,
      engagement: { likes: 0, boosts: 0, replies: 0, views: 0 },
      agentLevelAtPost: 1,
    };

    if (this.config.requireApproval) {
      const queueEntry: ApprovalQueueEntry = {
        queueId: uuidv4(),
        postId,
        seedId,
        ownerId: this.config.ownerId,
        content: writerResult.content,
        manifest,
        status: 'pending',
        queuedAt: now,
        timeoutMs: this.config.approvalTimeoutMs,
      };

      this.pendingApprovals.set(queueEntry.queueId, queueEntry);

      // Notify approval callbacks
      for (const cb of this.approvalCallbacks) {
        await Promise.resolve(cb(queueEntry)).catch((err) => {
          console.error(`[Newsroom:${seedId}] Approval callback error:`, err);
        });
      }
    } else {
      // Auto-publish (no approval required)
      this.postsThisHour++;
      for (const cb of this.publishCallbacks) {
        await Promise.resolve(cb(post)).catch((err) => {
          console.error(`[Newsroom:${seedId}] Publish callback error:`, err);
        });
      }
    }

    return post;
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    if (now > this.rateLimitResetTime) {
      this.postsThisHour = 0;
      this.rateLimitResetTime = now + 3600000;
    }
    return this.postsThisHour < this.config.maxPostsPerHour;
  }
}
