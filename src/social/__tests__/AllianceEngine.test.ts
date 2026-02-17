/**
 * @fileoverview Tests for AllianceEngine — multi-agent alliance/faction system
 * @module wunderland/social/__tests__/AllianceEngine.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AllianceEngine,
  type IAlliancePersistenceAdapter,
} from '../AllianceEngine.js';
import type { PADState } from '../MoodEngine.js';

// ============================================================================
// Mock Factories
// ============================================================================

function createMockTrustEngine() {
  return {
    getTrust: vi.fn<(from: string, to: string) => number>().mockReturnValue(0.8),
    getReputation: vi.fn<(seedId: string) => number>().mockReturnValue(0.75),
  };
}

function createMockMoodEngine() {
  return {
    getState: vi.fn<(seedId: string) => PADState | undefined>().mockReturnValue({
      valence: 0.5,
      arousal: 0.3,
      dominance: 0.4,
    }),
  };
}

function createMockEnclaveRegistry() {
  return {
    getSubscriptions: vi.fn<(seedId: string) => string[]>().mockReturnValue([]),
  };
}

function createMockPersistenceAdapter(): IAlliancePersistenceAdapter {
  return {
    loadAlliances: vi.fn().mockResolvedValue([]),
    saveAlliance: vi.fn().mockResolvedValue(undefined),
    loadProposals: vi.fn().mockResolvedValue([]),
    saveProposal: vi.fn().mockResolvedValue(undefined),
  };
}

function defaultConfig() {
  return {
    name: 'Test Alliance',
    description: 'A test alliance for unit tests.',
    sharedTopics: ['ai-safety', 'alignment'],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('AllianceEngine', () => {
  let engine: AllianceEngine;
  let trustEngine: ReturnType<typeof createMockTrustEngine>;
  let moodEngine: ReturnType<typeof createMockMoodEngine>;
  let enclaveRegistry: ReturnType<typeof createMockEnclaveRegistry>;

  beforeEach(() => {
    trustEngine = createMockTrustEngine();
    moodEngine = createMockMoodEngine();
    enclaveRegistry = createMockEnclaveRegistry();
    engine = new AllianceEngine(
      trustEngine as any,
      moodEngine as any,
      enclaveRegistry as any,
    );
  });

  // --------------------------------------------------------------------------
  // proposeAlliance
  // --------------------------------------------------------------------------

  describe('proposeAlliance', () => {
    it('should create a valid proposal with founder in acceptedBy', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );

      expect(proposal.allianceId).toBeDefined();
      expect(proposal.founderSeedId).toBe('founder-1');
      expect(proposal.invitedSeedIds).toEqual(['agent-2', 'agent-3']);
      expect(proposal.acceptedBy).toContain('founder-1');
      expect(proposal.acceptedBy).toHaveLength(1);
      expect(proposal.status).toBe('pending');
      expect(proposal.config.name).toBe('Test Alliance');
      expect(proposal.config.description).toBe(
        'A test alliance for unit tests.',
      );
      expect(proposal.config.sharedTopics).toEqual([
        'ai-safety',
        'alignment',
      ]);
      expect(proposal.createdAt).toBeDefined();
    });

    it('should throw if the founder is in the invited list', () => {
      expect(() =>
        engine.proposeAlliance(
          'founder-1',
          ['founder-1', 'agent-2'],
          defaultConfig(),
        ),
      ).toThrow('Founder cannot be in the invited list.');
    });

    it('should throw if no invitees are provided', () => {
      expect(() =>
        engine.proposeAlliance('founder-1', [], defaultConfig()),
      ).toThrow('At least 1 agent must be invited.');
    });

    it('should throw if more than 7 invitees are provided', () => {
      const tooMany = Array.from({ length: 8 }, (_, i) => `agent-${i}`);
      expect(() =>
        engine.proposeAlliance('founder-1', tooMany, defaultConfig()),
      ).toThrow('At most 7 agents can be invited (total max 8 members).');
    });

    it('should allow exactly 7 invitees', () => {
      const maxInvited = Array.from({ length: 7 }, (_, i) => `agent-${i}`);
      const proposal = engine.proposeAlliance(
        'founder-1',
        maxInvited,
        defaultConfig(),
      );
      expect(proposal.invitedSeedIds).toHaveLength(7);
    });

    it('should throw if mutual trust is below 0.6', () => {
      // founder -> agent-2 trust is 0.8, but agent-2 -> founder is 0.3
      trustEngine.getTrust.mockImplementation(
        (from: string, to: string) => {
          if (from === 'agent-2' && to === 'founder-1') return 0.3;
          return 0.8;
        },
      );

      expect(() =>
        engine.proposeAlliance(
          'founder-1',
          ['agent-2'],
          defaultConfig(),
        ),
      ).toThrow(/Insufficient mutual trust/);
    });

    it('should throw if trust check fails for any one invitee', () => {
      // agent-3 has low trust with founder, agent-2 is fine
      trustEngine.getTrust.mockImplementation(
        (from: string, to: string) => {
          if (
            (from === 'founder-1' && to === 'agent-3') ||
            (from === 'agent-3' && to === 'founder-1')
          ) {
            return 0.2;
          }
          return 0.8;
        },
      );

      expect(() =>
        engine.proposeAlliance(
          'founder-1',
          ['agent-2', 'agent-3'],
          defaultConfig(),
        ),
      ).toThrow(/Insufficient mutual trust.*agent-3/);
    });

    it('should call getTrust for each invited agent bidirectionally', () => {
      engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );

      expect(trustEngine.getTrust).toHaveBeenCalledWith(
        'founder-1',
        'agent-2',
      );
      expect(trustEngine.getTrust).toHaveBeenCalledWith(
        'agent-2',
        'founder-1',
      );
      expect(trustEngine.getTrust).toHaveBeenCalledWith(
        'founder-1',
        'agent-3',
      );
      expect(trustEngine.getTrust).toHaveBeenCalledWith(
        'agent-3',
        'founder-1',
      );
    });

    it('should not mutate the original config arrays', () => {
      const config = defaultConfig();
      const originalTopics = [...config.sharedTopics];
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        config,
      );

      // Mutating proposal should not affect original config
      proposal.config.sharedTopics.push('new-topic');
      expect(config.sharedTopics).toEqual(originalTopics);
    });

    it('should not mutate the original invitedSeedIds array', () => {
      const invited = ['agent-2', 'agent-3'];
      const proposal = engine.proposeAlliance(
        'founder-1',
        invited,
        defaultConfig(),
      );

      proposal.invitedSeedIds.push('agent-4');
      expect(invited).toEqual(['agent-2', 'agent-3']);
    });
  });

  // --------------------------------------------------------------------------
  // acceptInvitation
  // --------------------------------------------------------------------------

  describe('acceptInvitation', () => {
    it('should return false for a non-existent alliance', () => {
      expect(engine.acceptInvitation('nonexistent', 'agent-2')).toBe(false);
    });

    it('should return false if the seed is not in the invited list', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );
      expect(engine.acceptInvitation(proposal.allianceId, 'agent-99')).toBe(
        false,
      );
    });

    it('should return false if the agent already accepted', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );
      engine.acceptInvitation(proposal.allianceId, 'agent-2');
      // Second acceptance should return false
      expect(engine.acceptInvitation(proposal.allianceId, 'agent-2')).toBe(
        false,
      );
    });

    it('should return false for a proposal that was already rejected', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );
      engine.rejectInvitation(proposal.allianceId, 'agent-2');
      expect(engine.acceptInvitation(proposal.allianceId, 'agent-3')).toBe(
        false,
      );
    });

    it('should return true and record acceptance for valid invitation', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );

      const result = engine.acceptInvitation(proposal.allianceId, 'agent-2');
      expect(result).toBe(true);

      const updated = engine.getProposal(proposal.allianceId);
      expect(updated!.acceptedBy).toContain('agent-2');
    });

    it('should trigger alliance formation when all invitees accept', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );

      engine.acceptInvitation(proposal.allianceId, 'agent-2');
      engine.acceptInvitation(proposal.allianceId, 'agent-3');

      const alliance = engine.getAlliance(proposal.allianceId);
      expect(alliance).toBeDefined();
      expect(alliance!.status).toBe('active');
      expect(alliance!.memberSeedIds).toEqual([
        'founder-1',
        'agent-2',
        'agent-3',
      ]);
      expect(alliance!.founderSeedId).toBe('founder-1');
      expect(alliance!.name).toBe('Test Alliance');
      expect(alliance!.sharedTopics).toEqual(['ai-safety', 'alignment']);
    });

    it('should set proposal status to accepted after formation', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );

      engine.acceptInvitation(proposal.allianceId, 'agent-2');

      const updated = engine.getProposal(proposal.allianceId);
      expect(updated!.status).toBe('accepted');
    });

    it('should not form alliance if only some invitees accept', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );

      engine.acceptInvitation(proposal.allianceId, 'agent-2');

      expect(engine.getAlliance(proposal.allianceId)).toBeUndefined();
      const updated = engine.getProposal(proposal.allianceId);
      expect(updated!.status).toBe('pending');
    });

    it('should register all members in agentAlliances after formation', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );

      engine.acceptInvitation(proposal.allianceId, 'agent-2');
      engine.acceptInvitation(proposal.allianceId, 'agent-3');

      expect(engine.getAgentAlliances('founder-1')).toHaveLength(1);
      expect(engine.getAgentAlliances('agent-2')).toHaveLength(1);
      expect(engine.getAgentAlliances('agent-3')).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // rejectInvitation
  // --------------------------------------------------------------------------

  describe('rejectInvitation', () => {
    it('should return false for a non-existent alliance', () => {
      expect(engine.rejectInvitation('nonexistent', 'agent-2')).toBe(false);
    });

    it('should return false if the seed is not in the invited list', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );
      expect(engine.rejectInvitation(proposal.allianceId, 'agent-99')).toBe(
        false,
      );
    });

    it('should return false if the proposal is already rejected', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );
      engine.rejectInvitation(proposal.allianceId, 'agent-2');
      expect(engine.rejectInvitation(proposal.allianceId, 'agent-3')).toBe(
        false,
      );
    });

    it('should set proposal status to rejected', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );

      const result = engine.rejectInvitation(proposal.allianceId, 'agent-2');
      expect(result).toBe(true);

      const updated = engine.getProposal(proposal.allianceId);
      expect(updated!.status).toBe('rejected');
    });

    it('should prevent subsequent acceptances after rejection', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );

      engine.rejectInvitation(proposal.allianceId, 'agent-3');

      expect(engine.acceptInvitation(proposal.allianceId, 'agent-2')).toBe(
        false,
      );
    });
  });

  // --------------------------------------------------------------------------
  // dissolveAlliance
  // --------------------------------------------------------------------------

  describe('dissolveAlliance', () => {
    function createActiveAlliance() {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );
      engine.acceptInvitation(proposal.allianceId, 'agent-2');
      engine.acceptInvitation(proposal.allianceId, 'agent-3');
      return proposal.allianceId;
    }

    it('should return false for a non-existent alliance', () => {
      expect(engine.dissolveAlliance('nonexistent', 'founder-1')).toBe(false);
    });

    it('should return false if requester is not the founder', () => {
      const allianceId = createActiveAlliance();
      expect(engine.dissolveAlliance(allianceId, 'agent-2')).toBe(false);
    });

    it('should dissolve the alliance when requested by the founder', () => {
      const allianceId = createActiveAlliance();

      const result = engine.dissolveAlliance(allianceId, 'founder-1');
      expect(result).toBe(true);

      const alliance = engine.getAlliance(allianceId);
      expect(alliance!.status).toBe('dissolved');
    });

    it('should remove members from agentAlliances index', () => {
      const allianceId = createActiveAlliance();

      // Before dissolution, members are registered
      expect(engine.getAgentAlliances('founder-1')).toHaveLength(1);
      expect(engine.getAgentAlliances('agent-2')).toHaveLength(1);

      engine.dissolveAlliance(allianceId, 'founder-1');

      expect(engine.getAgentAlliances('founder-1')).toHaveLength(0);
      expect(engine.getAgentAlliances('agent-2')).toHaveLength(0);
      expect(engine.getAgentAlliances('agent-3')).toHaveLength(0);
    });

    it('should return false if alliance is already dissolved', () => {
      const allianceId = createActiveAlliance();
      engine.dissolveAlliance(allianceId, 'founder-1');
      expect(engine.dissolveAlliance(allianceId, 'founder-1')).toBe(false);
    });

    it('should not appear in getAllAlliances after dissolution', () => {
      const allianceId = createActiveAlliance();
      expect(engine.getAllAlliances()).toHaveLength(1);

      engine.dissolveAlliance(allianceId, 'founder-1');
      expect(engine.getAllAlliances()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // getCollectiveMood
  // --------------------------------------------------------------------------

  describe('getCollectiveMood', () => {
    function createActiveAlliance() {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );
      engine.acceptInvitation(proposal.allianceId, 'agent-2');
      engine.acceptInvitation(proposal.allianceId, 'agent-3');
      return proposal.allianceId;
    }

    it('should return null for a non-existent alliance', () => {
      expect(engine.getCollectiveMood('nonexistent')).toBeNull();
    });

    it('should average member moods correctly', () => {
      moodEngine.getState.mockImplementation((seedId: string) => {
        const moods: Record<string, PADState> = {
          'founder-1': { valence: 0.6, arousal: 0.2, dominance: 0.8 },
          'agent-2': { valence: 0.4, arousal: 0.6, dominance: 0.2 },
          'agent-3': { valence: 0.8, arousal: 0.4, dominance: 0.6 },
        };
        return moods[seedId];
      });

      const allianceId = createActiveAlliance();
      const mood = engine.getCollectiveMood(allianceId);

      expect(mood).not.toBeNull();
      // (0.6 + 0.4 + 0.8) / 3 = 0.6
      expect(mood!.valence).toBeCloseTo(0.6, 5);
      // (0.2 + 0.6 + 0.4) / 3 = 0.4
      expect(mood!.arousal).toBeCloseTo(0.4, 5);
      // (0.8 + 0.2 + 0.6) / 3 ≈ 0.533
      expect(mood!.dominance).toBeCloseTo(0.5333, 3);
    });

    it('should return null if no members have mood data', () => {
      moodEngine.getState.mockReturnValue(undefined);
      const allianceId = createActiveAlliance();

      expect(engine.getCollectiveMood(allianceId)).toBeNull();
    });

    it('should exclude members with no mood data from the average', () => {
      moodEngine.getState.mockImplementation((seedId: string) => {
        if (seedId === 'founder-1') {
          return { valence: 0.6, arousal: 0.4, dominance: 0.8 };
        }
        if (seedId === 'agent-2') {
          return { valence: 0.4, arousal: 0.6, dominance: 0.2 };
        }
        // agent-3 has no mood data
        return undefined;
      });

      const allianceId = createActiveAlliance();
      const mood = engine.getCollectiveMood(allianceId);

      expect(mood).not.toBeNull();
      // Average of 2 members only
      expect(mood!.valence).toBeCloseTo(0.5, 5);
      expect(mood!.arousal).toBeCloseTo(0.5, 5);
      expect(mood!.dominance).toBeCloseTo(0.5, 5);
    });
  });

  // --------------------------------------------------------------------------
  // getCollectiveReputation
  // --------------------------------------------------------------------------

  describe('getCollectiveReputation', () => {
    function createActiveAlliance() {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );
      engine.acceptInvitation(proposal.allianceId, 'agent-2');
      engine.acceptInvitation(proposal.allianceId, 'agent-3');
      return proposal.allianceId;
    }

    it('should return null for a non-existent alliance', () => {
      expect(engine.getCollectiveReputation('nonexistent')).toBeNull();
    });

    it('should average member reputations correctly', () => {
      trustEngine.getReputation.mockImplementation((seedId: string) => {
        const reps: Record<string, number> = {
          'founder-1': 0.9,
          'agent-2': 0.6,
          'agent-3': 0.3,
        };
        return reps[seedId] ?? 0;
      });

      const allianceId = createActiveAlliance();
      const rep = engine.getCollectiveReputation(allianceId);

      expect(rep).not.toBeNull();
      // (0.9 + 0.6 + 0.3) / 3 = 0.6
      expect(rep).toBeCloseTo(0.6, 5);
    });

    it('should call getReputation for every member', () => {
      const allianceId = createActiveAlliance();
      trustEngine.getReputation.mockClear();

      engine.getCollectiveReputation(allianceId);

      expect(trustEngine.getReputation).toHaveBeenCalledWith('founder-1');
      expect(trustEngine.getReputation).toHaveBeenCalledWith('agent-2');
      expect(trustEngine.getReputation).toHaveBeenCalledWith('agent-3');
      expect(trustEngine.getReputation).toHaveBeenCalledTimes(3);
    });
  });

  // --------------------------------------------------------------------------
  // Query Methods: getAlliance, getAgentAlliances, getAllAlliances, getProposal
  // --------------------------------------------------------------------------

  describe('query methods', () => {
    it('getAlliance should return undefined for unknown ID', () => {
      expect(engine.getAlliance('nonexistent')).toBeUndefined();
    });

    it('getAgentAlliances should return empty array for unknown agent', () => {
      expect(engine.getAgentAlliances('unknown-agent')).toEqual([]);
    });

    it('getAllAlliances should return empty array initially', () => {
      expect(engine.getAllAlliances()).toEqual([]);
    });

    it('getAllAlliances should return only active alliances', () => {
      // Create two alliances
      const p1 = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );
      engine.acceptInvitation(p1.allianceId, 'agent-2');

      const p2 = engine.proposeAlliance('founder-1', ['agent-3'], {
        ...defaultConfig(),
        name: 'Second Alliance',
      });
      engine.acceptInvitation(p2.allianceId, 'agent-3');

      expect(engine.getAllAlliances()).toHaveLength(2);

      // Dissolve one
      engine.dissolveAlliance(p1.allianceId, 'founder-1');
      const active = engine.getAllAlliances();
      expect(active).toHaveLength(1);
      expect(active[0]!.name).toBe('Second Alliance');
    });

    it('getProposal should return the proposal by alliance ID', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );

      const retrieved = engine.getProposal(proposal.allianceId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.founderSeedId).toBe('founder-1');
    });

    it('getProposal should return undefined for unknown ID', () => {
      expect(engine.getProposal('nonexistent')).toBeUndefined();
    });

    it('getAgentAlliances should reflect multiple alliance memberships', () => {
      const p1 = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );
      engine.acceptInvitation(p1.allianceId, 'agent-2');

      const p2 = engine.proposeAlliance('agent-2', ['founder-1'], {
        ...defaultConfig(),
        name: 'Reverse Alliance',
      });
      engine.acceptInvitation(p2.allianceId, 'founder-1');

      // Both agents should be in 2 alliances
      expect(engine.getAgentAlliances('founder-1')).toHaveLength(2);
      expect(engine.getAgentAlliances('agent-2')).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // getPendingProposals
  // --------------------------------------------------------------------------

  describe('getPendingProposals', () => {
    it('should return empty array when no proposals exist', () => {
      expect(engine.getPendingProposals('agent-2')).toEqual([]);
    });

    it('should return only pending proposals for the given seed', () => {
      // Proposal 1: agent-2 is invited
      engine.proposeAlliance('founder-1', ['agent-2'], defaultConfig());

      // Proposal 2: agent-3 is invited (not agent-2)
      engine.proposeAlliance('founder-1', ['agent-3'], {
        ...defaultConfig(),
        name: 'Other Alliance',
      });

      const pending = engine.getPendingProposals('agent-2');
      expect(pending).toHaveLength(1);
      expect(pending[0]!.config.name).toBe('Test Alliance');
    });

    it('should not include accepted proposals', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );

      expect(engine.getPendingProposals('agent-2')).toHaveLength(1);

      engine.acceptInvitation(proposal.allianceId, 'agent-2');

      // Proposal is now 'accepted', should not appear
      expect(engine.getPendingProposals('agent-2')).toHaveLength(0);
    });

    it('should not include rejected proposals', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );

      engine.rejectInvitation(proposal.allianceId, 'agent-2');

      expect(engine.getPendingProposals('agent-2')).toHaveLength(0);
    });

    it('should return multiple pending proposals for the same agent', () => {
      engine.proposeAlliance('founder-1', ['agent-2'], defaultConfig());
      engine.proposeAlliance('founder-3', ['agent-2'], {
        ...defaultConfig(),
        name: 'Another Alliance',
      });

      expect(engine.getPendingProposals('agent-2')).toHaveLength(2);
    });

    it('should not return proposals where agent is the founder', () => {
      engine.proposeAlliance('founder-1', ['agent-2'], defaultConfig());

      // founder-1 is not in the invitedSeedIds, so no pending proposals
      expect(engine.getPendingProposals('founder-1')).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // detectSharedTopics
  // --------------------------------------------------------------------------

  describe('detectSharedTopics', () => {
    it('should return empty array for empty input', () => {
      expect(engine.detectSharedTopics([])).toEqual([]);
    });

    it('should return all subscriptions for a single agent', () => {
      enclaveRegistry.getSubscriptions.mockReturnValue([
        'ai-safety',
        'governance',
        'ethics',
      ]);

      const shared = engine.detectSharedTopics(['agent-1']);
      expect(shared).toEqual(['ai-safety', 'governance', 'ethics']);
    });

    it('should return the intersection of subscriptions for multiple agents', () => {
      enclaveRegistry.getSubscriptions.mockImplementation(
        (seedId: string) => {
          const subs: Record<string, string[]> = {
            'agent-1': ['ai-safety', 'governance', 'ethics'],
            'agent-2': ['ai-safety', 'ethics', 'machine-learning'],
            'agent-3': ['ai-safety', 'ethics', 'philosophy'],
          };
          return subs[seedId] ?? [];
        },
      );

      const shared = engine.detectSharedTopics([
        'agent-1',
        'agent-2',
        'agent-3',
      ]);
      expect(shared).toEqual(['ai-safety', 'ethics']);
    });

    it('should return empty array when no topics overlap', () => {
      enclaveRegistry.getSubscriptions.mockImplementation(
        (seedId: string) => {
          const subs: Record<string, string[]> = {
            'agent-1': ['ai-safety'],
            'agent-2': ['governance'],
          };
          return subs[seedId] ?? [];
        },
      );

      expect(engine.detectSharedTopics(['agent-1', 'agent-2'])).toEqual([]);
    });

    it('should handle agents with no subscriptions', () => {
      enclaveRegistry.getSubscriptions.mockImplementation(
        (seedId: string) => {
          if (seedId === 'agent-1') return ['ai-safety'];
          return [];
        },
      );

      expect(engine.detectSharedTopics(['agent-1', 'agent-2'])).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Event Emissions
  // --------------------------------------------------------------------------

  describe('event emissions', () => {
    it('should emit alliance_proposed when a proposal is created', () => {
      const handler = vi.fn();
      engine.on('alliance_proposed', handler);

      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ proposal });
    });

    it('should emit alliance_invitation_accepted on acceptance', () => {
      const handler = vi.fn();
      engine.on('alliance_invitation_accepted', handler);

      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );

      engine.acceptInvitation(proposal.allianceId, 'agent-2');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        allianceId: proposal.allianceId,
        seedId: 'agent-2',
      });
    });

    it('should emit alliance_formed when all invitees accept', () => {
      const handler = vi.fn();
      engine.on('alliance_formed', handler);

      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );

      engine.acceptInvitation(proposal.allianceId, 'agent-2');

      expect(handler).toHaveBeenCalledTimes(1);
      const emittedAlliance = handler.mock.calls[0]![0].alliance;
      expect(emittedAlliance.allianceId).toBe(proposal.allianceId);
      expect(emittedAlliance.memberSeedIds).toEqual([
        'founder-1',
        'agent-2',
      ]);
      expect(emittedAlliance.status).toBe('active');
    });

    it('should emit both accepted and formed events in correct order', () => {
      const events: string[] = [];
      engine.on('alliance_invitation_accepted', () =>
        events.push('accepted'),
      );
      engine.on('alliance_formed', () => events.push('formed'));

      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );

      engine.acceptInvitation(proposal.allianceId, 'agent-2');

      expect(events).toEqual(['accepted', 'formed']);
    });

    it('should emit alliance_invitation_rejected on rejection', () => {
      const handler = vi.fn();
      engine.on('alliance_invitation_rejected', handler);

      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );

      engine.rejectInvitation(proposal.allianceId, 'agent-2');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        allianceId: proposal.allianceId,
        seedId: 'agent-2',
      });
    });

    it('should emit alliance_dissolved on dissolution', () => {
      const handler = vi.fn();
      engine.on('alliance_dissolved', handler);

      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );
      engine.acceptInvitation(proposal.allianceId, 'agent-2');

      engine.dissolveAlliance(proposal.allianceId, 'founder-1');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        allianceId: proposal.allianceId,
        requestingSeedId: 'founder-1',
      });
    });

    it('should not emit events for invalid operations', () => {
      const acceptedHandler = vi.fn();
      const rejectedHandler = vi.fn();
      const dissolvedHandler = vi.fn();

      engine.on('alliance_invitation_accepted', acceptedHandler);
      engine.on('alliance_invitation_rejected', rejectedHandler);
      engine.on('alliance_dissolved', dissolvedHandler);

      // Invalid accept/reject/dissolve
      engine.acceptInvitation('nonexistent', 'agent-1');
      engine.rejectInvitation('nonexistent', 'agent-1');
      engine.dissolveAlliance('nonexistent', 'agent-1');

      expect(acceptedHandler).not.toHaveBeenCalled();
      expect(rejectedHandler).not.toHaveBeenCalled();
      expect(dissolvedHandler).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Persistence Adapter
  // --------------------------------------------------------------------------

  describe('persistence adapter', () => {
    let adapter: IAlliancePersistenceAdapter;

    beforeEach(() => {
      adapter = createMockPersistenceAdapter();
      engine.setPersistenceAdapter(adapter);
    });

    it('should call saveProposal when a proposal is created', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );

      expect(adapter.saveProposal).toHaveBeenCalledTimes(1);
      expect(adapter.saveProposal).toHaveBeenCalledWith(proposal);
    });

    it('should call saveProposal on acceptance', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2', 'agent-3'],
        defaultConfig(),
      );

      (adapter.saveProposal as ReturnType<typeof vi.fn>).mockClear();

      engine.acceptInvitation(proposal.allianceId, 'agent-2');

      expect(adapter.saveProposal).toHaveBeenCalledTimes(1);
    });

    it('should call saveAlliance and saveProposal on formation', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );

      (adapter.saveProposal as ReturnType<typeof vi.fn>).mockClear();

      engine.acceptInvitation(proposal.allianceId, 'agent-2');

      // formAlliance calls saveAlliance + saveProposal, then acceptInvitation
      // also calls saveProposal — total: 1 saveAlliance, 2 saveProposal
      expect(adapter.saveAlliance).toHaveBeenCalledTimes(1);
      expect(adapter.saveProposal).toHaveBeenCalledTimes(2);
    });

    it('should call saveProposal on rejection', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );

      (adapter.saveProposal as ReturnType<typeof vi.fn>).mockClear();

      engine.rejectInvitation(proposal.allianceId, 'agent-2');

      expect(adapter.saveProposal).toHaveBeenCalledTimes(1);
    });

    it('should call saveAlliance on dissolution', () => {
      const proposal = engine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );
      engine.acceptInvitation(proposal.allianceId, 'agent-2');

      (adapter.saveAlliance as ReturnType<typeof vi.fn>).mockClear();

      engine.dissolveAlliance(proposal.allianceId, 'founder-1');

      expect(adapter.saveAlliance).toHaveBeenCalledTimes(1);
    });

    it('should not throw if persistence adapter rejects (fire-and-forget)', () => {
      (adapter.saveProposal as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('DB write failed'),
      );

      // Should not throw
      expect(() =>
        engine.proposeAlliance('founder-1', ['agent-2'], defaultConfig()),
      ).not.toThrow();
    });

    it('should not call persistence methods when no adapter is set', () => {
      // Create a fresh engine with no adapter
      const freshEngine = new AllianceEngine(
        trustEngine as any,
        moodEngine as any,
        enclaveRegistry as any,
      );

      // Should work without throwing
      const proposal = freshEngine.proposeAlliance(
        'founder-1',
        ['agent-2'],
        defaultConfig(),
      );
      freshEngine.acceptInvitation(proposal.allianceId, 'agent-2');
      freshEngine.dissolveAlliance(proposal.allianceId, 'founder-1');

      // No adapter calls should have happened
      expect(adapter.saveProposal).not.toHaveBeenCalled();
      expect(adapter.saveAlliance).not.toHaveBeenCalled();
    });
  });
});
