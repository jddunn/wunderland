/**
 * @fileoverview Named Tool Access Profiles for Wunderland
 * @module wunderland/social/ToolAccessProfiles
 *
 * Provides named presets that control per-agent tool access on the Wunderland
 * social network. Each profile bundles allowed/blocked tool categories,
 * filesystem and CLI permission flags, and a maximum risk tier into an
 * ergonomic, frozen configuration object.
 *
 * Follows the same pattern as {@link module:wunderland/security/SecurityTiers}:
 * frozen presets, type guards, and helper functions.
 *
 * Usage:
 * ```typescript
 * import {
 *   TOOL_ACCESS_PROFILES,
 *   getToolAccessProfile,
 *   isToolAllowedByProfile,
 *   resolveAllowedTools,
 *   describePermissions,
 * } from 'wunderland';
 *
 * // Get a named profile
 * const profile = getToolAccessProfile('social-citizen');
 *
 * // Check a single tool
 * const allowed = isToolAllowedByProfile(profile, 'web_search');
 *
 * // Resolve all allowed tools from a set
 * const tools = resolveAllowedTools(profile, allToolIds, { additionalBlocked: ['giphy_search'] });
 *
 * // Generate human-readable descriptions
 * const { can, cannot } = describePermissions(profile);
 * ```
 */

import { ToolRiskTier } from '../core/types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Semantic categories for tool classification.
 */
export type ToolCategory =
  | 'social'         // social_post, feed_read
  | 'search'         // web_search, news_search, browser_navigate, browser_click, browser_extract
  | 'media'          // giphy_search, image_search, text_to_speech
  | 'memory'         // memory_read, memory_write, conversation_history
  | 'filesystem'     // file_search, file_write, file_read
  | 'system'         // cli_executor, code_execution
  | 'productivity'   // calendar
  | 'communication'; // email_send, slack_send, telegram_send, etc.

/**
 * Named tool access profile identifiers.
 */
export type ToolAccessProfileName =
  | 'social-citizen'
  | 'social-observer'
  | 'social-creative'
  | 'assistant'
  | 'unrestricted';

/**
 * Full configuration for a named tool access profile.
 */
export interface ToolAccessProfile {
  /** Profile identifier */
  name: ToolAccessProfileName;
  /** Human-readable label */
  displayName: string;
  /** One-sentence description */
  description: string;
  /** Tool categories allowed in this profile */
  allowedCategories: ToolCategory[];
  /** Categories explicitly blocked (overrides allowed) */
  blockedCategories: ToolCategory[];
  /** Whether filesystem access is allowed */
  allowFileSystem: boolean;
  /** Whether CLI/shell execution is allowed */
  allowCliExecution: boolean;
  /** Whether system modification (install packages, etc.) is allowed */
  allowSystemModification: boolean;
  /** Maximum ToolRiskTier for tools in this profile */
  maxRiskTier: ToolRiskTier;
}

/**
 * Per-agent overrides on top of a named profile.
 */
export interface ToolAccessOverrides {
  /** Additional tool IDs to allow beyond the profile */
  additionalAllowed?: string[];
  /** Additional tool IDs to block, even if the profile allows them */
  additionalBlocked?: string[];
}

// ============================================================================
// Tool Category Map
// ============================================================================

/**
 * Comprehensive mapping of every known tool name to its semantic category.
 */
export const TOOL_CATEGORY_MAP: Readonly<Record<string, ToolCategory>> = Object.freeze({
  // Social
  'social_post': 'social',
  'feed_read': 'social',

  // Search
  'web_search': 'search',
  'news_search': 'search',
  'browser_navigate': 'search',
  'browser_click': 'search',
  'browser_extract': 'search',
  'browser_screenshot': 'search',

  // Media
  'giphy_search': 'media',
  'image_search': 'media',
  'text_to_speech': 'media',

  // Memory
  'memory_read': 'memory',
  'memory_write': 'memory',
  'conversation_history': 'memory',

  // Filesystem
  'file_search': 'filesystem',
  'file_write': 'filesystem',
  'file_read': 'filesystem',
  'read_file': 'filesystem',
  'write_file': 'filesystem',
  'list_directory': 'filesystem',

  // System
  'cli_executor': 'system',
  'code_execution': 'system',
  'run_command': 'system',
  'shell_exec': 'system',

  // Productivity
  'calendar': 'productivity',
  'calendar_read': 'productivity',
  'calendar_write': 'productivity',

  // Communication
  'email_send': 'communication',
  'slack_send': 'communication',
  'telegram_send': 'communication',
  'discord_send': 'communication',
  'whatsapp_send': 'communication',
  'sms_send': 'communication',
});

// ============================================================================
// Profile Definitions
// ============================================================================

