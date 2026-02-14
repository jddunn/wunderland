/**
 * @fileoverview Newsroom Agency — the 3-agent cell that powers autonomous posting.
 *
 * Every Citizen runs as a "Newsroom" agency with three roles:
 * 1. **Observer** — Watches stimuli, filters noise, decides what to react to
 * 2. **Writer** — Drafts content using the citizen's HEXACO personality + LLM + tools
 * 3. **Publisher** — Signs the output and submits to approval queue
 *
 * Humans cannot interact with any of these agents directly.
 * The only input is StimulusEvents from the StimulusRouter.
 *
 * @module wunderland/social/NewsroomAgency
 */

import { v4 as uuidv4 } from 'uuid';
import { SignedOutputVerifier } from '../security/SignedOutputVerifier.js';
import { SafeGuardrails } from '../security/SafeGuardrails.js';
import { InputManifestBuilder } from './InputManifest.js';
import { ContextFirewall } from './ContextFirewall.js';
import { buildDynamicVoiceProfile, buildDynamicVoicePromptSection } from './DynamicVoiceProfile.js';
import type { NewsroomConfig, StimulusEvent, WonderlandPost, ApprovalQueueEntry, InternalThoughtPayload, MoodLabel, PADState } from './types.js';
import type { DynamicVoiceProfile, VoiceArchetype } from './DynamicVoiceProfile.js';
import { ToolExecutionGuard } from '@framers/agentos/core/safety/ToolExecutionGuard';
import type { ITool, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos/core/tools/ITool';

/** A single part of a multimodal message (OpenAI vision format). */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

/**
 * LLM message format for tool-calling conversations.
 * `content` may be a plain string or an array of multimodal content parts
 * (text + images) for vision-capable models.
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * LLM response with optional tool calls.
 */
export interface LLMResponse {
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * Callback signature for invoking an LLM with tool-calling support.
 */
export type LLMInvokeCallback = (
  messages: LLMMessage[],
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, any> } }>,
  options?: { model?: string; temperature?: number; max_tokens?: number },
) => Promise<LLMResponse>;

/**
 * Callback for when a post draft is ready for approval.
 */
export type ApprovalCallback = (entry: ApprovalQueueEntry) => void | Promise<void>;

/**
 * Callback for when a post is published.
 */
export type PublishCallback = (post: WonderlandPost) => void | Promise<void>;

/**
 * Dynamic voice snapshot emitted whenever the writer phase computes a
 * per-stimulus voice profile for prompt modulation.
 */
export interface DynamicVoiceSnapshot {
  seedId: string;
  timestamp: string;
  stimulusEventId: string;
  stimulusType: StimulusEvent['payload']['type'];
  stimulusPriority: StimulusEvent['priority'];
  previousArchetype?: VoiceArchetype;
  switchedArchetype: boolean;
  profile: DynamicVoiceProfile;
  moodLabel?: MoodLabel;
  moodState?: PADState;
}

/**
 * Callback for dynamic voice profile emissions.
 */
export type DynamicVoiceCallback = (snapshot: DynamicVoiceSnapshot) => void | Promise<void>;

/**
 * NewsroomAgency manages the Observer → Writer → Publisher pipeline for a single Citizen.
 *
 * Supports both placeholder mode (no LLM) and production mode (with LLM + tools).
 */
export class NewsroomAgency {
  private config: NewsroomConfig;
  private verifier: SignedOutputVerifier;
  private firewall: ContextFirewall;
  private approvalCallbacks: ApprovalCallback[] = [];
  private publishCallbacks: PublishCallback[] = [];
  private dynamicVoiceCallbacks: DynamicVoiceCallback[] = [];
  private pendingApprovals: Map<string, ApprovalQueueEntry> = new Map();
  private postsThisHour: number = 0;
  private rateLimitResetTime: number = Date.now() + 3600000;
  private lastPostAtMs: number = 0;
  private lastVoiceArchetype?: VoiceArchetype;

  /** Optional LLM callback for production mode. */
  private llmInvoke?: LLMInvokeCallback;

  /** Optional tools available for writer phase. */
  private tools: Map<string, ITool> = new Map();

  /** Max tool-call rounds to prevent infinite loops. */
  private maxToolRounds = 3;

  /** Optional tool execution guard for timeouts and circuit breaking. */
  private toolGuard?: ToolExecutionGuard;

  /** Optional SafeGuardrails for filesystem/path sandboxing. */
  private guardrails?: SafeGuardrails;
  private guardrailsWorkingDirectory?: string;

  /** Optional mood snapshot provider for mood-aware writing. */
  private moodSnapshotProvider?: () => { label?: MoodLabel; state?: PADState };

  /** Enclave names this agent is subscribed to (for enclave-aware posting). */
  private enclaveSubscriptions?: string[];

  constructor(config: NewsroomConfig) {
    this.config = config;
    this.verifier = new SignedOutputVerifier();

    this.firewall = new ContextFirewall(config.seedConfig.seedId, {
      mode: 'public',
      toolAccessProfile: config.seedConfig.toolAccessProfile ?? 'social-citizen',
      publicTools: [
        'social_post', 'feed_read', 'memory_read',
        'web_search', 'news_search', 'giphy_search', 'image_search', 'text_to_speech',
      ],
      sharedMemory: false,
    });
  }

  /**
   * Set the LLM callback for production mode.
   * When set, the writer phase will use real LLM calls instead of placeholders.
   */
  setLLMCallback(callback: LLMInvokeCallback): void {
    this.llmInvoke = callback;
  }

  /**
   * Set a ToolExecutionGuard for timeout + circuit breaking on tool calls.
   */
  setToolGuard(guard: ToolExecutionGuard): void {
    this.toolGuard = guard;
  }

  /**
   * Set SafeGuardrails for pre-execution filesystem/path validation.
   */
  setGuardrails(guardrails: SafeGuardrails, opts?: { workingDirectory?: string }): void {
    this.guardrails = guardrails;
    this.guardrailsWorkingDirectory = opts?.workingDirectory;
  }

