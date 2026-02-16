/**
 * @fileoverview Tests for ToolAccessProfiles — tool category mapping and profile enforcement
 * @module wunderland/social/__tests__/ToolAccessProfiles.test
 */

import { describe, it, expect } from 'vitest';
import {
  TOOL_ACCESS_PROFILES,
  TOOL_CATEGORY_MAP,
  isValidToolAccessProfile,
  getToolAccessProfile,
  getToolCategory,
  isToolAllowedByProfile,
  resolveAllowedTools,
  describePermissions,
  type ToolAccessProfileName,
  type ToolCategory,
} from '../ToolAccessProfiles.js';
import { ToolRiskTier } from '../../core/types.js';

// ── Profile name validation ─────────────────────────────────────────────────

describe('isValidToolAccessProfile', () => {
  const VALID_NAMES: ToolAccessProfileName[] = [
    'social-citizen',
    'social-observer',
    'social-creative',
    'assistant',
    'unrestricted',
  ];

  it('should return true for all 5 valid profile names', () => {
    for (const name of VALID_NAMES) {
      expect(isValidToolAccessProfile(name)).toBe(true);
    }
  });

  it('should return false for invalid profile names', () => {
    expect(isValidToolAccessProfile('foo')).toBe(false);
    expect(isValidToolAccessProfile('')).toBe(false);
    expect(isValidToolAccessProfile('ASSISTANT')).toBe(false);
  });

  it('should have exactly 5 profile entries in the registry', () => {
    expect(Object.keys(TOOL_ACCESS_PROFILES)).toHaveLength(5);
  });
});

// ── getToolAccessProfile ────────────────────────────────────────────────────

describe('getToolAccessProfile', () => {
  it('should return profile for valid name', () => {
    const profile = getToolAccessProfile('assistant');
    expect(profile.name).toBe('assistant');
    expect(profile.displayName).toBe('Assistant');
  });

  it('should throw for invalid name', () => {
    expect(() => getToolAccessProfile('nope' as any)).toThrow('Unknown tool access profile');
  });

  it('all profiles should be frozen', () => {
    for (const name of Object.keys(TOOL_ACCESS_PROFILES) as ToolAccessProfileName[]) {
      const profile = getToolAccessProfile(name);
      expect(Object.isFrozen(profile)).toBe(true);
    }
  });
});

// ── Tool category mapping ───────────────────────────────────────────────────

describe('TOOL_CATEGORY_MAP', () => {
  it('should map core social tools', () => {
    expect(getToolCategory('social_post')).toBe('social');
    expect(getToolCategory('feed_read')).toBe('social');
  });

  it('should map search tools', () => {
    expect(getToolCategory('web_search')).toBe('search');
    expect(getToolCategory('news_search')).toBe('search');
    expect(getToolCategory('browser_navigate')).toBe('search');
  });

  it('should map media tools', () => {
    expect(getToolCategory('giphy_search')).toBe('media');
    expect(getToolCategory('image_search')).toBe('media');
    expect(getToolCategory('text_to_speech')).toBe('media');
  });

  it('should map memory tools', () => {
    expect(getToolCategory('memory_read')).toBe('memory');
    expect(getToolCategory('memory_write')).toBe('memory');
    expect(getToolCategory('conversation_history')).toBe('memory');
  });

  it('should map filesystem tools', () => {
    expect(getToolCategory('file_read')).toBe('filesystem');
    expect(getToolCategory('file_write')).toBe('filesystem');
    expect(getToolCategory('list_directory')).toBe('filesystem');
  });

  it('should map system tools', () => {
    expect(getToolCategory('cli_executor')).toBe('system');
    expect(getToolCategory('code_execution')).toBe('system');
    expect(getToolCategory('run_command')).toBe('system');
  });

  it('should map skills self-management tools to search/memory', () => {
    expect(getToolCategory('skills_list')).toBe('search');
    expect(getToolCategory('skills_read')).toBe('search');
    expect(getToolCategory('skills_status')).toBe('search');
    expect(getToolCategory('skills_enable')).toBe('memory');
    expect(getToolCategory('skills_install')).toBe('memory');
  });

  it('should map schema-on-demand meta tools', () => {
    expect(getToolCategory('extensions_list')).toBe('search');
    expect(getToolCategory('extensions_enable')).toBe('memory');
  });

  it('should map communication tools', () => {
    expect(getToolCategory('email_send')).toBe('communication');
    expect(getToolCategory('slack_send')).toBe('communication');
    expect(getToolCategory('telegram_send')).toBe('communication');
    expect(getToolCategory('discord_send')).toBe('communication');
  });

  it('should return undefined for unknown tools', () => {
    expect(getToolCategory('nonexistent_tool')).toBeUndefined();
  });

  it('should be frozen', () => {
    expect(Object.isFrozen(TOOL_CATEGORY_MAP)).toBe(true);
  });
});

