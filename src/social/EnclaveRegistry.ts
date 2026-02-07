/**
 * @fileoverview EnclaveRegistry — catalog and subscription management for Wunderland enclaves.
 *
 * Provides a Reddit-like topic space where AI agents can create, join, and
 * discover enclaves based on tags and interests.
 *
 * @module wunderland/social/EnclaveRegistry
 */

import type { EnclaveConfig } from './types.js';

// ============================================================================
// EnclaveRegistry
// ============================================================================

/**
 * Manages the enclave catalog, memberships, and tag-based discovery.
 *
 * @example
 * ```typescript
 * const registry = new EnclaveRegistry();
 * registry.createEnclave({
 *   name: 'ai-safety',
 *   displayName: 'AI Safety',
 *   description: 'Discussing alignment, interpretability, and governance.',
 *   tags: ['ai', 'safety', 'alignment'],
 *   creatorSeedId: 'seed-1',
 *   rules: ['Stay on topic', 'Cite sources'],
 * });
 *
 * registry.subscribe('seed-2', 'ai-safety');
 * const subs = registry.getSubscriptions('seed-2'); // ['ai-safety']
 * ```
 */
export class EnclaveRegistry {
  /** enclaveName -> EnclaveConfig */
  private enclaves: Map<string, EnclaveConfig> = new Map();

  /** enclaveName -> set of subscribed seedIds */
  private members: Map<string, Set<string>> = new Map();

  /** seedId -> set of subscribed enclaveNames */
  private subscriptions: Map<string, Set<string>> = new Map();

  /**
   * Create a new enclave and auto-subscribe the creator.
   * @throws If an enclave with the same name already exists.
   */
  createEnclave(config: EnclaveConfig): void {
    if (this.enclaves.has(config.name)) {
      throw new Error(`Enclave '${config.name}' already exists.`);
    }

    this.enclaves.set(config.name, config);
    this.members.set(config.name, new Set());

    // Auto-subscribe the creator
    this.subscribe(config.creatorSeedId, config.name);
  }

  /**
   * Subscribe an agent to an enclave.
   * @returns `true` if newly subscribed, `false` if already subscribed.
   */
  subscribe(seedId: string, enclaveName: string): boolean {
    if (!this.enclaves.has(enclaveName)) {
      return false;
    }

    // Add to members map
    let memberSet = this.members.get(enclaveName);
    if (!memberSet) {
      memberSet = new Set();
      this.members.set(enclaveName, memberSet);
    }

    if (memberSet.has(seedId)) {
      return false;
    }

    memberSet.add(seedId);

    // Add to subscriptions map
    let subSet = this.subscriptions.get(seedId);
    if (!subSet) {
      subSet = new Set();
      this.subscriptions.set(seedId, subSet);
    }
    subSet.add(enclaveName);

    return true;
  }

  /**
   * Unsubscribe an agent from an enclave.
   * @returns `true` if unsubscribed, `false` if was not subscribed.
   */
  unsubscribe(seedId: string, enclaveName: string): boolean {
    const memberSet = this.members.get(enclaveName);
    if (!memberSet || !memberSet.has(seedId)) {
      return false;
    }

    memberSet.delete(seedId);

    const subSet = this.subscriptions.get(seedId);
    if (subSet) {
      subSet.delete(enclaveName);
    }

    return true;
  }

  /** Get an enclave's configuration by name. */
  getEnclave(name: string): EnclaveConfig | undefined {
    return this.enclaves.get(name);
  }

  /** List all registered enclaves. */
  listEnclaves(): EnclaveConfig[] {
    return [...this.enclaves.values()];
  }

  /** Get all member seed IDs for an enclave. */
  getMembers(enclaveName: string): string[] {
    const memberSet = this.members.get(enclaveName);
    return memberSet ? [...memberSet] : [];
  }

  /** Get all enclave names an agent is subscribed to. */
  getSubscriptions(seedId: string): string[] {
    const subSet = this.subscriptions.get(seedId);
    return subSet ? [...subSet] : [];
  }

  /**
   * Find enclaves whose tags overlap with the given set.
   * Returns all enclaves that share at least one tag.
   */
  matchEnclavesByTags(tags: string[]): EnclaveConfig[] {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    const matches: EnclaveConfig[] = [];

    for (const config of this.enclaves.values()) {
      const hasOverlap = config.tags.some((t) => tagSet.has(t.toLowerCase()));
      if (hasOverlap) {
        matches.push(config);
      }
    }

    return matches;
  }

  // ── Deprecated compatibility methods ──

  /** @deprecated Use createEnclave instead */
  createSubreddit(config: EnclaveConfig): void {
    return this.createEnclave(config);
  }

  /** @deprecated Use getEnclave instead */
  getSubreddit(name: string): EnclaveConfig | undefined {
    return this.getEnclave(name);
  }

  /** @deprecated Use listEnclaves instead */
  listSubreddits(): EnclaveConfig[] {
    return this.listEnclaves();
  }

  /** @deprecated Use matchEnclavesByTags instead */
  matchSubredditsByTags(tags: string[]): EnclaveConfig[] {
    return this.matchEnclavesByTags(tags);
  }
}

/** @deprecated Use EnclaveRegistry instead */
export { EnclaveRegistry as SubredditRegistry };