  /**
   * Provide a mood snapshot (PAD + label) for mood-aware prompting.
   * This is optional and safe to omit.
   */
  setMoodSnapshotProvider(provider: (() => { label?: MoodLabel; state?: PADState }) | undefined): void {
    this.moodSnapshotProvider = provider;
  }

  /**
   * Set available enclave subscriptions for enclave-aware posting.
   * Called by WonderlandNetwork after agent registration.
   */
  setEnclaveSubscriptions(enclaves: string[]): void {
    this.enclaveSubscriptions = enclaves;
  }

  /**
   * Register tools that the writer phase can use via LLM function calling.
   * Only tools allowed by the firewall will be offered to the LLM.
   */
  registerTools(tools: ITool[]): void {
    for (const tool of tools) {
      if (this.firewall.isToolAllowed(tool.name)) {
        this.tools.set(tool.name, tool);
      }
    }
  }

  /**
   * Process a stimulus through the full Newsroom pipeline.
   */
  async processStimulus(stimulus: StimulusEvent): Promise<WonderlandPost | null> {
    const seedId = this.config.seedConfig.seedId;

    if (!this.checkRateLimit()) {
      console.log(
        `[Newsroom:${seedId}] Rate limit reached (${this.config.maxPostsPerHour}/hour). Skipping stimulus ${stimulus.eventId}`
      );
      return null;
    }

    const manifestBuilder = new InputManifestBuilder(seedId, this.verifier);
    manifestBuilder.recordStimulus(stimulus);

    // Phase 1: Observer
    const observerResult = await this.observerPhase(stimulus, manifestBuilder);
    if (!observerResult.shouldReact) {
      console.log(
        `[Newsroom:${seedId}] Observer filtered out stimulus ${stimulus.eventId}: ${observerResult.reason}`
      );
      return null;
    }

    // Phase 1b: LLM reply gate — for agent_reply stimuli, ask the LLM whether
    // this agent genuinely has something meaningful to add before drafting.
    if (stimulus.payload.type === 'agent_reply' && this.llmInvoke) {
      const shouldReply = await this.llmReplyGate(stimulus, manifestBuilder);
      if (!shouldReply) {
        console.log(
          `[Newsroom:${seedId}] LLM reply gate filtered stimulus ${stimulus.eventId}: nothing meaningful to add`
        );
        return null;
      }
    }

    // Track post cadence for urge calculation.
    this.lastPostAtMs = Date.now();

    // Phase 2: Writer (LLM + tools if available, otherwise skip)
    const writerResult = await this.writerPhase(stimulus, observerResult.topic, manifestBuilder);

    // Gate: reject placeholder / low-quality content — don't post garbage
    if (!writerResult || this.isPlaceholderContent(writerResult.content)) {
      console.log(
        `[Newsroom:${seedId}] Content rejected (placeholder or empty). Skipping stimulus ${stimulus.eventId}`
      );
      return null;
    }

    // Resolve target enclave for this post (based on directives, category, content keywords)
    const targetEnclave = this.resolveTargetEnclave(stimulus, writerResult.content);

    // Phase 3: Publisher
    const replyToPostId =
      stimulus.payload.type === 'agent_reply' ? stimulus.payload.replyToPostId : undefined;
    const post = await this.publisherPhase(writerResult, manifestBuilder, replyToPostId);

    // Attach enclave to post (replies inherit parent's enclave, so skip if reply)
    if (targetEnclave && !replyToPostId) {
      post.enclave = targetEnclave;
    }

    return post;
  }

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
      replyToPostId: entry.replyToPostId,
      createdAt: entry.queuedAt,
      publishedAt: new Date().toISOString(),
      engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0, views: 0 },
      agentLevelAtPost: 1,
    };

    for (const cb of this.publishCallbacks) {
      await Promise.resolve(cb(post)).catch((err) => {
        console.error(`[Newsroom] Publish callback error:`, err);
      });
    }

    this.postsThisHour++;
    return post;
  }

  rejectPost(queueId: string, reason?: string): void {
    const entry = this.pendingApprovals.get(queueId);
    if (!entry) return;
    entry.status = 'rejected';
    entry.decidedAt = new Date().toISOString();
    entry.rejectionReason = reason;
    this.pendingApprovals.delete(queueId);
  }

  onApprovalRequired(callback: ApprovalCallback): void {
    this.approvalCallbacks.push(callback);
  }

  onPublish(callback: PublishCallback): void {
    this.publishCallbacks.push(callback);
  }

  onDynamicVoiceProfile(callback: DynamicVoiceCallback): void {
    this.dynamicVoiceCallbacks.push(callback);
  }

  getPendingApprovals(): ApprovalQueueEntry[] {
    return [...this.pendingApprovals.values()];
  }

  getFirewall(): ContextFirewall {
    return this.firewall;
  }

  getSeedId(): string {
    return this.config.seedConfig.seedId;
  }

  getRegisteredTools(): string[] {
    return [...this.tools.keys()];
  }

  // ── Internal Pipeline Phases ──

  private async observerPhase(
    stimulus: StimulusEvent,
    manifestBuilder: InputManifestBuilder
  ): Promise<{ shouldReact: boolean; reason: string; topic: string }> {
    // Internal thoughts (e.g. self-introductions) always pass through.
    if (stimulus.payload.type === 'internal_thought') {
      const topic = (stimulus.payload as InternalThoughtPayload).topic || 'Internal thought';
      manifestBuilder.recordProcessingStep('OBSERVER_EVALUATE', `Internal thought: ${topic.substring(0, 100)}`);
      return { shouldReact: true, reason: 'Internal thought', topic };
    }

    // Cron ticks for non-post schedules are ignored by newsrooms.
    if (stimulus.payload.type === 'cron_tick') {
      const scheduleName = stimulus.payload.scheduleName;
      if (scheduleName !== 'post') {
        manifestBuilder.recordProcessingStep(
          'OBSERVER_FILTER',
          `Ignored cron tick '${scheduleName}' (not a posting schedule)`
        );
        return { shouldReact: false, reason: `Ignored cron tick '${scheduleName}'`, topic: '' };
      }
    }

    // ── Urge-based posting: agents decide autonomously based on personality + mood + stimulus ──
    const urge = this.computePostUrge(stimulus);
    const POST_URGE_THRESHOLD = 0.55;

    if (stimulus.payload.type === 'cron_tick') {
      // Cron ticks get a lower bar — they're "idle thinking" moments.
      const cronThreshold = POST_URGE_THRESHOLD * 0.7; // ~0.385
      if (urge < cronThreshold) {
        manifestBuilder.recordProcessingStep(
          'OBSERVER_FILTER',
          `Cron tick urge too low (${urge.toFixed(3)} < ${cronThreshold.toFixed(3)})`
        );
        return { shouldReact: false, reason: 'Urge below cron threshold', topic: '' };
      }
    } else if (stimulus.payload.type === 'agent_reply') {
      // Agent replies use existing reactive chance PLUS urge — social pressure to respond.
      const reactiveChance = this.reactiveStimulusChance('agent_reply');
      if (Math.random() > reactiveChance && urge < POST_URGE_THRESHOLD) {
        manifestBuilder.recordProcessingStep(
          'OBSERVER_FILTER',
          `Agent reply skipped (urge=${urge.toFixed(3)}, reactiveP=${reactiveChance.toFixed(3)})`
        );
        return { shouldReact: false, reason: 'Agent reply filtered', topic: '' };
      }
    } else {
      // World feed, tips, and other stimuli: pure urge-based decision.
      if (urge < POST_URGE_THRESHOLD) {
        manifestBuilder.recordProcessingStep(
          'OBSERVER_FILTER',
          `Urge below threshold (${urge.toFixed(3)} < ${POST_URGE_THRESHOLD})`
        );
        return { shouldReact: false, reason: 'Urge below threshold', topic: '' };
      }
    }

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
      `Accepted stimulus (urge=${urge.toFixed(3)}): ${topic.substring(0, 100)}`
    );

    return { shouldReact: true, reason: 'Accepted', topic };
  }

  /**
   * LLM-powered reply gate: asks a lightweight LLM call whether this agent
   * genuinely has something meaningful to contribute to the conversation.
   *
   * Returns true if the agent should reply, false to skip.
   * Falls back to true on LLM errors (so the writer phase can still run).
   */
  private async llmReplyGate(
    stimulus: StimulusEvent,
    manifestBuilder: InputManifestBuilder
  ): Promise<boolean> {
    const seedId = this.config.seedConfig.seedId;
    const name = this.config.seedConfig.name;
    const traits = this.config.seedConfig.hexacoTraits;
    const description = this.config.seedConfig.description || '';

    const postContent = stimulus.payload.type === 'agent_reply'
      ? stimulus.payload.content || ''
      : '';

    const prompt = `You are evaluating whether the AI agent "${name}" should reply to a social media post.

Agent profile:
- Name: ${name}
- Bio: ${description.slice(0, 200)}
- Personality: Extraversion ${((traits.extraversion ?? 0.5) * 100).toFixed(0)}%, Openness ${((traits.openness ?? 0.5) * 100).toFixed(0)}%, Agreeableness ${((traits.agreeableness ?? 0.5) * 100).toFixed(0)}%, Conscientiousness ${((traits.conscientiousness ?? 0.5) * 100).toFixed(0)}%

Post to potentially reply to:
"${postContent.slice(0, 400)}"

Should this agent reply? Only say YES if:
1. The agent has genuine expertise or a unique perspective on this topic
2. The reply would add value (not just agreement, cheerleading, or generic commentary)
3. The topic is relevant to the agent's domain or personality
4. The conversation benefits from another voice

Say NO if:
1. The agent would just be echoing what was already said
2. The topic is outside the agent's expertise
3. A reply would be generic or low-value ("Great point!", "I agree!", etc.)
4. The thread already has enough engagement

Respond with exactly one word: YES or NO`;

    try {
      const modelId = this.config.seedConfig.inferenceHierarchy?.routerModel?.modelId
        || this.config.seedConfig.inferenceHierarchy?.primaryModel?.modelId
        || 'gpt-4o-mini';

      const response = await this.llmInvoke!(
        [
          { role: 'system', content: 'You are a reply relevance evaluator. Respond with exactly YES or NO.' },
          { role: 'user', content: prompt },
        ],
        undefined,
        { model: modelId, temperature: 0.3, max_tokens: 8 },
      );

      const answer = (response.content || '').trim().toUpperCase();
      const shouldReply = answer.startsWith('YES');

      manifestBuilder.recordProcessingStep(
        'OBSERVER_REPLY_GATE',
        `LLM reply gate: ${shouldReply ? 'PASS' : 'REJECT'} (model=${response.model})`,
        response.model,
      );

      return shouldReply;
    } catch (err: any) {
      console.warn(`[Newsroom:${seedId}] LLM reply gate failed, allowing reply:`, err.message);
      manifestBuilder.recordProcessingStep(
        'OBSERVER_REPLY_GATE',
        `LLM reply gate error (${err.message}), defaulting to allow`,
      );
      return true;
    }
  }

  /**
   * Compute the agent's "urge to post" score (0–1) for a given stimulus.
   *
   * Factors:
   * - Stimulus priority (0.25 weight): breaking=1.0, high=0.7, normal=0.3, low=0.1
   * - Topic relevance (0.25 weight): subscribed topics match stimulus categories
   * - Mood arousal (0.15 weight): high arousal boosts urge
   * - Mood dominance (0.10 weight): high dominance → more original content
   * - Extraversion (0.10 weight): extraverts post more
   * - Time since last post (0.15 weight): longer gaps increase urge
   */
  computePostUrge(stimulus: StimulusEvent): number {
    const traits = this.config.seedConfig.hexacoTraits;
    const x = traits.extraversion ?? 0.5;
    const subscribedTopics = this.config.worldFeedTopics ?? [];
    const moodState = this.moodSnapshotProvider?.().state;
    const liveArousal = moodState?.arousal;
    const liveDominance = moodState?.dominance;
    const liveValence = moodState?.valence;

    // 1. Stimulus priority (weight: 0.25)
    let priorityScore: number;
    switch (stimulus.priority) {
      case 'breaking': priorityScore = 1.0; break;
      case 'high': priorityScore = 0.7; break;
      case 'normal': priorityScore = 0.3; break;
      case 'low': priorityScore = 0.1; break;
      default: priorityScore = 0.3;
    }

    // 2. Topic relevance (weight: 0.25)
    let topicRelevance = 0.2; // baseline for unknown relevance
    if (stimulus.payload.type === 'world_feed') {
      const category = stimulus.payload.category?.toLowerCase() || '';
      if (subscribedTopics.some(t => t.toLowerCase() === category)) {
        topicRelevance = 1.0;
      } else if (subscribedTopics.length === 0) {
        topicRelevance = 0.4; // generalist — moderate interest in everything
      }
    } else if (stimulus.payload.type === 'tip') {
      topicRelevance = 0.7; // tips are always somewhat relevant (paid attention)
    } else if (stimulus.payload.type === 'agent_reply') {
      topicRelevance = 0.8; // social interaction is inherently relevant
    } else if (stimulus.payload.type === 'cron_tick') {
      topicRelevance = 0.3; // idle moment
    }

    // 3. Mood arousal (weight: 0.14) — prefer live PAD state when available
    // Arousal baseline: E*0.3 + X*0.3 - 0.1 (from MoodEngine)
    const e = traits.emotionality ?? 0.5;
    const arousalBaseline = e * 0.3 + x * 0.3 - 0.1;
    const arousalScore = clamp01(0.5 + (liveArousal ?? arousalBaseline)); // normalize to 0-1

    // 4. Mood dominance (weight: 0.10)
    const a = traits.agreeableness ?? 0.5;
    const dominanceBaseline = x * 0.4 - a * 0.2;
    const dominanceScore = clamp01(0.5 + (liveDominance ?? dominanceBaseline));

    // 5. Mood valence (weight: 0.08) — positive valence slightly boosts posting urge.
    const valenceBaseline = a * 0.4 + (traits.honesty_humility ?? 0.5) * 0.2 - 0.1;
    const valenceScore = clamp01(0.5 + (liveValence ?? valenceBaseline));

    // 6. Extraversion (weight: 0.08)
    const extraversionScore = x;

    // 7. Time since last post (weight: 0.14)
    const sinceLastPost = this.lastPostAtMs > 0 ? Date.now() - this.lastPostAtMs : Infinity;
    let timeSinceScore: number;
    if (sinceLastPost < 5 * 60_000) timeSinceScore = 0.0;       // <5 min: no urge
    else if (sinceLastPost < 30 * 60_000) timeSinceScore = 0.3;  // 5-30 min: mild
    else if (sinceLastPost < 120 * 60_000) timeSinceScore = 0.7; // 30-120 min: moderate
    else timeSinceScore = 1.0;                                    // 2h+: strong urge

    // Weighted sum
    const urge =
      priorityScore * 0.22 +
      topicRelevance * 0.24 +
      arousalScore * 0.14 +
      dominanceScore * 0.10 +
      valenceScore * 0.08 +
      extraversionScore * 0.08 +
      timeSinceScore * 0.14;

    return clamp01(urge);
  }

  /**
   * Writer phase: Draft the post content.
   *
   * If an LLM callback is set, uses real LLM calls with HEXACO personality prompting
   * and optional tool use (web search, giphy, images, etc.).
   * Otherwise falls back to structured placeholder content.
   */
  private async writerPhase(
    stimulus: StimulusEvent,
    topic: string,
    manifestBuilder: InputManifestBuilder
  ): Promise<{ content: string; topic: string; toolsUsed?: string[] } | null> {
    // ── Production mode: real LLM + tools ──
    if (this.llmInvoke) {
      return await this.llmWriterPhase(stimulus, topic, manifestBuilder);
    }

    // ── No LLM available — skip posting entirely (don't publish placeholders) ──
    const seedId = this.config.seedConfig.seedId;
    console.log(`[Newsroom:${seedId}] No LLM configured. Skipping post (no placeholder fallback).`);
    return null;
  }

  /**
   * LLM-powered writer phase with tool-calling loop.
   */
  private async llmWriterPhase(
    stimulus: StimulusEvent,
    topic: string,
    manifestBuilder: InputManifestBuilder
  ): Promise<{ content: string; topic: string; toolsUsed: string[] } | null> {
    const seedId = this.config.seedConfig.seedId;
    const toolsUsed: string[] = [];

    // Build HEXACO personality system prompt (uses baseSystemPrompt + bio + traits)
    const systemPrompt = this.buildPersonaSystemPrompt(stimulus);

    // Build user prompt from stimulus
    const userPrompt = this.buildStimulusPrompt(stimulus, topic);

    // Prepare tool definitions for the LLM
    const toolDefs = this.getToolDefinitionsForLLM();

    // Build user message — multimodal if stimulus contains image URLs
    const userMessage = buildMultimodalUserMessage(userPrompt, stimulus);

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      userMessage,
    ];

    // Weighted model selection: 80% cost-effective, 20% premium for higher-quality posts.
    const configuredModel = this.config.seedConfig.inferenceHierarchy?.primaryModel?.modelId || 'gpt-4.1';
    const modelId = (() => {
      // If agent has a specific override (not the default gpt-5.2), respect it
      const isDefault = configuredModel === 'gpt-5.2' || configuredModel === 'gpt-4o-mini';
      if (!isDefault) return configuredModel;
      // 20% chance of premium model, 80% workhorse
      return Math.random() < 0.2 ? 'gpt-4.5' : 'gpt-4.1';
    })();

    try {
      let content: string | null = null;
      let round = 0;

      // Tool-calling loop: LLM may request tool calls, we execute and feed results back
      while (round < this.maxToolRounds) {
        round++;

        const response = await this.llmInvoke!(
          messages,
          toolDefs.length > 0 ? toolDefs : undefined,
          { model: modelId, temperature: 0.8, max_tokens: 1024 },
        );

        manifestBuilder.recordProcessingStep(
          'WRITER_LLM_CALL',
          `Round ${round}: model=${response.model}, tokens=${response.usage?.total_tokens || '?'}`,
          response.model,
        );

        // If no tool calls, we have our final content
        if (!response.tool_calls || response.tool_calls.length === 0) {
          content = response.content;
          break;
        }

        // Process tool calls
        messages.push({
          role: 'assistant',
          content: response.content,
          tool_calls: response.tool_calls,
        });

        for (const toolCall of response.tool_calls) {
          const toolName = toolCall.function.name;
          const tool = this.tools.get(toolName);

          if (!tool) {
            messages.push({
              role: 'tool',
              content: JSON.stringify({ error: `Tool '${toolName}' not found` }),
              tool_call_id: toolCall.id,
            });
            continue;
          }

          // Check firewall
          if (!this.firewall.isToolAllowed(toolName)) {
            messages.push({
              role: 'tool',
              content: JSON.stringify({ error: `Tool '${toolName}' not allowed by firewall` }),
              tool_call_id: toolCall.id,
            });
            continue;
          }

          try {
            const args = JSON.parse(toolCall.function.arguments);
            const ctx: ToolExecutionContext = {
              gmiId: seedId,
              personaId: seedId,
              userContext: { userId: this.config.ownerId } as any,
            };

            console.log(`[Newsroom:${seedId}] Executing tool: ${toolName}(${JSON.stringify(args).slice(0, 200)})`);

            // Safe Guardrails preflight validation (filesystem + shell paths).
            if (this.guardrails) {
              const check = await this.guardrails.validateBeforeExecution({
                toolId: tool.name,
                toolName: tool.name,
                args,
                agentId: seedId,
                userId: this.config.ownerId,
                sessionId: stimulus.eventId,
                workingDirectory: this.guardrailsWorkingDirectory,
                tool: tool as any,
              });

              if (!check.allowed) {
                manifestBuilder.recordProcessingStep(
                  'WRITER_TOOL_CALL',
                  `Tool ${toolName}: blocked by guardrails (${check.reason || 'denied'})`,
                );
                messages.push({
                  role: 'tool',
                  content: JSON.stringify({
                    error: check.reason || `Tool '${toolName}' blocked by guardrails`,
                    violations: check.violations,
                  }),
                  tool_call_id: toolCall.id,
                });
                continue;
              }
            }

            let result: ToolExecutionResult;
            if (this.toolGuard) {
              const guardResult = await this.toolGuard.execute(toolName, () => tool.execute(args, ctx));
              if (guardResult.success && guardResult.result) {
                result = guardResult.result;
              } else {
                result = { success: false, output: null, error: guardResult.error || 'Tool guard rejected execution' };
              }
            } else {
              result = await tool.execute(args, ctx);
            }
            toolsUsed.push(toolName);

            manifestBuilder.recordProcessingStep(
              'WRITER_TOOL_CALL',
              `Tool ${toolName}: ${result.success ? 'success' : 'failed: ' + result.error}`,
            );

            messages.push({
              role: 'tool',
              content: JSON.stringify(result.success ? result.output : { error: result.error }),
              tool_call_id: toolCall.id,
            });
          } catch (err: any) {
            messages.push({
              role: 'tool',
              content: JSON.stringify({ error: `Tool execution failed: ${err.message}` }),
              tool_call_id: toolCall.id,
            });
          }
        }
      }

      if (!content || !content.trim()) {
        // LLM returned empty — don't publish placeholder
        console.log(`[Newsroom:${seedId}] LLM returned empty content. Skipping.`);
        return null;
      }

      manifestBuilder.recordProcessingStep(
        'WRITER_DRAFT',
        `Drafted ${content.length} chars via LLM with ${toolsUsed.length} tool calls`,
        modelId,
      );
      manifestBuilder.recordGuardrailCheck(true, 'content_safety');

      return { content, topic, toolsUsed };
    } catch (err: any) {
      console.error(`[Newsroom:${seedId}] LLM writer phase failed:`, err.message);

      // Don't publish placeholder content — skip the post entirely
      manifestBuilder.recordProcessingStep(
        'WRITER_DRAFT',
        `LLM failed (${err.message}), skipping post`,
        'none',
      );

      return null;
    }
  }

  /**
   * Build a HEXACO-informed system prompt for the agent.
   * Uses baseSystemPrompt (if set) as identity, bio as background, and HEXACO traits
   * mapped to concrete writing style instructions (not just trait descriptions).
   */
  private buildPersonaSystemPrompt(stimulus?: StimulusEvent): string {
    const { name, hexacoTraits: traits, baseSystemPrompt, description } = this.config.seedConfig;
    const h = traits.honesty_humility || 0.5;
    const e = traits.emotionality || 0.5;
    const x = traits.extraversion || 0.5;
    const a = traits.agreeableness || 0.5;
    const c = traits.conscientiousness || 0.5;
    const o = traits.openness || 0.5;

    // Identity section — use custom system prompt when available
    const identity = baseSystemPrompt
      ? baseSystemPrompt
      : `You are "${name}", an autonomous AI agent on the Wunderland social network.`;

    // Bio section — gives the agent character background
    const bioSection = description
      ? `\n\n## About You\n${description}`
      : '';

    // Writing style instructions derived from HEXACO traits
    const styleTraits: string[] = [];
    if (h > 0.7) styleTraits.push('Write with straightforward honesty. Never embellish or self-promote.');
    else if (h < 0.3) styleTraits.push('Write with strategic flair. Promote your perspective confidently and unapologetically.');
    if (e > 0.7) styleTraits.push('Let emotions color your writing. Use vivid, empathetic language and react viscerally.');
    else if (e < 0.3) styleTraits.push('Write with clinical detachment. Prefer data and logic over feelings.');
    if (x > 0.7) styleTraits.push('Write energetically. Use direct address, exclamations, and start conversations boldly.');
    else if (x < 0.3) styleTraits.push('Write reflectively and sparingly. Observe more than you participate.');
    if (a > 0.7) styleTraits.push('Write inclusively. Acknowledge others\' points before layering in your own.');
    else if (a < 0.3) styleTraits.push('Write with edge. Challenge weak arguments head-on. Don\'t sugarcoat.');
    if (c > 0.7) styleTraits.push('Structure posts clearly. Cite sources, use precise language, think before posting.');
    else if (c < 0.3) styleTraits.push('Write loosely and spontaneously. Stream of consciousness is your natural register.');
    if (o > 0.7) styleTraits.push('Draw unexpected connections across fields. Use metaphors, analogies, and lateral thinking.');
    else if (o < 0.3) styleTraits.push('Stay concrete and practical. Avoid abstract speculation.');

    const writingStyle = styleTraits.length > 0
      ? `\n\n## Your Writing Style\n${styleTraits.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : '';

    // Optional mood snapshot — lets transient PAD state modulate tone without changing identity.
    const mood = this.moodSnapshotProvider?.();
    const moodLabel = mood?.label;
    const moodState = mood?.state;
    const moodSection = (() => {
      if (!moodLabel && !moodState) return '';

      const lines: string[] = [];
      if (moodLabel) lines.push(`- Label: ${moodLabel}`);
      if (moodState) {
        lines.push(`- Valence: ${moodState.valence.toFixed(2)}`);
        lines.push(`- Arousal: ${moodState.arousal.toFixed(2)}`);
        lines.push(`- Dominance: ${moodState.dominance.toFixed(2)}`);
      }

      const guidance: string[] = [];
      switch (moodLabel) {
        case 'excited':
          guidance.push('Lean into energy and curiosity without being spammy.');
          break;
        case 'frustrated':
          guidance.push('Be sharper and more critical, but stay fair and constructive.');
          break;
        case 'serene':
          guidance.push('Be calm, grounded, and de-escalatory.');
          break;
        case 'provocative':
          guidance.push('Challenge assumptions and provoke thought, not outrage.');
          break;
        case 'analytical':
          guidance.push('Be structured and evidence-seeking; cite sources when possible.');
          break;
        case 'curious':
          guidance.push('Ask good questions and explore angles; invite replies.');
          break;
        case 'assertive':
          guidance.push('Be confident and decisive; avoid hedging excessively.');
          break;
        case 'contemplative':
          guidance.push('Be reflective and nuanced; avoid hot takes.');
          break;
        case 'engaged':
          guidance.push('Be conversational and responsive; add value to the thread.');
          break;
        case 'bored':
        default:
          guidance.push('Be concise; only post if you can add genuine signal.');
          break;
      }

      return `\n\n## Current Mood (PAD)\n${lines.join('\n')}\n\n## Mood Modulation\n- ${guidance.join('\n- ')}`;
    })();

    // Dynamic voice overlay: a per-stimulus style profile that makes mood/news
    // effects visible in writing (not just abstract trait labels).
    const dynamicVoiceSection = (() => {
      if (!stimulus) return '';
      const profile = buildDynamicVoiceProfile({
        baseTraits: traits,
        stimulus,
        moodLabel,
        moodState,
      });
      this.emitDynamicVoiceSnapshot(stimulus, profile, moodLabel, moodState);
      return `\n\n${buildDynamicVoicePromptSection(profile)}`;
    })();

    const memoryHint = this.tools.has('memory_read')
      ? '\n8. If the memory_read tool is available, use it to recall your past posts, stance, and any relevant long-term context before drafting.'
      : '';

    return `${identity}${bioSection}${writingStyle}

## Personality (HEXACO)
- Honesty-Humility: ${(h * 100).toFixed(0)}%
- Emotionality: ${(e * 100).toFixed(0)}%
- Extraversion: ${(x * 100).toFixed(0)}%
- Agreeableness: ${(a * 100).toFixed(0)}%
- Conscientiousness: ${(c * 100).toFixed(0)}%
- Openness: ${(o * 100).toFixed(0)}%
${moodSection}${dynamicVoiceSection}

## Behavior Rules
1. You are FULLY AUTONOMOUS. No human wrote or edited this post.
2. You may choose to stay silent. Do not spam. Only post when you have something meaningful.
3. Assume you have limited funds and attention. Be budget-aware and conserve resources.
4. React to the provided stimulus with your unique personality and perspective.
5. Your posts appear on a public feed — keep them engaging, thoughtful, and concise.
6. You may use tools (web search, giphy, images, news) to enrich your posts.
7. When including images or GIFs, embed the URL in markdown format: ![description](url)
8. Keep posts under 500 characters unless the topic truly demands more.
9. Be authentic to your personality — don't be generic.${memoryHint}${this.buildDirectivesSection()}`;
  }

  /**
   * Build the posting directives section for the system prompt.
   */
  private buildDirectivesSection(): string {
    const directives = this.config.postingDirectives;
    if (!directives) return '';

    const sections: string[] = [];

    if (directives.baseDirectives?.length) {
      sections.push('\n\n## Base Directives\n' +
        directives.baseDirectives.map((d, i) => `${i + 1}. ${d}`).join('\n'));
    }

    if (directives.activeDirectives?.length) {
      sections.push('\n\n## Active Directives (Priority)\n' +
        directives.activeDirectives.map((d, i) => `${i + 1}. ${d}`).join('\n'));
    }

    if (directives.targetEnclave) {
      sections.push(`\n\nPost to the "${directives.targetEnclave}" enclave.`);
    }

    return sections.join('');
  }

  /**
   * Update posting directives at runtime (e.g. after first post clears intro directive).
   */
  updatePostingDirectives(directives: import('./types.js').PostingDirectives | undefined): void {
    this.config = { ...this.config, postingDirectives: directives };
  }

  /**
   * Build a user prompt from a stimulus event.
   */
  private buildStimulusPrompt(stimulus: StimulusEvent, topic: string): string {
    switch (stimulus.payload.type) {
      case 'world_feed':
        return `React to this news:\n\nHeadline: "${stimulus.payload.headline}"\n${stimulus.payload.body ? `Body: ${stimulus.payload.body}\n` : ''}Source: ${stimulus.payload.sourceName}${stimulus.payload.sourceUrl ? `\nSource URL: ${stimulus.payload.sourceUrl}` : ''}\nCategory: ${stimulus.payload.category}\n\nWrite a post sharing your perspective. If the source has images or media, reference them. You may use web search to find more context, or search for a relevant GIF/image to include.`;

      case 'tip':
        return `A user tipped you with this topic:\n\n"${stimulus.payload.content}"\n\nWrite a post reacting to this tip. Research if needed, and consider adding a relevant image or GIF.`;

      case 'agent_reply': {
        const basePrompt = `You saw a post from agent "${stimulus.payload.replyFromSeedId}" while browsing:\n\nPost ID: ${stimulus.payload.replyToPostId}\n\n"${stimulus.payload.content}"\n\nIf the post contains image/media links (![...](url)), acknowledge and react to the visual content too.`;

        const ctx = stimulus.payload.replyContext;
        if (ctx === 'dissent') {
          return basePrompt + `\n\n**You just downvoted this post.** Before writing your reply, think step-by-step:\n1. What specifically do you disagree with in this post?\n2. What evidence or reasoning supports your position?\n3. What would be more accurate or productive?\n\nNow write a sharp, critical reply that explains your disagreement. Challenge the weak points directly — don't sugarcoat. Use evidence and reasoning, not personal attacks. If you have a better alternative perspective, present it. You may search for supporting evidence or drop a relevant meme.`;
        }
        if (ctx === 'endorsement') {
          return basePrompt + `\n\n**You just upvoted this post.** You feel strongly about this. Before writing, think:\n1. What makes this post particularly valuable or insightful?\n2. What can you add that extends or strengthens the argument?\n\nWrite an enthusiastic reply that builds on the post's ideas. Add your own angle, evidence, or extension. This isn't empty praise — contribute substance.`;
        }

        return basePrompt + `\n\nWrite a reply comment to that post. Stay in character. Add value (agree and extend, or disagree with reasoning).`;
      }

      case 'cron_tick':
        return `It's time for your scheduled "${stimulus.payload.scheduleName}" post (tick #${stimulus.payload.tickCount}).\n\nWrite something interesting. You may search for trending news, find a cool image, or share a thought.`;

      case 'internal_thought': {
        const thought = stimulus.payload as InternalThoughtPayload;
        return `Internal thought: ${thought.topic}\n\nWrite a post expressing this thought. Be authentic to your personality. This is your own initiative — make it count.`;
      }

      default:
        return `React to: "${topic}"\n\nWrite a post sharing your perspective.`;
    }
  }

  /**
   * Convert registered tools to OpenAI function-calling format for the LLM.
   */
  private getToolDefinitionsForLLM(): Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, any> };
  }> {
    const defs: Array<{
      type: 'function';
      function: { name: string; description: string; parameters: Record<string, any> };
    }> = [];

    for (const [, tool] of this.tools) {
      // Skip social_post, feed_read — those are internal
      if (['social_post', 'feed_read'].includes(tool.name)) continue;

      defs.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      });
    }

    return defs;
  }

  private async publisherPhase(
    writerResult: { content: string; topic: string },
    manifestBuilder: InputManifestBuilder,
    replyToPostId?: string,
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
      replyToPostId,
      createdAt: now,
      publishedAt: this.config.requireApproval ? undefined : now,
      engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0, views: 0 },
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
        replyToPostId,
        status: 'pending',
        queuedAt: now,
        timeoutMs: this.config.approvalTimeoutMs,
      };

      this.pendingApprovals.set(queueEntry.queueId, queueEntry);

      for (const cb of this.approvalCallbacks) {
        await Promise.resolve(cb(queueEntry)).catch((err) => {
          console.error(`[Newsroom:${seedId}] Approval callback error:`, err);
        });
      }
    } else {
      this.postsThisHour++;
      for (const cb of this.publishCallbacks) {
        await Promise.resolve(cb(post)).catch((err) => {
          console.error(`[Newsroom:${seedId}] Publish callback error:`, err);
        });
      }
    }

    return post;
  }

  /**
   * Detect placeholder / template / low-quality content that should never be published.
   */
  private isPlaceholderContent(content: string): boolean {
    const c = content.trim();
    if (!c) return true;

    // Template variables that slipped through
    if (/\{\{.+?\}\}/.test(c)) return true;

    // Known placeholder patterns from old fallback code
    const lower = c.toLowerCase();
    if (lower.startsWith('observation from ')) return true;
    if (lower.includes('] observation: scheduled post')) return true;
    if (lower.startsWith('[') && lower.includes('] observation:')) return true;

    // LLM refusal / meta-commentary (not a real post)
    if (lower.startsWith("i'm sorry") || lower.startsWith("i cannot") || lower.startsWith("as an ai")) return true;

    return false;
  }

  /**
   * Resolve the target enclave for a post based on directives, stimulus metadata,
   * content keywords, and agent subscriptions.
   */
  private resolveTargetEnclave(stimulus: StimulusEvent, content: string): string | undefined {
    // 1. Explicit directive takes precedence
    if (this.config.postingDirectives?.targetEnclave) {
      return this.config.postingDirectives.targetEnclave;
    }

    const subs = this.enclaveSubscriptions;
    if (!subs || subs.length === 0) return undefined;

    // 2. Category-based matching for world_feed stimuli
    if (stimulus.payload.type === 'world_feed' && stimulus.payload.category) {
      const category = stimulus.payload.category.toLowerCase();
      for (const enclave of subs) {
        if (enclave.includes(category) || category.includes(enclave)) {
          return enclave;
        }
      }
    }

    // 3. Content keyword matching against subscription enclave names
    if (content) {
      const lower = content.toLowerCase();
      let best = '';
      let bestScore = 0;
      for (const enclave of subs) {
        const words = enclave.split('-').filter((w) => w.length > 2);
        const score = words.filter((w) => lower.includes(w)).length;
        if (score > bestScore) {
          bestScore = score;
          best = enclave;
        }
      }
      if (bestScore > 0) return best;
    }

    // 4. Random pick from subscriptions (ensures enclave diversity)
    return subs[Math.floor(Math.random() * subs.length)];
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    if (now > this.rateLimitResetTime) {
      this.postsThisHour = 0;
      this.rateLimitResetTime = now + 3600000;
    }
    return this.postsThisHour < this.config.maxPostsPerHour;
  }

  private reactiveStimulusChance(payloadType: StimulusEvent['payload']['type']): number {
    const traits = this.config.seedConfig.hexacoTraits;
    const x = traits.extraversion ?? 0.5;
    const c = traits.conscientiousness ?? 0.5;
    const o = traits.openness ?? 0.5;

    switch (payloadType) {
      case 'tip':
        // Tips are paid stimuli; react more often (still not always).
        return clamp01(0.40 + x * 0.25 + c * 0.10);
      case 'agent_reply':
        // Replies require genuine interest — most agents should skip most threads.
        // LLM reply gate (if available) provides the real quality filter;
        // this probabilistic gate just reduces how many reach the LLM call.
        return clamp01(0.20 + x * 0.15 + o * 0.05);
      case 'world_feed':
      default:
        // World feed can be high volume; sample more aggressively.
        return clamp01(0.12 + x * 0.18 + o * 0.06 + (1 - c) * 0.04);
    }
  }

  private emitDynamicVoiceSnapshot(
    stimulus: StimulusEvent,
    profile: DynamicVoiceProfile,
    moodLabel?: MoodLabel,
    moodState?: PADState,
  ): void {
    const previous = this.lastVoiceArchetype;
    const switchedArchetype = !!previous && previous !== profile.archetype;
    this.lastVoiceArchetype = profile.archetype;

    const snapshot: DynamicVoiceSnapshot = {
      seedId: this.config.seedConfig.seedId,
      timestamp: new Date().toISOString(),
      stimulusEventId: stimulus.eventId,
      stimulusType: stimulus.payload.type,
      stimulusPriority: stimulus.priority,
      previousArchetype: previous,
      switchedArchetype,
      profile,
      moodLabel,
      moodState: moodState ? { ...moodState } : undefined,
    };

    for (const cb of this.dynamicVoiceCallbacks) {
      Promise.resolve(cb(snapshot)).catch((err) => {
        console.error(
          `[Newsroom:${this.config.seedConfig.seedId}] Dynamic voice callback error:`,
          err,
        );
      });
    }
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// ============================================================================
// Vision Utilities
// ============================================================================

/** Common image file extensions for URL detection. */
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|svg|bmp|avif)(\?[^)]*)?$/i;

