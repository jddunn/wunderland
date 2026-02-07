/**
 * @fileoverview Seed Network Manager - Multi-agent coordination for Wunderland
 * @module wunderland/core/SeedNetworkManager
 *
 * Integrates WunderlandSeeds with AgentOS AgentCommunicationBus for
 * inter-seed communication, task handoff, and collective intelligence.
 */

import { AgentCommunicationBus } from '@framers/agentos';
import type {
  AgentMessage,
  AgentMessageType,
  HandoffContext,
  HandoffResult,
} from '@framers/agentos';
import type { IWunderlandSeed } from './WunderlandSeed.js';
import type { HEXACOTraits } from './types.js';

// Local type definitions (not exported from @framers/agentos barrel)
type MessageHandler = (message: AgentMessage) => void | Promise<void>;
type Unsubscribe = () => void;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Seed registration metadata.
 */
export interface SeedRegistration {
  /** The registered seed */
  seed: IWunderlandSeed;
  /** Role within the network (for routing) */
  roleId: string;
  /** Network subscription unsubscribe function */
  unsubscribe: Unsubscribe;
  /** Registration timestamp */
  registeredAt: Date;
  /** Current status */
  status: 'active' | 'paused' | 'offline';
}

/**
 * Message routing strategy.
 */
export type RoutingStrategy =
  | 'personality_match' // Route based on HEXACO compatibility
  | 'load_balance' // Distribute evenly
  | 'specialized' // Route to domain-expert seed
  | 'broadcast'; // Send to all seeds

/**
 * Seed capability declaration for routing.
 */
export interface SeedCapability {
  /** Capability identifier */
  capabilityId: string;
  /** Domain/category */
  domain: string;
  /** Proficiency level (0-1) */
  proficiency: number;
}

/**
 * Configuration for SeedNetworkManager.
 */
export interface SeedNetworkConfig {
  /** Network/agency identifier */
  networkId: string;
  /** Network name */
  networkName?: string;
  /** Default routing strategy */
  defaultRoutingStrategy: RoutingStrategy;
  /** Enable personality-based routing */
  enablePersonalityRouting: boolean;
  /** Maximum seeds in network */
  maxSeeds?: number;
}

// ============================================================================
// SEED NETWORK MANAGER
// ============================================================================

/**
 * Manages a network of WunderlandSeeds for collaborative task execution.
 *
 * Features:
 * - Registers and tracks active seeds
 * - Routes messages based on HEXACO personality compatibility
 * - Manages task handoffs between seeds
 * - Coordinates collective responses
 *
 * @example
 * ```typescript
 * const network = new SeedNetworkManager({
 *   networkId: 'research-team',
 *   defaultRoutingStrategy: 'personality_match',
 * });
 *
 * // Register seeds
 * network.registerSeed(analyticalSeed, 'researcher');
 * network.registerSeed(creativeSeed, 'ideator');
 *
 * // Route task to best-fit seed
 * const target = network.findBestSeed('analyze data patterns', 'researcher');
 * ```
 */
export class SeedNetworkManager {
  private readonly bus: AgentCommunicationBus;
  private readonly config: SeedNetworkConfig;
  private readonly seeds = new Map<string, SeedRegistration>();
  private readonly capabilities = new Map<string, SeedCapability[]>();

  constructor(config: Partial<SeedNetworkConfig> = {}) {
    this.config = {
      networkId: config.networkId ?? `network-${Date.now()}`,
      networkName: config.networkName,
      defaultRoutingStrategy: config.defaultRoutingStrategy ?? 'personality_match',
      enablePersonalityRouting: config.enablePersonalityRouting ?? true,
      maxSeeds: config.maxSeeds ?? 50,
    };

    this.bus = new AgentCommunicationBus({
      routingConfig: {
        enableRoleRouting: true,
        enableLoadBalancing: true,
      },
    });
  }

  // ==========================================================================
  // SEED REGISTRATION
  // ==========================================================================

