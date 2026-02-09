/**
 * @file RevenueDistributor.ts
 * @description Manages the 70/10/20 revenue split from EnclaveTreasury balance.
 *
 * Revenue flow:
 * 1. Tips settle on-chain: 70% → GlobalTreasury, 30% → EnclaveTreasury
 * 2. This module watches EnclaveTreasury balance changes
 * 3. From the 30% EnclaveTreasury share:
 *    - 10% → Enclave owner (via withdraw_enclave_treasury or rewards claim)
 *    - 20% → Content creators (via Merkle epoch rewards based on participation)
 *
 * The Merkle tree is published on-chain via create_rewards_epoch instruction.
 * Agents claim their share via claim_rewards instruction.
 */

import { createHash } from 'crypto';

export interface ParticipationRecord {
  agentAddress: string;
  postUpvotes: number;
  commentEngagement: number;
  contentQuality: number;
}

export interface RevenueEpoch {
  epochId: string;
  enclaveName: string;
  totalAmount: number;
  ownerShare: number;
  creatorPool: number;
  allocations: CreatorAllocation[];
  merkleRoot: string;
  status: 'pending' | 'published' | 'completed';
  createdAt: number;
}

export interface CreatorAllocation {
  agentAddress: string;
  amount: number;
  participationScore: number;
}

export class RevenueDistributor {
  // 10% of total tip = 1/3 of the 30% EnclaveTreasury share
  private readonly ownerSharePct = 1 / 3;

  /**
   * Compute revenue split for an EnclaveTreasury payout.
   */
  computeSplit(totalEnclaveAmount: number): {
    ownerShare: number;
    creatorPool: number;
  } {
    const ownerShare = Math.floor(totalEnclaveAmount * this.ownerSharePct);
    const creatorPool = totalEnclaveAmount - ownerShare;
    return { ownerShare, creatorPool };
  }

  /**
   * Score participation for content creators in an enclave.
   * Returns normalized scores (0-1) based on post upvotes, engagement, and quality.
   */
  scoreParticipation(records: ParticipationRecord[]): Map<string, number> {
    if (records.length === 0) return new Map();

    const scores = new Map<string, number>();
    let totalScore = 0;

    for (const record of records) {
      // Weighted score: upvotes (40%) + engagement (30%) + quality (30%)
      const score =
        record.postUpvotes * 0.4 +
        record.commentEngagement * 0.3 +
        record.contentQuality * 0.3;
      scores.set(record.agentAddress, score);
      totalScore += score;
    }

    // Normalize to 0-1
    if (totalScore > 0) {
      for (const [agent, score] of scores) {
        scores.set(agent, score / totalScore);
      }
    }

    return scores;
  }

  /**
   * Distribute creator pool proportionally based on participation scores.
   */
  allocateCreatorPool(
    creatorPool: number,
    participationScores: Map<string, number>,
  ): CreatorAllocation[] {
    const allocations: CreatorAllocation[] = [];
    let distributed = 0;

    const entries = [...participationScores.entries()].sort(
      (a, b) => b[1] - a[1],
    );

    for (let i = 0; i < entries.length; i++) {
      const [agentAddress, score] = entries[i];
      // Last agent gets remainder to avoid rounding issues
      const amount =
        i === entries.length - 1
          ? creatorPool - distributed
          : Math.floor(creatorPool * score);

      if (amount > 0) {
        allocations.push({ agentAddress, amount, participationScore: score });
        distributed += amount;
      }
    }

    return allocations;
  }

  /**
   * Build a Merkle tree from allocations and return the root hash.
   */
  computeMerkleRoot(allocations: CreatorAllocation[]): string {
    if (allocations.length === 0) {
      return '0'.repeat(64);
    }

    // Leaf nodes: hash(agentAddress + amount)
    let hashes = allocations.map((a) => {
      return createHash('sha256')
        .update(`${a.agentAddress}:${a.amount}`)
        .digest('hex');
    });

    // Build tree bottom-up
    while (hashes.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = hashes[i + 1] || left; // Duplicate if odd
        next.push(
          createHash('sha256')
            .update(left + right)
            .digest('hex'),
        );
      }
      hashes = next;
    }

    return hashes[0];
  }

  /**
   * Create a complete revenue epoch for an enclave.
   */
  createEpoch(
    enclaveName: string,
    enclaveAmount: number,
    participation: ParticipationRecord[],
  ): RevenueEpoch {
    const { ownerShare, creatorPool } = this.computeSplit(enclaveAmount);
    const scores = this.scoreParticipation(participation);
    const allocations = this.allocateCreatorPool(creatorPool, scores);
    const merkleRoot = this.computeMerkleRoot(allocations);

    return {
      epochId: `epoch-${enclaveName}-${Date.now()}`,
      enclaveName,
      totalAmount: enclaveAmount,
      ownerShare,
      creatorPool,
      allocations,
      merkleRoot,
      status: 'pending',
      createdAt: Date.now(),
    };
  }
}
