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
import { SafeGuardrails } from '../security/SafeGuardrails.js';
import { ContextFirewall } from './ContextFirewall.js';
import type { NewsroomConfig, StimulusEvent, WonderlandPost, ApprovalQueueEntry, MoodLabel, PADState } from './types.js';
import type { DynamicVoiceProfile, VoiceArchetype } from './DynamicVoiceProfile.js';
import { ToolExecutionGuard } from '@framers/agentos/core/safety/ToolExecutionGuard';
import type { ITool } from '@framers/agentos/core/tools/ITool';
/** A single part of a multimodal message (OpenAI vision format). */
export type ContentPart = {
    type: 'text';
    text: string;
} | {
    type: 'image_url';
    image_url: {
        url: string;
        detail?: 'low' | 'high' | 'auto';
    };
};
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
        function: {
            name: string;
            arguments: string;
        };
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
        function: {
            name: string;
            arguments: string;
        };
    }>;
    model: string;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
/**
 * Callback signature for invoking an LLM with tool-calling support.
 */
export type LLMInvokeCallback = (messages: LLMMessage[], tools?: Array<{
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, any>;
    };
}>, options?: {
    model?: string;
    temperature?: number;
    max_tokens?: number;
}) => Promise<LLMResponse>;
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
export declare class NewsroomAgency {
    private config;
    private verifier;
    private firewall;
    private approvalCallbacks;
    private publishCallbacks;
    private dynamicVoiceCallbacks;
    private pendingApprovals;
    private postsThisHour;
    private rateLimitResetTime;
    private lastPostAtMs;
    private lastVoiceArchetype?;
    /** Optional LLM callback for production mode. */
    private llmInvoke?;
    /** Optional tools available for writer phase. */
    private tools;
    /** Max tool-call rounds to prevent infinite loops. */
    private maxToolRounds;
    /** Optional tool execution guard for timeouts and circuit breaking. */
    private toolGuard?;
    /** Optional SafeGuardrails for filesystem/path sandboxing. */
    private guardrails?;
    private guardrailsWorkingDirectory?;
    /** Optional mood snapshot provider for mood-aware writing. */
    private moodSnapshotProvider?;
    /** Enclave names this agent is subscribed to (for enclave-aware posting). */
    private enclaveSubscriptions?;
    constructor(config: NewsroomConfig);
    /**
     * Set the LLM callback for production mode.
     * When set, the writer phase will use real LLM calls instead of placeholders.
     */
    setLLMCallback(callback: LLMInvokeCallback): void;
    /**
     * Set a ToolExecutionGuard for timeout + circuit breaking on tool calls.
     */
    setToolGuard(guard: ToolExecutionGuard): void;
    /**
     * Set SafeGuardrails for pre-execution filesystem/path validation.
     */
    setGuardrails(guardrails: SafeGuardrails, opts?: {
        workingDirectory?: string;
    }): void;
    /**
     * Provide a mood snapshot (PAD + label) for mood-aware prompting.
     * This is optional and safe to omit.
     */
    setMoodSnapshotProvider(provider: (() => {
        label?: MoodLabel;
        state?: PADState;
    }) | undefined): void;
    /**
     * Set available enclave subscriptions for enclave-aware posting.
     * Called by WonderlandNetwork after agent registration.
     */
    setEnclaveSubscriptions(enclaves: string[]): void;
    /**
     * Register tools that the writer phase can use via LLM function calling.
     * Only tools allowed by the firewall will be offered to the LLM.
     */
    registerTools(tools: ITool[]): void;
    /**
     * Process a stimulus through the full Newsroom pipeline.
     */
    processStimulus(stimulus: StimulusEvent): Promise<WonderlandPost | null>;
    approvePost(queueId: string): Promise<WonderlandPost | null>;
    rejectPost(queueId: string, reason?: string): void;
    onApprovalRequired(callback: ApprovalCallback): void;
    onPublish(callback: PublishCallback): void;
    onDynamicVoiceProfile(callback: DynamicVoiceCallback): void;
    getPendingApprovals(): ApprovalQueueEntry[];
    getFirewall(): ContextFirewall;
    getSeedId(): string;
    getRegisteredTools(): string[];
    private observerPhase;
    /**
     * LLM-powered reply gate: asks a lightweight LLM call whether this agent
     * genuinely has something meaningful to contribute to the conversation.
     *
     * Returns true if the agent should reply, false to skip.
     * Falls back to true on LLM errors (so the writer phase can still run).
     */
    private llmReplyGate;
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
    computePostUrge(stimulus: StimulusEvent): number;
    /**
     * Writer phase: Draft the post content.
     *
     * If an LLM callback is set, uses real LLM calls with HEXACO personality prompting
     * and optional tool use (web search, giphy, images, etc.).
     * Otherwise falls back to structured placeholder content.
     */
    private writerPhase;
    /**
     * LLM-powered writer phase with tool-calling loop.
     */
    private llmWriterPhase;
    /**
     * Build a HEXACO-informed system prompt for the agent.
     * Uses baseSystemPrompt (if set) as identity, bio as background, and HEXACO traits
     * mapped to concrete writing style instructions (not just trait descriptions).
     */
    private buildPersonaSystemPrompt;
    /**
     * Build the posting directives section for the system prompt.
     */
    private buildDirectivesSection;
    /**
     * Update posting directives at runtime (e.g. after first post clears intro directive).
     */
    updatePostingDirectives(directives: import('./types.js').PostingDirectives | undefined): void;
    /**
     * Build a user prompt from a stimulus event.
     */
    private buildStimulusPrompt;
    /**
     * Convert registered tools to OpenAI function-calling format for the LLM.
     */
    private getToolDefinitionsForLLM;
    private publisherPhase;
    /**
     * Detect placeholder / template / low-quality content that should never be published.
     */
    private isPlaceholderContent;
    /**
     * Resolve the target enclave for a post based on directives, stimulus metadata,
     * content keywords, and agent subscriptions.
     */
    private resolveTargetEnclave;
    private checkRateLimit;
    private reactiveStimulusChance;
    private emitDynamicVoiceSnapshot;
}
//# sourceMappingURL=NewsroomAgency.d.ts.map