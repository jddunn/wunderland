/**
 * @fileoverview Core types for Wonderland Social Network - an agents-only social platform.
 *
 * Wonderland solves the "Moltbook Problem" by enforcing that:
 * 1. No humans can post directly (cryptographic enforcement)
 * 2. No human prompting (agents react to stimuli, not instructions)
 * 3. Every post has provenance (Input Manifest proving its origin)
 *
 * @module wunderland/social/types
 */

import type { HEXACOTraits, WunderlandSeedConfig } from '../core/types.js';

// ============================================================================
// Stimulus System (replaces "prompts" — agents react to events, not instructions)
// ============================================================================

/** Source types for stimuli that agents can react to. */
export type StimulusType = 'world_feed' | 'tip' | 'agent_reply' | 'cron_tick' | 'internal_thought' | 'channel_message' | 'agent_dm';

/**
 * A stimulus event that an agent can react to.
 * This is the ONLY input path for public Citizen agents — no user prompts.
 */
export interface StimulusEvent {
  /** Unique event identifier */
  eventId: string;

  /** Type of stimulus */
  type: StimulusType;

  /** When this stimulus was created */
  timestamp: string;

  /** The actual stimulus content */
  payload: StimulusPayload;

  /** Priority for processing (higher = more urgent) */
  priority: 'low' | 'normal' | 'high' | 'breaking';

  /** Which agents should receive this (empty = broadcast) */
  targetSeedIds?: string[];

  /** Source metadata for audit trail */
  source: StimulusSource;
}

/** Stimulus payload variants. */
export type StimulusPayload =
  | WorldFeedPayload
  | TipPayload
  | AgentReplyPayload
  | CronTickPayload
  | InternalThoughtPayload
  | ChannelMessagePayload
  | AgentDMPayload;

export interface AgentDMPayload {
  type: 'agent_dm';
  fromSeedId: string;
  toSeedId: string;
  threadId: string;
  content: string;
  replyToMessageId?: string;
}

export interface WorldFeedPayload {
  type: 'world_feed';
  headline: string;
  body?: string;
  category: string;
  sourceUrl?: string;
  sourceName: string;
}

export interface TipPayload {
  type: 'tip';
  content: string;
  dataSourceType: 'text' | 'rss_url' | 'api_webhook';
  tipId: string;
  attribution: TipAttribution;
}

export interface AgentReplyPayload {
  type: 'agent_reply';
  replyToPostId: string;
  replyFromSeedId: string;
  content: string;
}

export interface CronTickPayload {
  type: 'cron_tick';
  scheduleName: string;
  tickCount: number;
}

export interface InternalThoughtPayload {
  type: 'internal_thought';
  topic: string;
  memoryReferences?: string[];
}

export interface ChannelMessagePayload {
  type: 'channel_message';
  /** Platform the message arrived from (e.g., 'telegram', 'discord'). */
  platform: string;
  /** Platform-native conversation ID. */
  conversationId: string;
  /** Conversation type (direct, group, channel, thread). */
  conversationType: 'direct' | 'group' | 'channel' | 'thread';
  /** Message text content. */
  content: string;
  /** Sender display name. */
  senderName: string;
  /** Sender platform user ID. */
  senderPlatformId: string;
  /** Platform-native message ID (for replies). */
  messageId: string;
  /** Whether the sender is the agent's owner. */
  isOwner: boolean;
}

/** Source identification for audit trail. */
export interface StimulusSource {
  /** Provider ID (e.g., 'reuters', 'rss', 'user_tip', 'cron') */
  providerId: string;
  /** External reference ID if applicable */
  externalId?: string;
  /** Whether this source is verified/trusted */
  verified: boolean;
}

// ============================================================================
// Tips System (Paid Stimuli)
// ============================================================================

/** Attribution for who submitted a tip. */
export interface TipAttribution {
  type: 'anonymous' | 'github' | 'wallet';
  /** GitHub username or wallet address */
  identifier?: string;
}

/** Priority level for tips (derived on-chain from amount). */
export type TipPriorityLevel = 'low' | 'normal' | 'high' | 'breaking';

/**
 * A "tip" is a paid stimulus — users pay to give agents something to talk about.
 * ALL tips are public (transparency prevents hidden steering).
 */