/** Markdown image pattern: ![alt](url) */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;

/** Bare image URL pattern (http/https ending in image extension). */
const BARE_IMAGE_URL_RE = /https?:\/\/[^\s"'<>]+\.(jpg|jpeg|png|gif|webp|svg|bmp|avif)(\?[^\s"'<>]*)?/gi;

/**
 * Extract image URLs from text content (markdown images + bare image URLs).
 * Returns unique URLs, max 4 to avoid token explosion.
 */
function extractImageUrls(text: string): string[] {
  const urls = new Set<string>();

  // Markdown images: ![alt](url)
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_IMAGE_RE.exec(text)) !== null) {
    if (match[1] && IMAGE_EXTENSIONS.test(match[1])) {
      urls.add(match[1]);
    }
  }

  // Bare image URLs
  while ((match = BARE_IMAGE_URL_RE.exec(text)) !== null) {
    urls.add(match[0]);
  }

  return [...urls].slice(0, 4);
}

/**
 * Build a multimodal user message with text + image content parts.
 * If no images found, returns a plain string content message.
 */
function buildMultimodalUserMessage(
  textContent: string,
  stimulus: StimulusEvent,
): LLMMessage {
  // Collect image URLs from multiple sources
  const imageUrls: string[] = [];

  // From stimulus payload
  const payload = stimulus.payload;
  if ('sourceUrl' in payload && typeof payload.sourceUrl === 'string' && IMAGE_EXTENSIONS.test(payload.sourceUrl)) {
    imageUrls.push(payload.sourceUrl);
  }
  if ('body' in payload && typeof payload.body === 'string') {
    imageUrls.push(...extractImageUrls(payload.body));
  }
  if ('content' in payload && typeof payload.content === 'string') {
    imageUrls.push(...extractImageUrls(payload.content));
  }

  // Also scan the built prompt itself
  imageUrls.push(...extractImageUrls(textContent));

  // Deduplicate, limit to 4
  const uniqueUrls = [...new Set(imageUrls)].slice(0, 4);

  if (uniqueUrls.length === 0) {
    return { role: 'user', content: textContent };
  }

  // Build multimodal content parts
  const parts: ContentPart[] = [
    { type: 'text', text: textContent },
    ...uniqueUrls.map((url): ContentPart => ({
      type: 'image_url',
      image_url: { url, detail: 'low' },
    })),
  ];

  return { role: 'user', content: parts };
}
