/**
 * @fileoverview Tests for ContextFirewall
 * @module wunderland/__tests__/ContextFirewall.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ContextFirewall } from '../social/ContextFirewall.js';

describe('ContextFirewall', () => {
  describe('Private mode (default)', () => {
    let firewall: ContextFirewall;

    beforeEach(() => {
      firewall = new ContextFirewall('seed-123');
    });

    it('should default to private mode', () => {
      expect(firewall.getMode()).toBe('private');
    });

    it('should allow user prompts in private mode', () => {
      expect(firewall.isUserPromptAllowed()).toBe(true);
    });

    it('should not allow posting in private mode', () => {
      expect(firewall.canPost()).toBe(false);
    });

    it('should allow private tools', () => {
      expect(firewall.isToolAllowed('calendar')).toBe(true);
      expect(firewall.isToolAllowed('file_search')).toBe(true);
      expect(firewall.isToolAllowed('web_search')).toBe(true);
    });

    it('should block social_post in private mode', () => {
      expect(firewall.isToolAllowed('social_post')).toBe(false);
    });

    it('should block stimuli in private mode', () => {
      const result = firewall.validateRequest({ type: 'stimulus' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('public');
    });

    it('should allow user_prompt requests', () => {
      const result = firewall.validateRequest({ type: 'user_prompt' });
      expect(result.allowed).toBe(true);
    });
  });

  describe('Public mode', () => {
    let firewall: ContextFirewall;

    beforeEach(() => {
      firewall = new ContextFirewall('seed-123', { mode: 'public' });
    });

    it('should be in public mode', () => {
      expect(firewall.getMode()).toBe('public');
    });

    it('should block user prompts in public mode', () => {
      expect(firewall.isUserPromptAllowed()).toBe(false);
    });

    it('should allow posting in public mode', () => {
      expect(firewall.canPost()).toBe(true);
    });

    it('should allow social_post tool', () => {
      expect(firewall.isToolAllowed('social_post')).toBe(true);
    });

    it('should block private tools in public mode', () => {
      expect(firewall.isToolAllowed('calendar')).toBe(false);
      expect(firewall.isToolAllowed('file_search')).toBe(false);
      expect(firewall.isToolAllowed('code_execution')).toBe(false);
    });

    it('should allow stimuli in public mode', () => {
      const result = firewall.validateRequest({ type: 'stimulus' });
      expect(result.allowed).toBe(true);
    });

    it('should block user_prompt requests', () => {
      const result = firewall.validateRequest({ type: 'user_prompt' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocked');
    });
  });

  describe('Mode switching', () => {
    it('should switch from private to public', () => {
      const firewall = new ContextFirewall('seed-123');
      expect(firewall.getMode()).toBe('private');

      firewall.setMode('public');
      expect(firewall.getMode()).toBe('public');
      expect(firewall.isUserPromptAllowed()).toBe(false);
      expect(firewall.canPost()).toBe(true);
    });

    it('should switch from public to private', () => {
      const firewall = new ContextFirewall('seed-123', { mode: 'public' });
      firewall.setMode('private');
      expect(firewall.getMode()).toBe('private');
      expect(firewall.isUserPromptAllowed()).toBe(true);
      expect(firewall.canPost()).toBe(false);
    });
  });

  describe('Tool validation', () => {
    it('should validate tool calls against allowed list', () => {
      const firewall = new ContextFirewall('seed-123', { mode: 'public' });

      const allowed = firewall.validateRequest({ type: 'tool_call', toolId: 'social_post' });
      expect(allowed.allowed).toBe(true);

      const blocked = firewall.validateRequest({ type: 'tool_call', toolId: 'calendar' });
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain('calendar');
    });

    it('should block tool calls with no toolId', () => {
      const firewall = new ContextFirewall('seed-123');
      const result = firewall.validateRequest({ type: 'tool_call' });
      expect(result.allowed).toBe(false);
    });
  });

  describe('Memory sharing', () => {
    it('should default to no memory sharing', () => {
      const firewall = new ContextFirewall('seed-123');
      expect(firewall.isMemoryShared()).toBe(false);
      expect(firewall.getBridgedMemoryCategories()).toEqual([]);
    });

    it('should return bridged categories when memory is shared', () => {
      const firewall = new ContextFirewall('seed-123', {
        sharedMemory: true,
        bridgedMemoryCategories: ['facts', 'preferences'],
      });
      expect(firewall.isMemoryShared()).toBe(true);
      expect(firewall.getBridgedMemoryCategories()).toEqual(['facts', 'preferences']);
    });

    it('should block unbridged memory categories', () => {
      const firewall = new ContextFirewall('seed-123', {
        sharedMemory: true,
        bridgedMemoryCategories: ['facts'],
      });

      const allowed = firewall.validateRequest({ type: 'memory_access', memoryCategory: 'facts' });
      expect(allowed.allowed).toBe(true);

      const blocked = firewall.validateRequest({ type: 'memory_access', memoryCategory: 'secrets' });
      expect(blocked.allowed).toBe(false);
    });
  });

  describe('Custom tools', () => {
    it('should accept custom private tools', () => {
      const firewall = new ContextFirewall('seed-123', {
        privateTools: ['custom_tool_a', 'custom_tool_b'],
      });

      expect(firewall.isToolAllowed('custom_tool_a')).toBe(true);
      expect(firewall.isToolAllowed('calendar')).toBe(false);
    });

    it('should accept custom public tools', () => {
      const firewall = new ContextFirewall('seed-123', {
        mode: 'public',
        publicTools: ['social_post', 'custom_reader'],
      });

      expect(firewall.isToolAllowed('custom_reader')).toBe(true);
      expect(firewall.isToolAllowed('feed_read')).toBe(false);
    });
  });

  describe('getState', () => {
    it('should return serializable state', () => {
      const firewall = new ContextFirewall('seed-123', { mode: 'public' });
      const state = firewall.getState();

      expect(state.seedId).toBe('seed-123');
      expect(state.mode).toBe('public');
      expect(state.userPromptsAllowed).toBe(false);
      expect(state.canPost).toBe(true);
      expect(state.sharedMemory).toBe(false);
      expect(Array.isArray(state.allowedTools)).toBe(true);
    });
  });
});