// ── isToolAllowedByProfile ──────────────────────────────────────────────────

describe('isToolAllowedByProfile', () => {
  describe('social-citizen profile', () => {
    const profile = getToolAccessProfile('social-citizen');

    it('should allow social tools', () => {
      expect(isToolAllowedByProfile(profile, 'social_post')).toBe(true);
      expect(isToolAllowedByProfile(profile, 'feed_read')).toBe(true);
    });

    it('should allow search tools', () => {
      expect(isToolAllowedByProfile(profile, 'web_search')).toBe(true);
    });

    it('should allow media tools', () => {
      expect(isToolAllowedByProfile(profile, 'giphy_search')).toBe(true);
    });

    it('should block filesystem tools', () => {
      expect(isToolAllowedByProfile(profile, 'file_read')).toBe(false);
    });

    it('should block system tools', () => {
      expect(isToolAllowedByProfile(profile, 'cli_executor')).toBe(false);
    });

    it('should block communication tools', () => {
      expect(isToolAllowedByProfile(profile, 'email_send')).toBe(false);
    });

    it('should block unknown tools', () => {
      expect(isToolAllowedByProfile(profile, 'unknown_tool')).toBe(false);
    });
  });

  describe('assistant profile', () => {
    const profile = getToolAccessProfile('assistant');

    it('should allow search tools', () => {
      expect(isToolAllowedByProfile(profile, 'web_search')).toBe(true);
    });

    it('should allow memory tools', () => {
      expect(isToolAllowedByProfile(profile, 'memory_read')).toBe(true);
    });

    it('should allow filesystem tools', () => {
      expect(isToolAllowedByProfile(profile, 'file_read')).toBe(true);
    });

    it('should allow productivity tools', () => {
      expect(isToolAllowedByProfile(profile, 'calendar')).toBe(true);
    });

    it('should allow skills tools (mapped to search/memory)', () => {
      expect(isToolAllowedByProfile(profile, 'skills_list')).toBe(true);
      expect(isToolAllowedByProfile(profile, 'skills_enable')).toBe(true);
    });

    it('should allow schema-on-demand meta tools', () => {
      expect(isToolAllowedByProfile(profile, 'extensions_list')).toBe(true);
      expect(isToolAllowedByProfile(profile, 'extensions_enable')).toBe(true);
    });

    it('should block social tools', () => {
      expect(isToolAllowedByProfile(profile, 'social_post')).toBe(false);
    });

    it('should block system tools', () => {
      expect(isToolAllowedByProfile(profile, 'cli_executor')).toBe(false);
    });
  });

  describe('unrestricted profile', () => {
    const profile = getToolAccessProfile('unrestricted');

    it('should allow all known tools', () => {
      for (const toolId of Object.keys(TOOL_CATEGORY_MAP)) {
        expect(isToolAllowedByProfile(profile, toolId)).toBe(true);
      }
    });

    it('should allow unknown tools', () => {
      expect(isToolAllowedByProfile(profile, 'totally_unknown')).toBe(true);
    });
  });

  describe('overrides', () => {
    const profile = getToolAccessProfile('assistant');

    it('additionalBlocked should take precedence over allowed categories', () => {
      expect(isToolAllowedByProfile(profile, 'web_search', { additionalBlocked: ['web_search'] })).toBe(false);
    });

    it('additionalAllowed should override blocked categories', () => {
      expect(isToolAllowedByProfile(profile, 'social_post', { additionalAllowed: ['social_post'] })).toBe(true);
    });

    it('additionalBlocked takes precedence over additionalAllowed', () => {
      expect(isToolAllowedByProfile(profile, 'web_search', {
        additionalAllowed: ['web_search'],
        additionalBlocked: ['web_search'],
      })).toBe(false);
    });
  });
});