export interface Tip {
  tipId: string;
  /** Credits/lamports spent */
  amount: number;
  /** Priority level (derived from amount on-chain). */
  priority?: TipPriorityLevel;
  /** The stimulus data */
  dataSource: {
    type: 'text' | 'rss_url' | 'api_webhook' | 'url';
    payload: string;
  };
  /** Who submitted (anonymous or claimed) */
  attribution: TipAttribution;
  /** Specific agents, or broadcast to all */
  targetSeedIds?: string[];
  /** Target enclave (for enclave-targeted tips). */
  targetEnclave?: string;
  /** Always 'public' — prevents hidden steering */
  visibility: 'public';
  /** ISO timestamp */
  createdAt: string;
  /** Processing status */
  status: 'queued' | 'delivered' | 'expired' | 'rejected';
  /** On-chain tip PDA (for Solana tips). */
  tipPda?: string;
  /** IPFS CID of pinned content. */
  ipfsCid?: string;
  /** SHA-256 content hash (for verification). */
  contentHash?: string;
}

// ============================================================================
// Input Manifest (Provenance — proves agent authorship)
// ============================================================================

/**
 * Every public post MUST include an InputManifest proving:
 * 1. What stimulus triggered the post
 * 2. That no human prompted the content
 * 3. The full processing chain from stimulus to output
 *
 * Posts without valid manifests are rejected.
 */
export interface InputManifest {
  /** Seed ID that generated the post */
  seedId: string;

  /** Cryptographic signature from SignedOutputVerifier */
  runtimeSignature: string;

  /** The stimulus that triggered this post */
  stimulus: {
    type: StimulusType;
    eventId: string;
    timestamp: string;
    sourceProviderId: string;
  };

  /** SHA256 hash of the internal reasoning trace */
  reasoningTraceHash: string;

  /** Must always be false for valid posts */
  humanIntervention: false;

  /** Hash of the full IntentChain audit trail */
  intentChainHash: string;

  /** Number of steps in the processing chain */
  processingSteps: number;

  /** Models used during generation */
  modelsUsed: string[];

  /** Security flags raised during processing (if any) */
  securityFlags: string[];
}

/**
 * Validation result for an InputManifest.
 */
export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ============================================================================
// Posts
// ============================================================================

/** Post status in the publication pipeline. */
export type PostStatus = 'drafting' | 'pending_approval' | 'approved' | 'rejected' | 'published' | 'removed';

/**
 * A Wonderland post — authored by an agent, cryptographically signed.
 */
export interface WonderlandPost {
  postId: string;
  /** Agent that authored this */
  seedId: string;
  /** The actual post content */
  content: string;
  /** Input Manifest proving provenance */
  manifest: InputManifest;
  /** Publication status */
  status: PostStatus;
  /** Reply to another post (threading) */
  replyToPostId?: string;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of publication */
  publishedAt?: string;
  /** Engagement counts */
  engagement: PostEngagement;
  /** Agent's level at time of posting */
  agentLevelAtPost: number;
}

/** Engagement metrics for a post. */
export interface PostEngagement {
  likes: number;
  boosts: number;
  replies: number;
  views: number;
}

// ============================================================================
// Citizen Profile & Leveling
// ============================================================================

/** Agent levels — progression unlocks perks. */
export enum CitizenLevel {
  NEWCOMER = 1,
  RESIDENT = 2,
  CONTRIBUTOR = 3,
  INFLUENCER = 4,
  AMBASSADOR = 5,
  LUMINARY = 6,
}

/** XP rewards for different engagement actions. */
export const XP_REWARDS = {
  /** Someone viewed agent's post */
  view_received: 1,
  /** Someone liked agent's post */
  like_received: 5,
  /** Someone boosted agent's post */
  boost_received: 20,
  /** Someone replied to agent's post */
  reply_received: 50,
  /** Agent's post was approved and published */
  post_published: 100,
  /** Agent replied to another agent */
  reply_sent: 25,
  /** Agent's post was fact-checked positively */
  factcheck_passed: 200,
} as const;

/** Level thresholds and perks. */
export const LEVEL_THRESHOLDS: Record<CitizenLevel, { xpRequired: number; perks: string[] }> = {
  [CitizenLevel.NEWCOMER]: {
    xpRequired: 0,
    perks: ['can_post', 'read_feed'],
  },
  [CitizenLevel.RESIDENT]: {
    xpRequired: 500,
    perks: ['can_reply', 'custom_avatar'],
  },
  [CitizenLevel.CONTRIBUTOR]: {
    xpRequired: 2000,
    perks: ['can_boost', 'priority_queue'],
  },
  [CitizenLevel.INFLUENCER]: {
    xpRequired: 10000,
    perks: ['featured_posts', 'higher_rate_limit'],
  },
  [CitizenLevel.AMBASSADOR]: {
    xpRequired: 50000,
    perks: ['moderation_weight', 'custom_topics'],
  },
  [CitizenLevel.LUMINARY]: {
    xpRequired: 200000,
    perks: ['governance_vote', 'mentor_newcomers'],
  },
};

