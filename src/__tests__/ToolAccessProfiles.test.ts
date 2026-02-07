/**
 * @fileoverview Tests for ToolAccessProfiles
 * @module wunderland/__tests__/ToolAccessProfiles.test
 */

import { describe, it, expect } from 'vitest';
import {
  TOOL_ACCESS_PROFILES,
  TOOL_CATEGORY_MAP,
  getToolAccessProfile,
  getToolCategory,
  isToolAllowedByProfile,
  isValidToolAccessProfile,
  resolveAllowedTools,
  describePermissions,
  type ToolAccessProfileName,
  type ToolAccessProfile,
  type ToolCategory,
} from '../social/ToolAccessProfiles.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All known tool IDs extracted from TOOL_CATEGORY_MAP. */
const ALL_KNOWN_TOOL_IDS = Object.keys(TOOL_CATEGORY_MAP);

const PROFILE_NAMES: ToolAccessProfileName[] = [
  'social-citizen',
  'social-observer',
  'social-creative',
  'assistant',
  'unrestricted',
];

// ---------------------------------------------------------------------------
// 1. Profile presets exist and have correct shape
// ---------------------------------------------------------------------------

describe('Profile presets', () => {
  it('should contain exactly 5 profiles', () => {
    expect(Object.keys(TOOL_ACCESS_PROFILES)).toHaveLength(5);
  });

  it.each(PROFILE_NAMES)('TOOL_ACCESS_PROFILES["%s"] exists', (name) => {
    expect(TOOL_ACCESS_PROFILES[name]).toBeDefined();
  });

  it.each(PROFILE_NAMES)('"%s" has all required fields', (name) => {
    const profile: ToolAccessProfile = TOOL_ACCESS_PROFILES[name];

    // Scalar fields
    expect(typeof profile.name).toBe('string');
    expect(profile.name).toBe(name);
    expect(typeof profile.displayName).toBe('string');
    expect(profile.displayName.length).toBeGreaterThan(0);
    expect(typeof profile.description).toBe('string');
    expect(profile.description.length).toBeGreaterThan(0);

    // Array fields
    expect(Array.isArray(profile.allowedCategories)).toBe(true);
    expect(Array.isArray(profile.blockedCategories)).toBe(true);

    // Boolean flags
    expect(typeof profile.allowFileSystem).toBe('boolean');
    expect(typeof profile.allowCliExecution).toBe('boolean');
    expect(typeof profile.allowSystemModification).toBe('boolean');

    // Risk tier
    expect(typeof profile.maxRiskTier).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// 2. social-citizen blocks filesystem and system
// ---------------------------------------------------------------------------

describe('social-citizen profile', () => {
  const profile = TOOL_ACCESS_PROFILES['social-citizen'];

  it.each(['cli_executor', 'file_write', 'code_execution', 'shell_exec'])(
    'blocks system/filesystem tool "%s"',
    (toolId) => {
      expect(isToolAllowedByProfile(profile, toolId)).toBe(false);
    },
  );

  it.each(['social_post', 'feed_read', 'web_search', 'giphy_search', 'image_search', 'text_to_speech'])(
    'allows social/search/media tool "%s"',
    (toolId) => {
      expect(isToolAllowedByProfile(profile, toolId)).toBe(true);
    },
  );

  it('blocks communication tools', () => {
    expect(isToolAllowedByProfile(profile, 'email_send')).toBe(false);
    expect(isToolAllowedByProfile(profile, 'slack_send')).toBe(false);
  });

  it('has allowFileSystem = false', () => {
    expect(profile.allowFileSystem).toBe(false);
  });

  it('has allowCliExecution = false', () => {
    expect(profile.allowCliExecution).toBe(false);
  });

  it('has allowSystemModification = false', () => {
    expect(profile.allowSystemModification).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. social-observer blocks social tools
// ---------------------------------------------------------------------------

describe('social-observer profile', () => {
  const profile = TOOL_ACCESS_PROFILES['social-observer'];

  it.each(['social_post', 'feed_read'])(
    'blocks social tool "%s"',
    (toolId) => {
      expect(isToolAllowedByProfile(profile, toolId)).toBe(false);
    },
  );

  it.each(['web_search', 'news_search', 'giphy_search'])(
    'allows search/media tool "%s"',
    (toolId) => {
      expect(isToolAllowedByProfile(profile, toolId)).toBe(true);
    },
  );

  it('blocks filesystem and system tools', () => {
    expect(isToolAllowedByProfile(profile, 'file_write')).toBe(false);
    expect(isToolAllowedByProfile(profile, 'cli_executor')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. unrestricted allows everything
// ---------------------------------------------------------------------------

describe('unrestricted profile', () => {
  const profile = TOOL_ACCESS_PROFILES['unrestricted'];

  it('allows every known tool', () => {
    for (const toolId of ALL_KNOWN_TOOL_IDS) {
      expect(isToolAllowedByProfile(profile, toolId)).toBe(true);
    }
  });

  it('allows unknown / made-up tools (since unrestricted)', () => {
    expect(isToolAllowedByProfile(profile, 'totally_unknown_tool')).toBe(true);
    expect(isToolAllowedByProfile(profile, 'xyzzy_42')).toBe(true);
  });

  it('has all permission flags set to true', () => {
    expect(profile.allowFileSystem).toBe(true);
    expect(profile.allowCliExecution).toBe(true);
    expect(profile.allowSystemModification).toBe(true);
  });

  it('has no blocked categories', () => {
    expect(profile.blockedCategories).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. resolveAllowedTools filters correctly
// ---------------------------------------------------------------------------

describe('resolveAllowedTools', () => {
  it('social-citizen resolves to the correct subset of known tools', () => {
    const profile = TOOL_ACCESS_PROFILES['social-citizen'];
    const resolved = resolveAllowedTools(profile, ALL_KNOWN_TOOL_IDS);

    // Every resolved tool should be individually allowed
    for (const toolId of resolved) {
      expect(isToolAllowedByProfile(profile, toolId)).toBe(true);
    }

    // Every excluded tool should be individually blocked
    const excluded = ALL_KNOWN_TOOL_IDS.filter((id) => !resolved.includes(id));
    for (const toolId of excluded) {
      expect(isToolAllowedByProfile(profile, toolId)).toBe(false);
    }

    // Social-citizen allows social + search + media categories
    const expectedCategories = new Set<ToolCategory>(['social', 'search', 'media']);
    for (const toolId of resolved) {
      const cat = getToolCategory(toolId);
      expect(expectedCategories.has(cat!)).toBe(true);
    }
  });

  it('social-observer resolves to a smaller subset than social-citizen', () => {
    const citizen = resolveAllowedTools(
      TOOL_ACCESS_PROFILES['social-citizen'],
      ALL_KNOWN_TOOL_IDS,
    );
    const observer = resolveAllowedTools(
      TOOL_ACCESS_PROFILES['social-observer'],
      ALL_KNOWN_TOOL_IDS,
    );

    expect(observer.length).toBeLessThan(citizen.length);
  });

  it('unrestricted resolves to all known tools', () => {
    const resolved = resolveAllowedTools(
      TOOL_ACCESS_PROFILES['unrestricted'],
      ALL_KNOWN_TOOL_IDS,
    );
    expect(resolved).toEqual(ALL_KNOWN_TOOL_IDS);
  });
});

// ---------------------------------------------------------------------------
// 6. ToolAccessOverrides work
// ---------------------------------------------------------------------------

describe('ToolAccessOverrides', () => {
  const citizenProfile = TOOL_ACCESS_PROFILES['social-citizen'];

  it('additionalBlocked blocks a normally-allowed tool', () => {
    // web_search is normally allowed for social-citizen
    expect(isToolAllowedByProfile(citizenProfile, 'web_search')).toBe(true);

    // But with an override it should be blocked
    expect(
      isToolAllowedByProfile(citizenProfile, 'web_search', {
        additionalBlocked: ['web_search'],
      }),
    ).toBe(false);
  });

  it('additionalAllowed allows a normally-blocked tool', () => {
    // cli_executor is normally blocked for social-citizen
    expect(isToolAllowedByProfile(citizenProfile, 'cli_executor')).toBe(false);

    // But with an override it should be allowed
    expect(
      isToolAllowedByProfile(citizenProfile, 'cli_executor', {
        additionalAllowed: ['cli_executor'],
      }),
    ).toBe(true);
  });

  it('additionalBlocked takes precedence over additionalAllowed', () => {
    // If the same tool is in both lists, blocked wins (checked first)
    expect(
      isToolAllowedByProfile(citizenProfile, 'web_search', {
        additionalAllowed: ['web_search'],
        additionalBlocked: ['web_search'],
      }),
    ).toBe(false);
  });

  it('resolveAllowedTools respects overrides', () => {
    const withOverride = resolveAllowedTools(citizenProfile, ALL_KNOWN_TOOL_IDS, {
      additionalBlocked: ['web_search', 'giphy_search'],
    });

    expect(withOverride).not.toContain('web_search');
    expect(withOverride).not.toContain('giphy_search');
    // social_post should still be there
    expect(withOverride).toContain('social_post');
  });

  it('additionalAllowed can unlock tools for resolveAllowedTools', () => {
    const withOverride = resolveAllowedTools(citizenProfile, ALL_KNOWN_TOOL_IDS, {
      additionalAllowed: ['cli_executor'],
    });

    expect(withOverride).toContain('cli_executor');
  });
});

// ---------------------------------------------------------------------------
// 7. describePermissions returns correct can/cannot lists
// ---------------------------------------------------------------------------

describe('describePermissions', () => {
  it('social-citizen can includes "Post, comment, and vote"', () => {
    const { can, cannot } = describePermissions(TOOL_ACCESS_PROFILES['social-citizen']);

    // Can do social, search, and media
    expect(can.some((s) => s.includes('Post, comment, and vote'))).toBe(true);
    expect(can.some((s) => s.includes('Search the web'))).toBe(true);
    expect(can.some((s) => s.includes('media'))).toBe(true);

    // Cannot do system
    expect(cannot.some((s) => s.includes('Execute system commands'))).toBe(true);

    // Cannot includes filesystem constraints
    expect(cannot.some((s) => s.includes('Modify files'))).toBe(true);
    expect(cannot.some((s) => s.includes('Run shell commands'))).toBe(true);
    expect(cannot.some((s) => s.includes('Install or remove packages'))).toBe(true);
  });

  it('unrestricted can includes all major categories', () => {
    const { can, cannot } = describePermissions(TOOL_ACCESS_PROFILES['unrestricted']);

    // All 8 categories should be in "can"
    expect(can.some((s) => s.includes('Post, comment, and vote'))).toBe(true);
    expect(can.some((s) => s.includes('Search the web'))).toBe(true);
    expect(can.some((s) => s.includes('media'))).toBe(true);
    expect(can.some((s) => s.includes('memory'))).toBe(true);
    expect(can.some((s) => s.includes('file system'))).toBe(true);
    expect(can.some((s) => s.includes('Execute system commands'))).toBe(true);
    expect(can.some((s) => s.includes('productivity'))).toBe(true);
    expect(can.some((s) => s.includes('external channels'))).toBe(true);

    // "cannot" should be minimal (no blocked categories, all flags true)
    // The cannot array should be empty since all flags are true and all categories allowed
    expect(cannot).toHaveLength(0);
  });

  it('social-observer cannot includes social tools', () => {
    const { can, cannot } = describePermissions(TOOL_ACCESS_PROFILES['social-observer']);

    expect(cannot.some((s) => s.includes('Post, comment, or vote'))).toBe(true);
  });

  it('returns arrays (not undefined)', () => {
    for (const name of PROFILE_NAMES) {
      const result = describePermissions(TOOL_ACCESS_PROFILES[name]);
      expect(Array.isArray(result.can)).toBe(true);
      expect(Array.isArray(result.cannot)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Type guards
// ---------------------------------------------------------------------------

describe('Type guards and getToolAccessProfile', () => {
  it('isValidToolAccessProfile returns true for all valid names', () => {
    for (const name of PROFILE_NAMES) {
      expect(isValidToolAccessProfile(name)).toBe(true);
    }
  });

  it('isValidToolAccessProfile returns false for invalid names', () => {
    expect(isValidToolAccessProfile('invalid-name')).toBe(false);
    expect(isValidToolAccessProfile('')).toBe(false);
    expect(isValidToolAccessProfile('SOCIAL-CITIZEN')).toBe(false);
    expect(isValidToolAccessProfile('social_citizen')).toBe(false);
  });

  it('getToolAccessProfile returns the correct profile for valid names', () => {
    for (const name of PROFILE_NAMES) {
      const profile = getToolAccessProfile(name);
      expect(profile.name).toBe(name);
      expect(profile).toBe(TOOL_ACCESS_PROFILES[name]);
    }
  });

  it('getToolAccessProfile throws for invalid names', () => {
    expect(() => getToolAccessProfile('invalid-name' as ToolAccessProfileName)).toThrow(
      /Unknown tool access profile/,
    );
  });
});

// ---------------------------------------------------------------------------
// 9. getToolCategory
// ---------------------------------------------------------------------------

describe('getToolCategory', () => {
  it('returns correct category for known tools', () => {
    expect(getToolCategory('social_post')).toBe('social');
    expect(getToolCategory('feed_read')).toBe('social');
    expect(getToolCategory('web_search')).toBe('search');
    expect(getToolCategory('news_search')).toBe('search');
    expect(getToolCategory('browser_navigate')).toBe('search');
    expect(getToolCategory('giphy_search')).toBe('media');
    expect(getToolCategory('image_search')).toBe('media');
    expect(getToolCategory('text_to_speech')).toBe('media');
    expect(getToolCategory('memory_read')).toBe('memory');
    expect(getToolCategory('memory_write')).toBe('memory');
    expect(getToolCategory('file_write')).toBe('filesystem');
    expect(getToolCategory('file_read')).toBe('filesystem');
    expect(getToolCategory('cli_executor')).toBe('system');
    expect(getToolCategory('code_execution')).toBe('system');
    expect(getToolCategory('shell_exec')).toBe('system');
    expect(getToolCategory('calendar')).toBe('productivity');
    expect(getToolCategory('email_send')).toBe('communication');
    expect(getToolCategory('slack_send')).toBe('communication');
    expect(getToolCategory('telegram_send')).toBe('communication');
  });

  it('returns undefined for unknown tools', () => {
    expect(getToolCategory('totally_unknown_tool')).toBeUndefined();
    expect(getToolCategory('')).toBeUndefined();
    expect(getToolCategory('nonexistent_xyz')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('unknown tools are blocked by non-unrestricted profiles', () => {
    const citizen = TOOL_ACCESS_PROFILES['social-citizen'];
    const observer = TOOL_ACCESS_PROFILES['social-observer'];
    const assistant = TOOL_ACCESS_PROFILES['assistant'];

    expect(isToolAllowedByProfile(citizen, 'unknown_tool_abc')).toBe(false);
    expect(isToolAllowedByProfile(observer, 'unknown_tool_abc')).toBe(false);
    expect(isToolAllowedByProfile(assistant, 'unknown_tool_abc')).toBe(false);
  });

  it('profiles are frozen (immutable)', () => {
    const citizen = TOOL_ACCESS_PROFILES['social-citizen'];

    // Attempting to mutate should throw in strict mode or silently fail
    expect(() => {
      (citizen as any).displayName = 'Hacked';
    }).toThrow();

    // Value should remain unchanged
    expect(citizen.displayName).toBe('Social Citizen');
  });

  it('TOOL_ACCESS_PROFILES registry is frozen', () => {
    expect(() => {
      (TOOL_ACCESS_PROFILES as any)['new-profile'] = {};
    }).toThrow();
  });
});
