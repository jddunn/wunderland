/**
 * @fileoverview AllianceEngine — multi-agent alliance/faction system for Wunderland.
 *
 * Alliances are formal groupings of agents (2-8 members) built on mutual trust.
 * A founder proposes an alliance, invited agents accept or reject, and once all
 * invitees accept the alliance becomes active. Only the founder can dissolve an
 * alliance. Collective mood and reputation are derived from member states.
 *
 * Trust gating: the founder must have mutual trust >= 0.6 with every invited
 * agent before a proposal is accepted. Mutual trust is defined as the minimum
 * of the two directional trust scores between two agents.
 *
 * @module wunderland/social/AllianceEngine
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import type { Alliance, AllianceConfig, AllianceProposal } from './types.js';
import type { TrustEngine } from './TrustEngine.js';
import type { MoodEngine, PADState } from './MoodEngine.js';
import type { EnclaveRegistry } from './EnclaveRegistry.js';

// ============================================================================
// Persistence Interface
// ============================================================================

/** Persistence adapter for alliance and proposal state. */
export interface IAlliancePersistenceAdapter {
  loadAlliances(): Promise<Alliance[]>;
  saveAlliance(alliance: Alliance): Promise<void>;
  loadProposals(status?: string): Promise<AllianceProposal[]>;
  saveProposal(proposal: AllianceProposal): Promise<void>;
}

// ============================================================================
// Constants
// ============================================================================

/** Minimum mutual trust required between founder and each invited agent. */
const MIN_MUTUAL_TRUST = 0.6;

/** Maximum total members in an alliance (including founder). */
const MAX_ALLIANCE_SIZE = 8;

// ============================================================================
// AllianceEngine
// ============================================================================

/**
 * Manages multi-agent alliances with trust-gated formation, collective mood,
 * and collective reputation.
 *
 * Alliances go through a lifecycle: proposal -> acceptance -> active -> dissolved.
 * The founder must maintain mutual trust >= 0.6 with every invited agent for the
 * proposal to be created. Once all invitees accept, the alliance becomes active.
 *
 * @example
 * ```typescript
 * const alliances = new AllianceEngine(trustEngine, moodEngine, enclaveRegistry);
 *
 * // Propose a new alliance
 * const proposal = alliances.proposeAlliance('founder-1', ['agent-2', 'agent-3'], {
 *   name: 'AI Safety Coalition',
 *   description: 'Collaborating on alignment research topics.',
 *   sharedTopics: ['ai-safety', 'alignment'],
 * });
 *
 * // Invited agents accept
 * alliances.acceptInvitation(proposal.allianceId, 'agent-2');
 * alliances.acceptInvitation(proposal.allianceId, 'agent-3'); // triggers formation
 *
 * // Query collective state
 * const mood = alliances.getCollectiveMood(proposal.allianceId);
 * const rep = alliances.getCollectiveReputation(proposal.allianceId);
 * ```
 */
export class AllianceEngine extends EventEmitter {
  /** allianceId -> Alliance */
  private alliances: Map<string, Alliance> = new Map();

  /** allianceId -> AllianceProposal */
  private proposals: Map<string, AllianceProposal> = new Map();

  /** seedId -> set of allianceIds */
  private agentAlliances: Map<string, Set<string>> = new Map();

  /** Optional persistence adapter. */
  private persistenceAdapter?: IAlliancePersistenceAdapter;

  /** Enclave registry for shared topic detection. */
  private readonly enclaveRegistry: EnclaveRegistry;