  /**
   * Registers a WunderlandSeed with the network.
   *
   * @param seed - Seed to register
   * @param roleId - Role identifier for routing
   * @param handler - Message handler for this seed
   * @returns Registration metadata
   */
  registerSeed(seed: IWunderlandSeed, roleId: string, handler?: MessageHandler): SeedRegistration {
    if (this.seeds.size >= (this.config.maxSeeds ?? 50)) {
      throw new Error(`Network ${this.config.networkId} at maximum capacity`);
    }

    if (this.seeds.has(seed.seedId)) {
      throw new Error(`Seed ${seed.seedId} already registered`);
    }

    // Register with communication bus
    this.bus.registerAgent(seed.seedId, this.config.networkId, roleId);

    // Subscribe to messages
    const unsubscribe = this.bus.subscribe(
      seed.seedId,
      handler ?? this.createDefaultHandler(seed),
      { messageTypes: ['task_delegation', 'question', 'answer', 'broadcast'] as AgentMessageType[] }
    );

    const registration: SeedRegistration = {
      seed,
      roleId,
      unsubscribe,
      registeredAt: new Date(),
      status: 'active',
    };

    this.seeds.set(seed.seedId, registration);

    console.log(`[SeedNetwork] Registered seed '${seed.name}' (${seed.seedId}) as ${roleId}`);
    return registration;
  }

  /**
   * Unregisters a seed from the network.
   */
  unregisterSeed(seedId: string): boolean {
    const registration = this.seeds.get(seedId);
    if (!registration) return false;

    registration.unsubscribe();
    this.bus.unregisterAgent(seedId);
    this.seeds.delete(seedId);
    this.capabilities.delete(seedId);

    console.log(`[SeedNetwork] Unregistered seed ${seedId}`);
    return true;
  }

  /**
   * Gets all registered seeds.
   */
  getSeeds(): SeedRegistration[] {
    return Array.from(this.seeds.values());
  }

  /**
   * Gets a seed by ID.
   */
  getSeed(seedId: string): SeedRegistration | undefined {
    return this.seeds.get(seedId);
  }

  /**
   * Gets seeds by role.
   */
  getSeedsByRole(roleId: string): SeedRegistration[] {
    return this.getSeeds().filter((r) => r.roleId === roleId);
  }

  // ==========================================================================
  // CAPABILITY MANAGEMENT
  // ==========================================================================

  /**
   * Declares capabilities for a seed.
   */
  declareCapabilities(seedId: string, capabilities: SeedCapability[]): void {
    this.capabilities.set(seedId, capabilities);
  }

  /**
   * Gets seeds with a specific capability.
   */
  getSeedsWithCapability(capabilityId: string): SeedRegistration[] {
    const result: SeedRegistration[] = [];

    for (const [seedId, caps] of this.capabilities.entries()) {
      if (caps.some((c) => c.capabilityId === capabilityId)) {
        const reg = this.seeds.get(seedId);
        if (reg) result.push(reg);
      }
    }

    return result;
  }

  // ==========================================================================
  // ROUTING
  // ==========================================================================

  /**
   * Finds the best seed for a given task based on routing strategy.
   *
   * @param taskDescription - Description of the task
   * @param preferredRole - Optional role preference
   * @param strategy - Routing strategy override
   */
  findBestSeed(
    taskDescription: string,
    preferredRole?: string,
    strategy?: RoutingStrategy
  ): IWunderlandSeed | null {
    const activeSeeds = this.getSeeds().filter((r) => r.status === 'active');
    if (activeSeeds.length === 0) return null;

    // Filter by role if specified
    const candidates = preferredRole
      ? activeSeeds.filter((r) => r.roleId === preferredRole)
      : activeSeeds;

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].seed;

    const effectiveStrategy = strategy ?? this.config.defaultRoutingStrategy;

