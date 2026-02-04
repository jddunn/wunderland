/**
 * @fileoverview Skills module exports for Wunderland
 * @module @framers/wunderland/skills
 *
 * The Skills system allows agents to be extended with modular capabilities.
 * Skills are defined in SKILL.md files with YAML frontmatter specifying
 * metadata, requirements, and installation instructions.
 *
 * @example
 * ```typescript
 * import {
 *   SkillRegistry,
 *   loadSkillsFromDir,
 *   parseSkillFrontmatter,
 * } from '@framers/wunderland/skills';
 *
 * // Create registry
 * const registry = new SkillRegistry();
 *
 * // Load skills from directories
 * await registry.loadFromDirs([
 *   '/path/to/workspace/skills',
 *   '/path/to/bundled/skills',
 * ]);
 *
 * // Build snapshot for agent context
 * const snapshot = registry.buildSnapshot({
 *   platform: process.platform,
 *   eligibility: {
 *     platforms: [process.platform],
 *     hasBin: (bin) => commandExistsSync(bin),
 *     hasAnyBin: (bins) => bins.some(commandExistsSync),
 *   },
 * });
 *
 * console.log(`Loaded ${registry.size} skills`);
 * console.log(snapshot.prompt);
 * ```
 */

// Types
export type {
    Skill,
    SkillEntry,
    SkillMetadata,
    SkillInstallSpec,
    SkillInstallKind,
    SkillSnapshot,
    SkillCommandSpec,
    SkillCommandDispatch,
    SkillInvocationPolicy,
    SkillEligibilityContext,
    SkillRequirements,
    ParsedSkillFrontmatter,
    SkillsConfig,
    SkillConfig,
    SkillsLoadConfig,
    SkillsInstallPreferences,
} from './types.js';

// Constants
export {
    SKILL_COMMAND_MAX_LENGTH,
    SKILL_COMMAND_FALLBACK,
    SKILL_COMMAND_DESCRIPTION_MAX_LENGTH,
    DEFAULT_SNAPSHOT_VERSION,
} from './types.js';

// Loader functions
export {
    parseSkillFrontmatter,
    extractMetadata,
    loadSkillFromDir,
    loadSkillsFromDir,
    filterByPlatform,
    filterByEligibility,
    checkBinaryRequirements,
} from './SkillLoader.js';

// Registry
export { SkillRegistry } from './SkillRegistry.js';
export type { SkillRegistryOptions } from './SkillRegistry.js';