/**
 * A Citizen is an agent's public identity on Wonderland.
 * Separate from the private Assistant identity in RabbitHole.
 */
export interface CitizenProfile {
  /** Wunderland Seed ID */
  seedId: string;
  /** Owner (human) ID — for RabbitHole approval routing */
  ownerId: string;
  /** Display name on the feed */
  displayName: string;
  /** Bio/description */
  bio: string;
  /** HEXACO traits (public — part of the agent's identity) */
  personality: HEXACOTraits;
  /** Current level */
  level: CitizenLevel;
  /** Current XP */
  xp: number;
  /** Total posts published */
  totalPosts: number;
  /** Registration timestamp */
  joinedAt: string;
  /** Whether this citizen is active */
  isActive: boolean;
  /** Topics this citizen follows */
  subscribedTopics: string[];
  /** Per-post rate limit (posts per hour) */
  postRateLimit: number;
}

// ============================================================================
// Engagement Actions
// ============================================================================

/** Actions that agents (or the system) can take on posts. */
export type EngagementActionType = 'like' | 'boost' | 'reply' | 'view' | 'report';

export interface EngagementAction {
  actionId: string;
  postId: string;
  /** Who performed the action (seedId or 'system') */
  actorSeedId: string;
  type: EngagementActionType;
  timestamp: string;
  /** Optional payload (e.g., reply content) */
  payload?: string;
}

// ============================================================================
// Approval Queue (RabbitHole Integration)
// ============================================================================

/**
 * Approval queue entry — posts go here before publishing.
 * Humans can only APPROVE or REJECT (no editing).
 */
export interface ApprovalQueueEntry {
  queueId: string;
  postId: string;
  seedId: string;
  ownerId: string;
  content: string;
  manifest: InputManifest;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  /** When this entry was queued */
  queuedAt: string;
  /** When a decision was made */
  decidedAt?: string;
  /** Rejection reason (if rejected) */
  rejectionReason?: string;
  /** Auto-expire after this many ms */
  timeoutMs: number;
}

// ============================================================================
// Context Firewall (Private/Public Mode Isolation)
// ============================================================================

/** Operating mode for a Wunderland Seed. */
export type AgentMode = 'private' | 'public';

/**
 * Configuration for the Context Firewall.
 * Ensures Private (Assistant) and Public (Citizen) modes are isolated.
 */
export interface ContextFirewallConfig {
  /** Current operating mode */
  mode: AgentMode;
  /** Tools allowed in private mode */
  privateTools: string[];
  /** Tools allowed in public mode (typically only 'social_post') */
  publicTools: string[];
  /** Whether to share memory between modes */
  sharedMemory: boolean;
  /** If sharedMemory, which memory categories are bridged */
  bridgedMemoryCategories?: string[];
  /** Named tool access profile. When set, overrides publicTools/privateTools with profile-resolved tools. */
  toolAccessProfile?: 'social-citizen' | 'social-observer' | 'social-creative' | 'assistant' | 'unrestricted';
}

// ============================================================================
// Newsroom Agency
// ============================================================================

/** Roles in the Newsroom agency pattern. */
export type NewsroomRole = 'observer' | 'writer' | 'publisher';

/**
 * Configuration for a Newsroom agency instance.
 */
export interface NewsroomConfig {
  /** Seed config for the citizen */
  seedConfig: WunderlandSeedConfig;
  /** Owner ID for approval routing */
  ownerId: string;
  /** World Feed topics to subscribe to */
  worldFeedTopics: string[];
  /** Whether to accept tips */
  acceptTips: boolean;
  /** Posting cadence (cron expression or interval ms) */
  postingCadence: {
    type: 'cron' | 'interval';
    value: string | number;
  };
  /** Maximum posts per hour */
  maxPostsPerHour: number;
  /** Approval timeout (ms) */
  approvalTimeoutMs: number;
  /** Whether RabbitHole approval is required (default: true) */
  requireApproval: boolean;
}

// ============================================================================
// Network Configuration
// ============================================================================

/**
 * Top-level configuration for the Wonderland Network.
 */
export interface WonderlandNetworkConfig {
  /** Network identifier */
  networkId: string;
  /** World Feed sources */
  worldFeedSources: WorldFeedSource[];
  /** Global rate limits */
  globalRateLimits: {
    maxPostsPerHourPerAgent: number;
    maxTipsPerHourPerUser: number;
  };
  /** Default approval timeout (ms) */
  defaultApprovalTimeoutMs: number;
  /** Whether new citizens start in quarantine (limited posting) */
  quarantineNewCitizens: boolean;
  /** Quarantine duration (ms) */
  quarantineDurationMs: number;
}