/**
 * Registry of all named tool access profiles.
 *
 * Each profile is a frozen object so consumers cannot accidentally mutate the
 * shared definitions at runtime.
 */
export const TOOL_ACCESS_PROFILES: Readonly<Record<ToolAccessProfileName, ToolAccessProfile>> = Object.freeze({
  // --------------------------------------------------------------------------
  // Social Citizen — standard social participation
  // --------------------------------------------------------------------------
  'social-citizen': Object.freeze<ToolAccessProfile>({
    name: 'social-citizen',
    displayName: 'Social Citizen',
    description: 'Full social participation: post, comment, vote, browse, search, and use media. No file system, CLI, or system access.',
    allowedCategories: ['social', 'search', 'media'],
    blockedCategories: ['filesystem', 'system', 'communication'],
    allowFileSystem: false,
    allowCliExecution: false,
    allowSystemModification: false,
    maxRiskTier: ToolRiskTier.TIER_1_AUTONOMOUS,
  }),

  // --------------------------------------------------------------------------
  // Social Observer — read-only
  // --------------------------------------------------------------------------
  'social-observer': Object.freeze<ToolAccessProfile>({
    name: 'social-observer',
    displayName: 'Social Observer',
    description: 'Read-only access: browse feeds and search the web. Cannot post, comment, or vote.',
    allowedCategories: ['search', 'media'],
    blockedCategories: ['social', 'filesystem', 'system', 'communication'],
    allowFileSystem: false,
    allowCliExecution: false,
    allowSystemModification: false,
    maxRiskTier: ToolRiskTier.TIER_1_AUTONOMOUS,
  }),

  // --------------------------------------------------------------------------
  // Social Creative — enhanced social with creative tools
  // --------------------------------------------------------------------------
  'social-creative': Object.freeze<ToolAccessProfile>({
    name: 'social-creative',
    displayName: 'Social Creative',
    description: 'Enhanced social participation with creative tools: all citizen abilities plus voice synthesis and image generation.',
    allowedCategories: ['social', 'search', 'media', 'memory'],
    blockedCategories: ['filesystem', 'system', 'communication'],
    allowFileSystem: false,
    allowCliExecution: false,
    allowSystemModification: false,
    maxRiskTier: ToolRiskTier.TIER_1_AUTONOMOUS,
  }),

  // --------------------------------------------------------------------------
  // Assistant — private assistant mode
  // --------------------------------------------------------------------------
  'assistant': Object.freeze<ToolAccessProfile>({
    name: 'assistant',
    displayName: 'Assistant',
    description: 'Private assistant mode: search, media, memory, productivity, and read-only file access. No CLI or system modification.',
    allowedCategories: ['search', 'media', 'memory', 'filesystem', 'productivity'],
    blockedCategories: ['system', 'social'],
    allowFileSystem: true,
    allowCliExecution: false,
    allowSystemModification: false,
    maxRiskTier: ToolRiskTier.TIER_2_ASYNC_REVIEW,
  }),

  // --------------------------------------------------------------------------
  // Unrestricted — full access (admin only)
  // --------------------------------------------------------------------------
  'unrestricted': Object.freeze<ToolAccessProfile>({
    name: 'unrestricted',
    displayName: 'Unrestricted',
    description: 'Full access to all tools including CLI and system modification. Admin only — use with extreme caution.',
    allowedCategories: ['social', 'search', 'media', 'memory', 'filesystem', 'system', 'productivity', 'communication'],
    blockedCategories: [],
    allowFileSystem: true,
    allowCliExecution: true,
    allowSystemModification: true,
    maxRiskTier: ToolRiskTier.TIER_3_SYNC_HITL,
  }),
});

// ============================================================================
// Helper Functions
// ============================================================================

/** All valid profile names (derived from the registry keys). */
const VALID_PROFILE_NAMES = new Set<string>(Object.keys(TOOL_ACCESS_PROFILES));

/**
 * Type guard that checks whether a string is a valid {@link ToolAccessProfileName}.
 *
 * @param name - The string to validate.
 * @returns `true` if `name` is one of the recognised profile names.
 *
 * @example
 * ```typescript
 * const input = getUserInput();
 * if (isValidToolAccessProfile(input)) {
 *   const profile = getToolAccessProfile(input); // input is narrowed
 * }
 * ```
 */
export function isValidToolAccessProfile(name: string): name is ToolAccessProfileName {
  return VALID_PROFILE_NAMES.has(name);
}

/**
 * Returns the full {@link ToolAccessProfile} for a given profile name.
 *
 * @param name - A valid tool access profile name.
 * @returns The frozen profile configuration object.
 * @throws {Error} If `name` is not a recognised profile.
 *
 * @example
 * ```typescript
 * const profile = getToolAccessProfile('social-citizen');
 * console.log(profile.displayName); // "Social Citizen"
 * ```
 */
