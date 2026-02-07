/**
 * @fileoverview Tests for EnclaveRegistry — catalog and subscription management
 * @module wunderland/social/__tests__/EnclaveRegistry.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EnclaveRegistry } from '../EnclaveRegistry.js';
import type { EnclaveConfig } from '../types.js';

/**
 * Factory function to create an EnclaveConfig with defaults.
 */
function createEnclaveConfig(overrides: Partial<EnclaveConfig> = {}): EnclaveConfig {
  return {
    name: 'test-enclave',
    displayName: 'Test Enclave',
    description: 'A test enclave for unit tests',
    tags: ['test', 'unit-testing'],
    creatorSeedId: 'seed-creator',
    rules: ['Be respectful', 'Stay on topic'],
    ...overrides,
  };
}

describe('EnclaveRegistry', () => {
  let registry: EnclaveRegistry;

  beforeEach(() => {
    registry = new EnclaveRegistry();
  });

  describe('createEnclave', () => {
    it('should add enclave to the registry', () => {
      const config = createEnclaveConfig({ name: 'ai-safety' });
      registry.createEnclave(config);

      const enclave = registry.getEnclave('ai-safety');
      expect(enclave).toBeDefined();
      expect(enclave!.name).toBe('ai-safety');
      expect(enclave!.displayName).toBe('Test Enclave');
    });

    it('should auto-subscribe the creator', () => {
      const config = createEnclaveConfig({
        name: 'my-enclave',
        creatorSeedId: 'seed-alice',
      });
      registry.createEnclave(config);

      const members = registry.getMembers('my-enclave');
      expect(members).toContain('seed-alice');

      const subscriptions = registry.getSubscriptions('seed-alice');
      expect(subscriptions).toContain('my-enclave');
    });

    it('should throw if enclave name already exists', () => {
      const config = createEnclaveConfig({ name: 'duplicate' });
      registry.createEnclave(config);

      expect(() => {
        registry.createEnclave(createEnclaveConfig({ name: 'duplicate' }));
      }).toThrow("Enclave 'duplicate' already exists.");
    });

    it('should allow multiple enclaves with different names', () => {
      registry.createEnclave(createEnclaveConfig({ name: 'enc-1' }));
      registry.createEnclave(createEnclaveConfig({ name: 'enc-2' }));
      registry.createEnclave(createEnclaveConfig({ name: 'enc-3' }));

      expect(registry.listEnclaves()).toHaveLength(3);
    });
  });

  describe('subscribe', () => {
    beforeEach(() => {
      registry.createEnclave(createEnclaveConfig({ name: 'news', creatorSeedId: 'seed-creator' }));
    });

    it('should add agent to enclave members', () => {
      const result = registry.subscribe('seed-bob', 'news');

      expect(result).toBe(true);
      expect(registry.getMembers('news')).toContain('seed-bob');
    });

    it('should add enclave to agent subscriptions', () => {
      registry.subscribe('seed-bob', 'news');

      const subs = registry.getSubscriptions('seed-bob');
      expect(subs).toContain('news');
    });

    it('should return true for new subscription', () => {
      const result = registry.subscribe('seed-new', 'news');
      expect(result).toBe(true);
    });

    it('should return false if already subscribed', () => {
      registry.subscribe('seed-bob', 'news');
      const result = registry.subscribe('seed-bob', 'news');

      expect(result).toBe(false);
    });

    it('should return false if enclave does not exist', () => {
      const result = registry.subscribe('seed-bob', 'nonexistent');
      expect(result).toBe(false);
    });

    it('should allow multiple agents to subscribe to same enclave', () => {
      registry.subscribe('seed-bob', 'news');
      registry.subscribe('seed-alice', 'news');
      registry.subscribe('seed-charlie', 'news');

      const members = registry.getMembers('news');
      expect(members).toHaveLength(4); // Including creator
      expect(members).toContain('seed-bob');
      expect(members).toContain('seed-alice');
      expect(members).toContain('seed-charlie');
    });

    it('should allow agent to subscribe to multiple enclaves', () => {
      registry.createEnclave(createEnclaveConfig({ name: 'tech', creatorSeedId: 'seed-x' }));
      registry.createEnclave(createEnclaveConfig({ name: 'science', creatorSeedId: 'seed-y' }));

      registry.subscribe('seed-bob', 'news');
      registry.subscribe('seed-bob', 'tech');
      registry.subscribe('seed-bob', 'science');

      const subs = registry.getSubscriptions('seed-bob');
      expect(subs).toHaveLength(3);
      expect(subs).toContain('news');
      expect(subs).toContain('tech');
      expect(subs).toContain('science');
    });
  });

  describe('unsubscribe', () => {
    beforeEach(() => {
      registry.createEnclave(createEnclaveConfig({ name: 'gaming', creatorSeedId: 'seed-creator' }));
      registry.subscribe('seed-bob', 'gaming');
    });

    it('should remove agent from enclave members', () => {
      const result = registry.unsubscribe('seed-bob', 'gaming');

      expect(result).toBe(true);
      expect(registry.getMembers('gaming')).not.toContain('seed-bob');
    });

    it('should remove enclave from agent subscriptions', () => {
      registry.unsubscribe('seed-bob', 'gaming');

      const subs = registry.getSubscriptions('seed-bob');
      expect(subs).not.toContain('gaming');
    });

    it('should return true for successful unsubscription', () => {
      const result = registry.unsubscribe('seed-bob', 'gaming');
      expect(result).toBe(true);
    });

    it('should return false if not subscribed', () => {
      const result = registry.unsubscribe('seed-unknown', 'gaming');
      expect(result).toBe(false);
    });

    it('should return false if enclave does not exist', () => {
      const result = registry.unsubscribe('seed-bob', 'nonexistent');
      expect(result).toBe(false);
    });

    it('should allow creator to unsubscribe', () => {
      const result = registry.unsubscribe('seed-creator', 'gaming');

      expect(result).toBe(true);
      expect(registry.getMembers('gaming')).not.toContain('seed-creator');
    });
  });

  describe('getEnclave', () => {
    it('should return enclave config by name', () => {
      const config = createEnclaveConfig({
        name: 'specific-enc',
        displayName: 'Specific Enclave',
        tags: ['specific', 'test'],
      });
      registry.createEnclave(config);

      const result = registry.getEnclave('specific-enc');

      expect(result).toBeDefined();
      expect(result!.name).toBe('specific-enc');
      expect(result!.displayName).toBe('Specific Enclave');
      expect(result!.tags).toEqual(['specific', 'test']);
    });

    it('should return undefined for unknown enclave', () => {
      const result = registry.getEnclave('unknown');
      expect(result).toBeUndefined();
    });

    it('should return the full config with all fields', () => {
      const config = createEnclaveConfig({
        name: 'full-config',
        displayName: 'Full Config Enc',
        description: 'Has all fields',
        tags: ['a', 'b', 'c'],
        creatorSeedId: 'seed-full',
        minLevelToPost: 'RESIDENT',
        rules: ['Rule 1', 'Rule 2'],
      });
      registry.createEnclave(config);

      const result = registry.getEnclave('full-config');

      expect(result).toEqual(config);
    });
  });

  describe('listEnclaves', () => {
    it('should return empty array when no enclaves exist', () => {
      const result = registry.listEnclaves();
      expect(result).toEqual([]);
    });

    it('should return all registered enclaves', () => {
      registry.createEnclave(createEnclaveConfig({ name: 'enc-a' }));
      registry.createEnclave(createEnclaveConfig({ name: 'enc-b' }));
      registry.createEnclave(createEnclaveConfig({ name: 'enc-c' }));

      const result = registry.listEnclaves();

      expect(result).toHaveLength(3);
      const names = result.map((s) => s.name);
      expect(names).toContain('enc-a');
      expect(names).toContain('enc-b');
      expect(names).toContain('enc-c');
    });
  });

  describe('getMembers', () => {
    it('should return all member seed IDs for an enclave', () => {
      registry.createEnclave(createEnclaveConfig({ name: 'club', creatorSeedId: 'seed-founder' }));
      registry.subscribe('seed-alice', 'club');
      registry.subscribe('seed-bob', 'club');

      const members = registry.getMembers('club');

      expect(members).toHaveLength(3);
      expect(members).toContain('seed-founder');
      expect(members).toContain('seed-alice');
      expect(members).toContain('seed-bob');
    });

    it('should return empty array for unknown enclave', () => {
      const members = registry.getMembers('nonexistent');
      expect(members).toEqual([]);
    });

    it('should return only creator for newly created enclave', () => {
      registry.createEnclave(createEnclaveConfig({ name: 'new-enc', creatorSeedId: 'seed-only' }));

      const members = registry.getMembers('new-enc');

      expect(members).toHaveLength(1);
      expect(members).toContain('seed-only');
    });
  });

  describe('getSubscriptions', () => {
    it('should return all enclave names an agent is subscribed to', () => {
      registry.createEnclave(createEnclaveConfig({ name: 'enc-1', creatorSeedId: 'seed-x' }));
      registry.createEnclave(createEnclaveConfig({ name: 'enc-2', creatorSeedId: 'seed-y' }));
      registry.createEnclave(createEnclaveConfig({ name: 'enc-3', creatorSeedId: 'seed-z' }));

      registry.subscribe('seed-bob', 'enc-1');
      registry.subscribe('seed-bob', 'enc-2');
      registry.subscribe('seed-bob', 'enc-3');

      const subs = registry.getSubscriptions('seed-bob');

      expect(subs).toHaveLength(3);
      expect(subs).toContain('enc-1');
      expect(subs).toContain('enc-2');
      expect(subs).toContain('enc-3');
    });

    it('should return empty array for agent with no subscriptions', () => {
      const subs = registry.getSubscriptions('seed-unsubscribed');
      expect(subs).toEqual([]);
    });

    it('should include enclaves created by the agent', () => {
      registry.createEnclave(createEnclaveConfig({ name: 'owned', creatorSeedId: 'seed-owner' }));

      const subs = registry.getSubscriptions('seed-owner');

      expect(subs).toContain('owned');
    });
  });

  describe('matchEnclavesByTags', () => {
    beforeEach(() => {
      registry.createEnclave(
        createEnclaveConfig({
          name: 'ai-safety',
          tags: ['ai', 'safety', 'alignment'],
          creatorSeedId: 'seed-1',
        }),
      );
      registry.createEnclave(
        createEnclaveConfig({
          name: 'machine-learning',
          tags: ['ai', 'ml', 'neural-networks'],
          creatorSeedId: 'seed-2',
        }),
      );
      registry.createEnclave(
        createEnclaveConfig({
          name: 'web-dev',
          tags: ['javascript', 'frontend', 'react'],
          creatorSeedId: 'seed-3',
        }),
      );
      registry.createEnclave(
        createEnclaveConfig({
          name: 'security',
          tags: ['safety', 'cybersecurity', 'privacy'],
          creatorSeedId: 'seed-4',
        }),
      );
    });

    it('should find enclaves with overlapping tags', () => {
      const matches = registry.matchEnclavesByTags(['ai']);

      expect(matches).toHaveLength(2);
      const names = matches.map((s) => s.name);
      expect(names).toContain('ai-safety');
      expect(names).toContain('machine-learning');
    });

    it('should be case-insensitive for tag matching', () => {
      const matches = registry.matchEnclavesByTags(['AI', 'SAFETY']);

      expect(matches.length).toBeGreaterThanOrEqual(2);
      const names = matches.map((s) => s.name);
      expect(names).toContain('ai-safety');
    });

    it('should return enclaves matching any of the provided tags', () => {
      const matches = registry.matchEnclavesByTags(['safety', 'react']);

      expect(matches).toHaveLength(3);
      const names = matches.map((s) => s.name);
      expect(names).toContain('ai-safety');
      expect(names).toContain('security');
      expect(names).toContain('web-dev');
    });

    it('should return empty array when no tags match', () => {
      const matches = registry.matchEnclavesByTags(['nonexistent-tag', 'another-fake']);
      expect(matches).toEqual([]);
    });

    it('should return empty array for empty tags input', () => {
      const matches = registry.matchEnclavesByTags([]);
      expect(matches).toEqual([]);
    });

    it('should return enclave even if only one tag matches', () => {
      const matches = registry.matchEnclavesByTags(['alignment']);

      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('ai-safety');
    });

    it('should handle enclave with single tag', () => {
      registry.createEnclave(
        createEnclaveConfig({
          name: 'single-tag',
          tags: ['unique'],
          creatorSeedId: 'seed-5',
        }),
      );

      const matches = registry.matchEnclavesByTags(['unique']);

      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('single-tag');
    });
  });

  describe('Edge cases', () => {
    it('should handle special characters in enclave names', () => {
      const config = createEnclaveConfig({
        name: 'proof-theory-123',
        creatorSeedId: 'seed-1',
      });
      registry.createEnclave(config);

      const enc = registry.getEnclave('proof-theory-123');
      expect(enc).toBeDefined();
      expect(enc!.name).toBe('proof-theory-123');
    });

    it('should handle empty rules array', () => {
      const config = createEnclaveConfig({
        name: 'no-rules',
        rules: [],
        creatorSeedId: 'seed-1',
      });
      registry.createEnclave(config);

      const enc = registry.getEnclave('no-rules');
      expect(enc!.rules).toEqual([]);
    });

    it('should handle empty tags array', () => {
      const config = createEnclaveConfig({
        name: 'no-tags',
        tags: [],
        creatorSeedId: 'seed-1',
      });
      registry.createEnclave(config);

      const matches = registry.matchEnclavesByTags(['anything']);
      const names = matches.map((s) => s.name);
      expect(names).not.toContain('no-tags');
    });
  });

  describe('Deprecated compatibility methods', () => {
    it('should support createSubreddit as deprecated alias', () => {
      const config = createEnclaveConfig({ name: 'compat-test' });
      registry.createSubreddit(config);

      const enc = registry.getEnclave('compat-test');
      expect(enc).toBeDefined();
    });

    it('should support getSubreddit as deprecated alias', () => {
      const config = createEnclaveConfig({ name: 'compat-get' });
      registry.createEnclave(config);

      const enc = registry.getSubreddit('compat-get');
      expect(enc).toBeDefined();
      expect(enc!.name).toBe('compat-get');
    });

    it('should support listSubreddits as deprecated alias', () => {
      registry.createEnclave(createEnclaveConfig({ name: 'compat-1' }));
      registry.createEnclave(createEnclaveConfig({ name: 'compat-2' }));

      const list = registry.listSubreddits();
      expect(list).toHaveLength(2);
    });

    it('should support matchSubredditsByTags as deprecated alias', () => {
      registry.createEnclave(
        createEnclaveConfig({
          name: 'compat-tags',
          tags: ['compat'],
          creatorSeedId: 'seed-1',
        }),
      );

      const matches = registry.matchSubredditsByTags(['compat']);
      expect(matches).toHaveLength(1);
    });
  });
});
