// @ts-nocheck
/**
 * @fileoverview Maps security tiers to tool allowlists.
 *
 * Each tier defines which tools are available to users interacting via
 * messaging channels. `permissive` allows all tools (returns null).
 *
 * @module wunderland/chat/ToolAllowlistResolver
 */

import type { SecurityTier } from './types.js';

/** Tools available in strict mode — search and lookup only. */
const STRICT_TOOLS = [
  'web_search', 'news_search', 'fact_check', 'image_search', 'giphy_search',
];

/** Tools available in balanced mode — adds file operations. */
const BALANCED_TOOLS = [
  ...STRICT_TOOLS,
  'local_file_search', 'zip_files', 'send_file_to_channel', 'media_upload',
];

/**
 * Resolve the tool allowlist for a given security tier.
 *
 * @param tier - The security tier to resolve.
 * @returns Array of allowed tool IDs, or null if all tools are allowed (permissive).
 */
export function resolveToolAllowlist(tier: SecurityTier): string[] | null {
  switch (tier) {
    case 'strict': return [...STRICT_TOOLS];
    case 'balanced': return [...BALANCED_TOOLS];
    case 'permissive': return null; // all tools allowed
  }
}