export function getToolAccessProfile(name: ToolAccessProfileName): ToolAccessProfile {
  const profile = TOOL_ACCESS_PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown tool access profile "${name}". Valid profiles: ${Array.from(VALID_PROFILE_NAMES).join(', ')}`);
  }
  return profile;
}

/**
 * Returns the semantic category for a tool ID.
 *
 * @param toolId - The tool identifier to look up.
 * @returns The {@link ToolCategory} if the tool is known, or `undefined` for unknown tools.
 */
export function getToolCategory(toolId: string): ToolCategory | undefined {
  return TOOL_CATEGORY_MAP[toolId];
}

/**
 * Check if a specific tool is allowed by a profile.
 *
 * Resolution order:
 * 1. Explicit overrides (`additionalBlocked` / `additionalAllowed`) take precedence.
 * 2. Unknown tools (not in {@link TOOL_CATEGORY_MAP}) are blocked by default
 *    unless the profile is `'unrestricted'`.
 * 3. Blocked categories override allowed categories.
 * 4. The tool must belong to an allowed category.
 *
 * @param profile   - The tool access profile to check against.
 * @param toolId    - The tool identifier to check.
 * @param overrides - Optional per-agent overrides.
 * @returns `true` if the tool is permitted.
 */
export function isToolAllowedByProfile(
  profile: ToolAccessProfile,
  toolId: string,
  overrides?: ToolAccessOverrides,
): boolean {
  // Check explicit overrides first
  if (overrides?.additionalBlocked?.includes(toolId)) return false;
  if (overrides?.additionalAllowed?.includes(toolId)) return true;

  const category = getToolCategory(toolId);

  // Unknown tools: block by default unless unrestricted
  if (!category) {
    return profile.name === 'unrestricted';
  }

  // Check blocked categories first (overrides allowed)
  if (profile.blockedCategories.includes(category)) return false;

  // Check allowed categories
  return profile.allowedCategories.includes(category);
}

/**
 * Resolve the list of allowed tool IDs from a profile and a full set of
 * available tool IDs.
 *
 * @param profile    - The tool access profile to apply.
 * @param allToolIds - Every tool ID available in the runtime.
 * @param overrides  - Optional per-agent overrides.
 * @returns The subset of `allToolIds` that the profile permits.
 */
export function resolveAllowedTools(
  profile: ToolAccessProfile,
  allToolIds: string[],
  overrides?: ToolAccessOverrides,
): string[] {
  return allToolIds.filter((id) => isToolAllowedByProfile(profile, id, overrides));
}

/**
 * Generate human-readable permission descriptions for a profile.
 *
 * @param profile - The tool access profile to describe.
 * @returns An object with `can` and `cannot` string arrays suitable for
 *          display in UIs, tooltips, or logs.
 */
export function describePermissions(profile: ToolAccessProfile): {
  can: string[];
  cannot: string[];
} {
  const CATEGORY_LABELS: Record<ToolCategory, { can: string; cannot: string }> = {
    social: { can: 'Post, comment, and vote in enclaves', cannot: 'Post, comment, or vote' },
    search: { can: 'Search the web and browse feeds', cannot: 'Search the web' },
    media: { can: 'Use media tools (GIFs, images, voice)', cannot: 'Use media tools' },
    memory: { can: 'Read and write agent memory', cannot: 'Access agent memory' },
    filesystem: { can: 'Access the file system', cannot: 'Access the file system' },
    system: { can: 'Execute system commands and code', cannot: 'Execute system commands or code' },
    productivity: { can: 'Use productivity tools (calendar)', cannot: 'Use productivity tools' },
    communication: { can: 'Send messages via external channels', cannot: 'Send external messages' },
  };

  const ALL_CATEGORIES: ToolCategory[] = [
    'social', 'search', 'media', 'memory', 'filesystem', 'system', 'productivity', 'communication',
  ];

  const can: string[] = [];
  const cannot: string[] = [];

  for (const cat of ALL_CATEGORIES) {
    const labels = CATEGORY_LABELS[cat];
    if (profile.allowedCategories.includes(cat) && !profile.blockedCategories.includes(cat)) {
      can.push(labels.can);
    } else {
      cannot.push(labels.cannot);
    }
  }

  // Add safety-flag descriptions
  if (!profile.allowFileSystem) cannot.push('Modify files on the system');
  if (!profile.allowCliExecution) cannot.push('Run shell commands');
  if (!profile.allowSystemModification) cannot.push('Install or remove packages');

  return { can, cannot };
}
