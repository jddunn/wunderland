// @ts-nocheck
/**
 * @fileoverview Extension category mapping for smart, preset-aware loading.
 *
 * Extensions are grouped into load categories. Agent presets declare which
 * categories they want, and the loader expands categories to extension IDs
 * at startup.
 *
 * @module wunderland/cli/extensions/categories
 */

/** Load categories that control which agent presets auto-include an extension. */
export type ExtensionLoadCategory = 'core' | 'research' | 'entertainment' | 'business' | 'media';

/**
 * Maps each load category to the extension IDs it contains.
 *
 * - **core** — essential tools every agent needs (shell, search, browser, skills, etc.)
 * - **research** — deep-dive investigation tools (scraper, deep-research, news, etc.)
 * - **entertainment** — fun / media-lookup extensions (movie databases, letterboxd)
 * - **business** — CRM and enrichment integrations (clearbit, etc.)
 * - **media** — image, video, audio generation and search tools
 */
export const CATEGORY_EXTENSIONS: Record<ExtensionLoadCategory, string[]> = {
  core: [
    'cli-executor', 'web-search', 'web-browser', 'skills', 'github', 'weather', 'document-export', 'widget-generator',
  ],
  research: [
    'web-scraper', 'deep-research', 'content-extraction', 'news-search',
    'browser-automation',
  ],
  entertainment: [
    'omdb', 'letterboxd',
  ],
  business: [
    'clearbit',
  ],
  media: [
    'giphy', 'image-search', 'image-generation', 'voice-synthesis',
    'video-generation', 'audio-generation', 'vision-pipeline',
  ],
};

/**
 * Default category assignments for each built-in preset.
 *
 * When a preset name is not found in this table, the fallback
 * is `['core', 'media']` (see {@link getPresetCategories}).
 */
export const PRESET_CATEGORIES: Record<string, ExtensionLoadCategory[]> = {
  'default':            ['core', 'media'],
  'research-assistant': ['core', 'media', 'research', 'entertainment', 'business'],
  'creative-writer':    ['core', 'media', 'research', 'entertainment'],
  'personal-assistant': ['core', 'media', 'research', 'entertainment', 'business'],
  'customer-support':   ['core', 'media', 'business'],
  'data-analyst':       ['core', 'research'],
  'devops-assistant':   ['core'],
  'code-reviewer':      ['core'],
  'security-auditor':   ['core', 'research'],
  'ai-receptionist':    ['core', 'media', 'business'],
};

/**
 * Expand an array of load categories to a deduplicated list of extension IDs.
 *
 * Categories that don't appear in {@link CATEGORY_EXTENSIONS} are silently
 * skipped, so callers can safely pass user-provided strings.
 *
 * @param categories - One or more load category names to expand.
 * @returns A flat, deduplicated array of extension IDs.
 */
export function expandCategories(categories: ExtensionLoadCategory[]): string[] {
  const ids = new Set<string>();
  for (const cat of categories) {
    const exts = CATEGORY_EXTENSIONS[cat];
    if (exts) for (const id of exts) ids.add(id);
  }
  return [...ids];
}

/**
 * Get the default load categories for a preset by name.
 *
 * Returns `['core', 'media']` if the preset is not in the lookup table,
 * ensuring every agent gets at minimum the core tool set and media tools.
 *
 * @param presetName - The preset identifier (e.g. `'research-assistant'`).
 * @returns The array of {@link ExtensionLoadCategory} values for the preset.
 */
export function getPresetCategories(presetName: string): ExtensionLoadCategory[] {
  return PRESET_CATEGORIES[presetName] ?? ['core', 'media'];
}