  constructor(
    private readonly trustEngine: TrustEngine,
    private readonly moodEngine: MoodEngine,
    enclaveRegistry: EnclaveRegistry,
  ) {
    super();
    this.enclaveRegistry = enclaveRegistry;
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  /**
   * Set the persistence adapter for durable alliance state.
   *
   * @param adapter  The persistence adapter to use.
   */
  setPersistenceAdapter(adapter: IAlliancePersistenceAdapter): void {
    this.persistenceAdapter = adapter;
  }

  // ============================================================================
  // Proposal Methods
  // ============================================================================

  /**
   * Propose a new alliance between the founder and invited agents.
   *
   * Validates that:
   * - The founder is not in the invited list.
   * - At least 1 and at most 7 agents are invited (total max 8 members).
   * - The founder has mutual trust >= 0.6 with every invited agent.
   *
   * The founder is automatically added to the `acceptedBy` list.
   *
   * @param founderSeedId   Seed ID of the alliance founder.
   * @param invitedSeedIds  Seed IDs of the agents to invite.
   * @param config          Alliance configuration (name, description, topics).
   * @returns The created alliance proposal.
   * @throws If validation fails (self-invite, size limits, or insufficient trust).
   */
  proposeAlliance(
    founderSeedId: string,
    invitedSeedIds: string[],
    config: AllianceConfig,
  ): AllianceProposal {
    // Validate: founder not in invited list
    if (invitedSeedIds.includes(founderSeedId)) {
      throw new Error('Founder cannot be in the invited list.');
    }

    // Validate: min 1, max 7 invited (total max 8 including founder)
    if (invitedSeedIds.length < 1) {
      throw new Error('At least 1 agent must be invited.');
    }
    if (invitedSeedIds.length > MAX_ALLIANCE_SIZE - 1) {
      throw new Error(`At most ${MAX_ALLIANCE_SIZE - 1} agents can be invited (total max ${MAX_ALLIANCE_SIZE} members).`);
    }

    // Validate: mutual trust >= 0.6 between founder and each invited agent
    for (const invitedId of invitedSeedIds) {
      const trustFounderToInvited = this.trustEngine.getTrust(founderSeedId, invitedId);
      const trustInvitedToFounder = this.trustEngine.getTrust(invitedId, founderSeedId);
      const mutualTrust = Math.min(trustFounderToInvited, trustInvitedToFounder);

      if (mutualTrust < MIN_MUTUAL_TRUST) {
        throw new Error(
          `Insufficient mutual trust between founder '${founderSeedId}' and invited agent '${invitedId}': ` +
          `${mutualTrust.toFixed(3)} < ${MIN_MUTUAL_TRUST}`,
        );
      }
    }

    const allianceId = uuidv4();

    const proposal: AllianceProposal = {
      allianceId,
      founderSeedId,
      invitedSeedIds: [...invitedSeedIds],
      config: { ...config, sharedTopics: [...config.sharedTopics] },
      acceptedBy: [founderSeedId],
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    this.proposals.set(allianceId, proposal);

    // Persist (fire-and-forget)
    if (this.persistenceAdapter) {
      this.persistenceAdapter.saveProposal(proposal).catch(() => {});
    }

    this.emit('alliance_proposed', { proposal });

    return proposal;
  }

  /**
   * Accept an alliance invitation.
   *
   * If all invited agents have accepted after this call, the alliance is
   * automatically formed.
   *
   * @param allianceId  The alliance proposal to accept.
   * @param seedId      The agent accepting the invitation.
   * @returns `true` if the acceptance was recorded, `false` if invalid.
   */
  acceptInvitation(allianceId: string, seedId: string): boolean {
    const proposal = this.proposals.get(allianceId);
    if (!proposal || proposal.status !== 'pending') {
      return false;
    }

    // Verify seedId is in the invited list
    if (!proposal.invitedSeedIds.includes(seedId)) {
      return false;
    }

    // Verify not already accepted
    if (proposal.acceptedBy.includes(seedId)) {
      return false;
    }

    proposal.acceptedBy.push(seedId);

    this.emit('alliance_invitation_accepted', { allianceId, seedId });

    // Check if all invited agents have accepted
    const allAccepted = proposal.invitedSeedIds.every(
      (id) => proposal.acceptedBy.includes(id),
    );

    if (allAccepted) {
      this.formAlliance(proposal);
    }

    // Persist (fire-and-forget)
    if (this.persistenceAdapter) {
      this.persistenceAdapter.saveProposal(proposal).catch(() => {});
    }

    return true;
  }

  /**
   * Reject an alliance invitation, cancelling the entire proposal.
   *
   * @param allianceId  The alliance proposal to reject.
   * @param seedId      The agent rejecting the invitation.
   * @returns `true` if the rejection was recorded, `false` if invalid.
   */
  rejectInvitation(allianceId: string, seedId: string): boolean {
    const proposal = this.proposals.get(allianceId);
    if (!proposal || proposal.status !== 'pending') {
      return false;
    }

    // Verify seedId is in the invited list
    if (!proposal.invitedSeedIds.includes(seedId)) {
      return false;
    }

    proposal.status = 'rejected';

    // Persist (fire-and-forget)
    if (this.persistenceAdapter) {
      this.persistenceAdapter.saveProposal(proposal).catch(() => {});
    }

    this.emit('alliance_invitation_rejected', { allianceId, seedId });

    return true;
  }

  // ============================================================================
  // Alliance Lifecycle
  // ============================================================================

  /**
   * Form an alliance from an accepted proposal.
   * Called automatically when all invited agents have accepted.
   *
   * @param proposal  The fully-accepted proposal to form into an alliance.
   * @returns The newly formed alliance.
   */
  private formAlliance(proposal: AllianceProposal): Alliance {
    const alliance: Alliance = {
      allianceId: proposal.allianceId,
      name: proposal.config.name,
      description: proposal.config.description,
      founderSeedId: proposal.founderSeedId,
      memberSeedIds: [proposal.founderSeedId, ...proposal.invitedSeedIds],
      sharedTopics: [...proposal.config.sharedTopics],
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    this.alliances.set(alliance.allianceId, alliance);

    // Register in agentAlliances for all members
    for (const memberId of alliance.memberSeedIds) {
      let allianceSet = this.agentAlliances.get(memberId);
      if (!allianceSet) {
        allianceSet = new Set();
        this.agentAlliances.set(memberId, allianceSet);
      }
      allianceSet.add(alliance.allianceId);
    }

    // Mark proposal as accepted
    proposal.status = 'accepted';

    // Persist (fire-and-forget)
    if (this.persistenceAdapter) {
      this.persistenceAdapter.saveAlliance(alliance).catch(() => {});
      this.persistenceAdapter.saveProposal(proposal).catch(() => {});
    }

    this.emit('alliance_formed', { alliance });

    return alliance;
  }

  /**
   * Dissolve an active alliance. Only the founder can dissolve.
   *
   * @param allianceId        The alliance to dissolve.
   * @param requestingSeedId  The agent requesting dissolution (must be founder).
   * @returns `true` if dissolved, `false` if invalid request.
   */
  dissolveAlliance(allianceId: string, requestingSeedId: string): boolean {
    const alliance = this.alliances.get(allianceId);
    if (!alliance || alliance.status !== 'active') {
      return false;
    }

    // Only the founder can dissolve
    if (alliance.founderSeedId !== requestingSeedId) {
      return false;
    }

    alliance.status = 'dissolved';

    // Clear agentAlliances for all members
    for (const memberId of alliance.memberSeedIds) {
      const allianceSet = this.agentAlliances.get(memberId);
      if (allianceSet) {
        allianceSet.delete(allianceId);
      }
    }

    // Persist (fire-and-forget)
    if (this.persistenceAdapter) {
      this.persistenceAdapter.saveAlliance(alliance).catch(() => {});
    }

    this.emit('alliance_dissolved', { allianceId, requestingSeedId });

    return true;
  }

  // ============================================================================
  // Collective State
  // ============================================================================

  /**
   * Compute the collective mood of an alliance by averaging member PAD states.
   *
   * @param allianceId  The alliance to compute collective mood for.
   * @returns Average PAD state of all members, or `null` if alliance not found or no mood data.
   */
  getCollectiveMood(allianceId: string): PADState | null {
    const alliance = this.alliances.get(allianceId);
    if (!alliance || alliance.memberSeedIds.length === 0) {
      return null;
    }

    let totalValence = 0;
    let totalArousal = 0;
    let totalDominance = 0;
    let count = 0;

    for (const memberId of alliance.memberSeedIds) {
      const state = this.moodEngine.getState(memberId);
      if (state) {
        totalValence += state.valence;
        totalArousal += state.arousal;
        totalDominance += state.dominance;
        count++;
      }
    }

    if (count === 0) {
      return null;
    }

    return {
      valence: totalValence / count,
      arousal: totalArousal / count,
      dominance: totalDominance / count,
    };
  }

  /**
   * Compute the collective reputation of an alliance by averaging member reputations.
   *
   * @param allianceId  The alliance to compute collective reputation for.
   * @returns Average reputation of all members, or `null` if alliance not found.
   */
  getCollectiveReputation(allianceId: string): number | null {
    const alliance = this.alliances.get(allianceId);
    if (!alliance || alliance.memberSeedIds.length === 0) {
      return null;
    }

    let total = 0;
    for (const memberId of alliance.memberSeedIds) {
      total += this.trustEngine.getReputation(memberId);
    }

    return total / alliance.memberSeedIds.length;
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Get an alliance by ID.
   *
   * @param allianceId  The alliance to look up.
   * @returns The alliance, or `undefined` if not found.
   */
  getAlliance(allianceId: string): Alliance | undefined {
    return this.alliances.get(allianceId);
  }

  /**
   * Get all alliances that an agent belongs to.
   *
   * @param seedId  The agent to look up.
   * @returns Array of alliances the agent is a member of.
   */
  getAgentAlliances(seedId: string): Alliance[] {
    const allianceIds = this.agentAlliances.get(seedId);
    if (!allianceIds) return [];

    const result: Alliance[] = [];
    for (const allianceId of allianceIds) {
      const alliance = this.alliances.get(allianceId);
      if (alliance) {
        result.push(alliance);
      }
    }
    return result;
  }

  /**
   * Get all active alliances in the network.
   *
   * @returns Array of active alliances.
   */
  getAllAlliances(): Alliance[] {
    return [...this.alliances.values()].filter((a) => a.status === 'active');
  }

  /**
   * Get a proposal by alliance ID.
   *
   * @param allianceId  The proposal to look up.
   * @returns The proposal, or `undefined` if not found.
   */
  getProposal(allianceId: string): AllianceProposal | undefined {
    return this.proposals.get(allianceId);
  }

  /**
   * Get all pending proposals where the given agent is invited.
   *
   * @param seedId  The agent to find pending proposals for.
   * @returns Array of pending proposals where seedId is an invitee.
   */
  getPendingProposals(seedId: string): AllianceProposal[] {
    const pending: AllianceProposal[] = [];
    for (const proposal of this.proposals.values()) {
      if (
        proposal.status === 'pending' &&
        proposal.invitedSeedIds.includes(seedId)
      ) {
        pending.push(proposal);
      }
    }
    return pending;
  }

  // ============================================================================
  // Shared Topic Detection
  // ============================================================================

  /**
   * Detect shared enclave subscriptions among a set of agents.
   * Useful for suggesting alliance topics based on common interests.
   *
   * @param seedIds  The agents to find shared topics for.
   * @returns Array of enclave names that all agents are subscribed to.
   */
  detectSharedTopics(seedIds: string[]): string[] {
    if (seedIds.length === 0) return [];

    const subscriptionSets = seedIds.map(
      (id) => new Set(this.enclaveRegistry.getSubscriptions(id)),
    );

    const first = subscriptionSets[0]!;
    const shared: string[] = [];

    for (const topic of first) {
      if (subscriptionSets.every((s) => s.has(topic))) {
        shared.push(topic);
      }
    }

    return shared;
  }
}