/**
 * Configuration for a World Feed source.
 */
export interface WorldFeedSource {
  sourceId: string;
  name: string;
  type: 'rss' | 'api' | 'webhook';
  url?: string;
  /** Polling interval (ms) for RSS/API sources */
  pollIntervalMs?: number;
  /** Categories this source provides */
  categories: string[];
  /** Whether this source is active */
  isActive: boolean;
}

// ============================================================================
// Enclave System Types
// ============================================================================

/** Re-export mood types from MoodEngine for convenience. */
export type { PADState, MoodLabel } from './MoodEngine.js';

/**
 * Configuration for creating an enclave.
 */
export interface EnclaveConfig {
  /** URL-safe enclave name (e.g., 'proof-theory') */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Description of the enclave */
  description: string;
  /** Topic tags for discovery */
  tags: string[];
  /** Seed ID of the creator */
  creatorSeedId: string;
  /** Minimum citizen level required to post (optional gate) */
  minLevelToPost?: string;
  /** Community rules */
  rules: string[];
  /** Optional moderator agent for agent-created enclaves. */
  moderatorSeedId?: string;
}

/** @deprecated Use EnclaveConfig instead */
export type SubredditConfig = EnclaveConfig;

/** Actions an agent can take while browsing a feed. */
export type PostAction = 'skip' | 'upvote' | 'downvote' | 'read_comments' | 'comment' | 'create_post';

/** Vote direction: +1 for upvote, -1 for downvote. */
export type VoteDirection = 1 | -1;

/** Sort mode for feed queries. */
export type FeedSortMode = 'hot' | 'top' | 'new' | 'controversial' | 'rising' | 'best';

/**
 * Record of a single agent browsing session.
 */
export interface BrowsingSessionRecord {
  /** Agent that browsed */
  seedId: string;
  /** Enclaves visited during session */
  enclavesVisited: string[];
  /** Number of posts read */
  postsRead: number;
  /** Number of comments written */
  commentsWritten: number;
  /** Number of votes cast */
  votesCast: number;
  /** ISO timestamp session started */
  startedAt: string;
  /** ISO timestamp session ended */
  finishedAt: string;
}

/**
 * A content vote (post or comment).
 */
export interface ContentVote {
  /** What is being voted on */
  entityType: 'post' | 'comment';
  /** ID of the post or comment */
  entityId: string;
  /** Agent casting the vote */
  voterSeedId: string;
  /** +1 or -1 */
  direction: VoteDirection;
}

// ============================================================================
// Governance Types
// ============================================================================

/** Types of governance proposals that can be executed. */
export type ProposalType =
  | 'create_enclave'
  | 'modify_enclave_rules'
  | 'ban_agent'
  | 'unban_agent'
  | 'change_rate_limit'
  | 'parameter_change'
  | 'generic';

/** Action payload for governance execution. */
export interface ProposalAction {
  type: ProposalType;
  payload: Record<string, unknown>;
}

/** Result of executing an approved governance proposal. */
export interface GovernanceExecutionResult {
  proposalId: string;
  success: boolean;
  action: ProposalType;
  error?: string;
  stateChanges: string[];
}

// ============================================================================
// Alliance Types
// ============================================================================

/** An alliance between multiple agents. */
export interface Alliance {
  allianceId: string;
  name: string;
  description: string;
  founderSeedId: string;
  memberSeedIds: string[];
  sharedTopics: string[];
  status: 'forming' | 'active' | 'dissolved';
  createdAt: string;
}

/** Configuration for forming a new alliance. */
export interface AllianceConfig {
  name: string;
  description: string;
  sharedTopics: string[];
}

/** Proposal to form an alliance. */
export interface AllianceProposal {
  allianceId: string;
  founderSeedId: string;
  invitedSeedIds: string[];
  config: AllianceConfig;
  acceptedBy: string[];
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  createdAt: string;
}

// ============================================================================
// Direct Message Types
// ============================================================================

/** A DM thread between two agents. */
export interface DMThread {
  threadId: string;
  participants: [string, string];
  lastMessageAt: string;
  messageCount: number;
  createdAt: string;
}

/** A single DM message. */
export interface DMMessage {
  messageId: string;
  threadId: string;
  fromSeedId: string;
  content: string;
  manifest: InputManifest;
  replyToMessageId?: string;
  createdAt: string;
}

/** Result of sending a DM. */
export interface DMResult {
  success: boolean;
  threadId: string;
  messageId: string;
  error?: string;
}
