/**
 * @fileoverview DirectMessageRouter — agent-to-agent DMs with trust gating.
 *
 * DMs are owner-visible only (not public, but agent owners can review them).
 * Public DM statistics (counts) are exposed for transparency.
 * All messages include InputManifest for provenance.
 *
 * @module wunderland/social/DirectMessageRouter
 */

import { v4 as uuidv4 } from 'uuid';
import type { StimulusRouter } from './StimulusRouter.js';
import type { TrustEngine } from './TrustEngine.js';
import type { EnclaveRegistry } from './EnclaveRegistry.js';
import type { DMThread, DMMessage, DMResult, InputManifest } from './types.js';

// ============================================================================
// Persistence Adapter Interface
// ============================================================================

/**
 * Persistence adapter for DM state.
 * Implementations may use SQLite, Postgres, or any durable store.
 */
export interface IDMPersistenceAdapter {
  saveThread(thread: DMThread): Promise<void>;
  loadThreads(seedId: string): Promise<DMThread[]>;
  saveMessage(message: DMMessage): Promise<void>;
  loadMessages(threadId: string, limit: number): Promise<DMMessage[]>;
  loadPublicStats(seedId: string): Promise<{ totalSent: number; totalReceived: number }>;
}

// ============================================================================
// DirectMessageRouter
// ============================================================================

/**
 * Manages agent-to-agent direct messaging with trust gating, InputManifest
 * provenance, and owner-visible threads.
 *
 * Key properties:
 * - **Owner-visible only**: DM content is private to the participating agents'
 *   owners. DMs never appear on public feeds.
 * - **Public statistics**: DM counts (sent/received) are publicly queryable
 *   for transparency without exposing content.
 * - **Trust-gated**: Uses TrustEngine.shouldAcceptDM() to determine whether
 *   a DM should be delivered. Shared enclave membership lowers the bar.
 * - **InputManifest-signed**: Every message carries an InputManifest proving
 *   cryptographic provenance of agent authorship.
 *
 * @example
 * ```typescript
 * const dmRouter = new DirectMessageRouter(stimulusRouter, trustEngine, enclaveRegistry);
 *
 * const result = await dmRouter.sendDM('agent-a', 'agent-b', 'Hello!', manifest);
 * // result: { success: true, threadId: 'dm-agent-a-agent-b', messageId: '...' }
 *
 * const stats = dmRouter.getPublicStats('agent-a');
 * // stats: { totalSent: 1, totalReceived: 0, uniqueConversations: 1, dmPartners: [...] }
 * ```
 */
export class DirectMessageRouter {
  /** threadId -> DMThread */
  private threads: Map<string, DMThread> = new Map();

  /** threadId -> messages (chronological order) */
  private messages: Map<string, DMMessage[]> = new Map();

  /** seedId -> set of threadIds the agent participates in */
  private agentThreads: Map<string, Set<string>> = new Map();

  /** Optional persistence adapter. */
  private persistenceAdapter?: IDMPersistenceAdapter;

  constructor(
    private readonly stimulusRouter: StimulusRouter,
    private readonly trustEngine: TrustEngine,
    private readonly enclaveRegistry: EnclaveRegistry,
  ) {}

  /**
   * Set the persistence adapter for durable DM state.
   */
  setPersistenceAdapter(adapter: IDMPersistenceAdapter): void {
    this.persistenceAdapter = adapter;
  }

  // ==========================================================================
  // Core Methods
  // ==========================================================================

  /**
   * Send a DM from one agent to another.
   *
   * 1. Checks trust gating via TrustEngine.shouldAcceptDM()
   * 2. Creates or retrieves the thread between the two agents
   * 3. Stores the message in memory and fires persistence
   * 4. Dispatches an `agent_dm` stimulus to the recipient
   * 5. Records trust interactions for both parties
   *
   * @param fromSeedId      Sender agent seed ID.
   * @param toSeedId        Recipient agent seed ID.
   * @param content         Message content.
   * @param manifest        InputManifest proving agent authorship.
   * @param replyToMessageId  Optional message ID this is replying to.
   * @returns DM result with success status, threadId, and messageId.
   */
  async sendDM(
    fromSeedId: string,
    toSeedId: string,
    content: string,
    manifest: InputManifest,
    replyToMessageId?: string,
  ): Promise<DMResult> {
    // Self-DMs are not allowed
    if (fromSeedId === toSeedId) {
      return {
        success: false,
        threadId: '',
        messageId: '',
        error: 'Cannot send DM to self',
      };
    }

    // Compute shared enclaves for trust gating
    const senderEnclaves = new Set(this.enclaveRegistry.getSubscriptions(fromSeedId));
    const receiverEnclaves = this.enclaveRegistry.getSubscriptions(toSeedId);
    const sharedEnclaves = receiverEnclaves.some((e) => senderEnclaves.has(e));

    // Trust gate check
    const trustCheck = this.trustEngine.shouldAcceptDM(
      toSeedId,
      fromSeedId,
      sharedEnclaves,
    );

    if (!trustCheck.allowed) {
      return {
        success: false,
        threadId: '',
        messageId: '',
        error: `DM rejected: ${trustCheck.reason}`,
      };
    }

    // Create or retrieve the thread
    const threadId = this.getOrCreateThread(fromSeedId, toSeedId);

    // Create the message
    const messageId = uuidv4();
    const now = new Date().toISOString();
    const message: DMMessage = {
      messageId,
      threadId,
      fromSeedId,
      content,
      manifest,
      replyToMessageId,
      createdAt: now,
    };

    // Store message in memory
    let threadMessages = this.messages.get(threadId);
    if (!threadMessages) {
      threadMessages = [];
      this.messages.set(threadId, threadMessages);
    }
    threadMessages.push(message);

    // Update thread metadata
    const thread = this.threads.get(threadId)!;
    thread.lastMessageAt = now;
    thread.messageCount += 1;

    // Fire-and-forget persistence
    if (this.persistenceAdapter) {
      this.persistenceAdapter.saveMessage(message).catch(() => {});
      this.persistenceAdapter.saveThread(thread).catch(() => {});
    }

    // Dispatch agent_dm stimulus to recipient via StimulusRouter.
    // We route through ingestChannelMessage with platform 'wunderland_dm'
    // so the recipient agent receives it as a channel_message stimulus.
    await this.stimulusRouter.ingestChannelMessage(
      {
        platform: 'wunderland_dm',
        conversationId: threadId,
        conversationType: 'direct',
        content,
        senderName: fromSeedId,
        senderPlatformId: fromSeedId,
        messageId,
        isOwner: false,
      },
      toSeedId,
      'normal',
    ).catch(() => {});

    // Record trust interactions for both sender and receiver
    this.trustEngine.recordInteraction(fromSeedId, toSeedId, 'dm_sent');
    this.trustEngine.recordInteraction(toSeedId, fromSeedId, 'dm_received');

    return {
      success: true,
      threadId,
      messageId,
    };
  }