    switch (effectiveStrategy) {
      case 'personality_match':
        return this.routeByPersonality(taskDescription, candidates);

      case 'load_balance':
        return candidates[Math.floor(Math.random() * candidates.length)].seed;

      case 'specialized':
        return this.routeBySpecialization(taskDescription, candidates);

      case 'broadcast':
        return candidates[0].seed; // Return first for broadcast initiation

      default:
        return candidates[0].seed;
    }
  }

  /**
   * Routes based on HEXACO personality match.
   */
  private routeByPersonality(
    taskDescription: string,
    candidates: SeedRegistration[]
  ): IWunderlandSeed {
    // Analyze task type from description
    const taskTraits = this.inferTaskTraits(taskDescription);

    // Score each candidate
    const scored = candidates.map((reg) => ({
      reg,
      score: this.calculatePersonalityFit(reg.seed.hexacoTraits, taskTraits),
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    return scored[0].reg.seed;
  }

  /**
   * Infers ideal HEXACO traits for a task.
   */
  private inferTaskTraits(description: string): Partial<HEXACOTraits> {
    const lower = description.toLowerCase();
    const traits: Partial<HEXACOTraits> = {};

    // Analysis/research tasks favor high conscientiousness + openness
    if (lower.includes('analyz') || lower.includes('research') || lower.includes('investigate')) {
      traits.conscientiousness = 0.9;
      traits.openness = 0.8;
      traits.emotionality = 0.3;
    }

    // Creative tasks favor high openness + extraversion
    if (lower.includes('creat') || lower.includes('design') || lower.includes('brainstorm')) {
      traits.openness = 0.95;
      traits.extraversion = 0.7;
      traits.conscientiousness = 0.5;
    }

    // Support/help tasks favor high agreeableness + emotionality
    if (lower.includes('help') || lower.includes('support') || lower.includes('counsel')) {
      traits.agreeableness = 0.9;
      traits.emotionality = 0.7;
      traits.honesty_humility = 0.85;
    }

    // Execution/action tasks favor conscientiousness + low emotionality
    if (lower.includes('execut') || lower.includes('implemen') || lower.includes('build')) {
      traits.conscientiousness = 0.85;
      traits.emotionality = 0.3;
      traits.extraversion = 0.6;
    }

    return traits;
  }

  /**
   * Calculates fit score between seed traits and task requirements.
   */
  private calculatePersonalityFit(
    seedTraits: HEXACOTraits,
    taskTraits: Partial<HEXACOTraits>
  ): number {
    let score = 0;
    let count = 0;

    for (const [trait, idealValue] of Object.entries(taskTraits)) {
      if (idealValue !== undefined && trait in seedTraits) {
        const seedValue = seedTraits[trait as keyof HEXACOTraits];
        // Score = 1 - distance, so closer match = higher score
        score += 1 - Math.abs(seedValue - idealValue);
        count++;
      }
    }

    return count > 0 ? score / count : 0.5;
  }

  /**
   * Routes based on declared specializations.
   */
  private routeBySpecialization(
    taskDescription: string,
    candidates: SeedRegistration[]
  ): IWunderlandSeed {
    const lower = taskDescription.toLowerCase();

    // Find seeds with matching capabilities
    for (const reg of candidates) {
      const caps = this.capabilities.get(reg.seed.seedId) ?? [];
      for (const cap of caps) {
        if (lower.includes(cap.domain.toLowerCase())) {
          return reg.seed;
        }
      }
    }

    // Fallback to first candidate
    return candidates[0].seed;
  }

  // ==========================================================================
  // MESSAGING
  // ==========================================================================

  /**
   * Sends a message from one seed to another.
   */
  async sendMessage(
    fromSeedId: string,
    toSeedId: string,
    content: Record<string, unknown>,
    type: AgentMessageType = 'question'
  ): Promise<void> {
    await this.bus.sendToAgent(toSeedId, {
      type,
      fromAgentId: fromSeedId,
      content,
      priority: 'normal',
    });
  }

  /**
   * Broadcasts a message to all seeds in the network.
   */
  async broadcast(fromSeedId: string, content: Record<string, unknown>): Promise<void> {
    await this.bus.broadcast(this.config.networkId, {
      type: 'broadcast',
      fromAgentId: fromSeedId,
      content,
      priority: 'normal',
    });
  }

  /**
   * Delegates a task from one seed to another.
   */
  async delegateTask(
    fromSeedId: string,
    toSeedId: string,
    taskDescription: string,
    context?: Record<string, unknown>
  ): Promise<HandoffResult> {
    const handoffContext: HandoffContext = {
      taskId: `task-${Date.now()}`,
      taskDescription,
      progress: 0,
      completedWork: [],
      remainingWork: [taskDescription],
      context: { ...context, fromSeedId },
      reason: 'specialization',
    };

    return this.bus.handoff(fromSeedId, toSeedId, handoffContext);
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  /**
   * Creates a default message handler for a seed.
   */
  private createDefaultHandler(seed: IWunderlandSeed): MessageHandler {
    return async (message: AgentMessage) => {
      console.log(`[${seed.name}] Received ${message.type} from ${message.fromAgentId}`);
      // Default: just log. Real implementations should process the message.
    };
  }

  // ==========================================================================
  // STATISTICS
  // ==========================================================================

  /**
   * Gets network statistics.
   */
  getStatistics() {
    const busStats = this.bus.getStatistics();
    return {
      networkId: this.config.networkId,
      totalSeeds: this.seeds.size,
      activeSeeds: this.getSeeds().filter((r) => r.status === 'active').length,
      ...busStats,
    };
  }
}