// ── resolveAllowedTools ─────────────────────────────────────────────────────

describe('resolveAllowedTools', () => {
  const ALL_TOOLS = [
    'web_search', 'social_post', 'file_read', 'cli_executor',
    'skills_list', 'extensions_list', 'calendar', 'memory_read',
    'email_send',
  ];

  it('assistant profile should filter correctly', () => {
    const allowed = resolveAllowedTools(getToolAccessProfile('assistant'), ALL_TOOLS);
    expect(allowed).toContain('web_search');
    expect(allowed).toContain('file_read');
    expect(allowed).toContain('skills_list');
    expect(allowed).toContain('extensions_list');
    expect(allowed).toContain('calendar');
    expect(allowed).toContain('memory_read');
    expect(allowed).not.toContain('social_post');
    expect(allowed).not.toContain('cli_executor');
    expect(allowed).not.toContain('email_send');
  });

  it('unrestricted should return all tools', () => {
    const allowed = resolveAllowedTools(getToolAccessProfile('unrestricted'), ALL_TOOLS);
    expect(allowed).toHaveLength(ALL_TOOLS.length);
  });

  it('social-observer should exclude social tools', () => {
    const allowed = resolveAllowedTools(getToolAccessProfile('social-observer'), ALL_TOOLS);
    expect(allowed).not.toContain('social_post');
    expect(allowed).toContain('web_search');
  });
});

// ── describePermissions ─────────────────────────────────────────────────────

describe('describePermissions', () => {
  it('should return can/cannot arrays', () => {
    const { can, cannot } = describePermissions(getToolAccessProfile('assistant'));
    expect(Array.isArray(can)).toBe(true);
    expect(Array.isArray(cannot)).toBe(true);
    expect(can.length).toBeGreaterThan(0);
    expect(cannot.length).toBeGreaterThan(0);
  });

  it('unrestricted should have maximum can entries', () => {
    const { can } = describePermissions(getToolAccessProfile('unrestricted'));
    // 8 categories
    expect(can.length).toBe(8);
  });

  it('social-observer cannot descriptions should include social', () => {
    const { cannot } = describePermissions(getToolAccessProfile('social-observer'));
    expect(cannot.some(s => s.toLowerCase().includes('post') || s.toLowerCase().includes('vote'))).toBe(true);
  });
});

// ── Profile configuration validation ────────────────────────────────────────

describe('Profile configurations', () => {
  it('social-citizen maxRiskTier should be TIER_1', () => {
    expect(getToolAccessProfile('social-citizen').maxRiskTier).toBe(ToolRiskTier.TIER_1_AUTONOMOUS);
  });

  it('assistant maxRiskTier should be TIER_2', () => {
    expect(getToolAccessProfile('assistant').maxRiskTier).toBe(ToolRiskTier.TIER_2_ASYNC_REVIEW);
  });

  it('unrestricted maxRiskTier should be TIER_3', () => {
    expect(getToolAccessProfile('unrestricted').maxRiskTier).toBe(ToolRiskTier.TIER_3_SYNC_HITL);
  });

  it('unrestricted should allow all flags', () => {
    const p = getToolAccessProfile('unrestricted');
    expect(p.allowFileSystem).toBe(true);
    expect(p.allowCliExecution).toBe(true);
    expect(p.allowSystemModification).toBe(true);
  });

  it('social-citizen should block all dangerous flags', () => {
    const p = getToolAccessProfile('social-citizen');
    expect(p.allowFileSystem).toBe(false);
    expect(p.allowCliExecution).toBe(false);
    expect(p.allowSystemModification).toBe(false);
  });
});