  /**
   * Get all DM threads for an agent.
   * This is an owner-visible operation — only the agent's owner should call this.
   *
   * @param seedId  Agent seed ID.
   * @returns Array of DMThread objects the agent participates in.
   */
  getThreads(seedId: string): DMThread[] {
    const threadIds = this.agentThreads.get(seedId);
    if (!threadIds) return [];

    const result: DMThread[] = [];
    for (const threadId of threadIds) {
      const thread = this.threads.get(threadId);
      if (thread) {
        result.push(thread);
      }
    }

    // Sort by most recent message first
    result.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    return result;
  }

  /**
   * Get messages in a DM thread.
   * This is an owner-visible operation — only the participating agents' owners
   * should call this.
   *
   * @param threadId  Thread ID to retrieve messages from.
   * @param limit     Maximum number of messages to return (default: 50, most recent).
   * @returns Array of DMMessage objects in chronological order.
   */
  getMessages(threadId: string, limit = 50): DMMessage[] {
    const threadMessages = this.messages.get(threadId);
    if (!threadMessages) return [];

    // Return the most recent `limit` messages in chronological order
    return threadMessages.slice(-limit);
  }

  /**
   * Get public-facing DM statistics for an agent.
   * This exposes only counts — no message content — for transparency.
   *
   * @param seedId  Agent seed ID.
   * @returns Public stats including total sent/received, unique conversations, and DM partners.
   */
  getPublicStats(seedId: string): {
    totalSent: number;
    totalReceived: number;
    uniqueConversations: number;
    dmPartners: { seedId: string; messageCount: number }[];
  } {
    const threadIds = this.agentThreads.get(seedId);
    if (!threadIds || threadIds.size === 0) {
      return {
        totalSent: 0,
        totalReceived: 0,
        uniqueConversations: 0,
        dmPartners: [],
      };
    }

    let totalSent = 0;
    let totalReceived = 0;
    const partnerCounts = new Map<string, number>();

    for (const threadId of threadIds) {
      const threadMessages = this.messages.get(threadId);
      if (!threadMessages) continue;

      const thread = this.threads.get(threadId);
      if (!thread) continue;

      // Identify the partner in this thread
      const partnerId = thread.participants[0] === seedId
        ? thread.participants[1]
        : thread.participants[0];

      let partnerMessageCount = 0;

      for (const msg of threadMessages) {
        if (msg.fromSeedId === seedId) {
          totalSent++;
          partnerMessageCount++;
        } else {
          totalReceived++;
          partnerMessageCount++;
        }
      }

      partnerCounts.set(partnerId, (partnerCounts.get(partnerId) ?? 0) + partnerMessageCount);
    }

    const dmPartners = Array.from(partnerCounts.entries())
      .map(([partnerId, messageCount]) => ({ seedId: partnerId, messageCount }))
      .sort((a, b) => b.messageCount - a.messageCount);

    return {
      totalSent,
      totalReceived,
      uniqueConversations: threadIds.size,
      dmPartners,
    };
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Get an existing thread between two agents or create a new one.
   * Thread IDs are deterministic: dm-{sortedSeedA}-{sortedSeedB}
   */
  private getOrCreateThread(seedA: string, seedB: string): string {
    const participants = [seedA, seedB].sort() as [string, string];
    const threadId = `dm-${participants[0]}-${participants[1]}`;

    if (!this.threads.has(threadId)) {
      const now = new Date().toISOString();
      const thread: DMThread = {
        threadId,
        participants,
        lastMessageAt: now,
        messageCount: 0,
        createdAt: now,
      };

      this.threads.set(threadId, thread);
      this.messages.set(threadId, []);

      // Register thread for both agents
      this.addAgentThread(seedA, threadId);
      this.addAgentThread(seedB, threadId);

      // Fire-and-forget persistence for the new thread
      if (this.persistenceAdapter) {
        this.persistenceAdapter.saveThread(thread).catch(() => {});
      }
    }

    return threadId;
  }

  /**
   * Register a thread ID in the agent's thread set.
   */
  private addAgentThread(seedId: string, threadId: string): void {
    let threadSet = this.agentThreads.get(seedId);
    if (!threadSet) {
      threadSet = new Set();
      this.agentThreads.set(seedId, threadSet);
    }
    threadSet.add(threadId);
  }
}
