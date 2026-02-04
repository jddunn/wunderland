/**
 * @fileoverview Skill Loader for Wunderland
 * @module @framers/wunderland/skills/SkillLoader
 *
 * Loads skills from directories by parsing SKILL.md files with YAML frontmatter.
 * Skills are modular capabilities that extend agent functionality.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
    Skill,
    SkillEntry,
    SkillMetadata,
    SkillEligibilityContext,
    ParsedSkillFrontmatter,
    SkillInvocationPolicy,
} from './types.js';

const fsp = fs.promises;

// ============================================================================
// FRONTMATTER PARSING
// ============================================================================

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Supports the standard `---` delimited format.
 *
 * @param content - Raw SKILL.md file content
 * @returns Parsed frontmatter object and remaining content
 */
export function parseSkillFrontmatter(content: string): {
    frontmatter: ParsedSkillFrontmatter;
    body: string;
} {
    const lines = content.split('\n');

    // Check for frontmatter start
    if (lines[0]?.trim() !== '---') {
        return { frontmatter: {}, body: content };
    }

    // Find frontmatter end
    let endIndex = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === '---') {
            endIndex = i;
            break;
        }
    }

    if (endIndex === -1) {
        return { frontmatter: {}, body: content };
    }

    const frontmatterLines = lines.slice(1, endIndex);
    const body = lines.slice(endIndex + 1).join('\n').trim();

    // Simple YAML parsing (handles basic key: value and nested objects)
    const frontmatter = parseSimpleYaml(frontmatterLines.join('\n'));

    return { frontmatter, body };
}

/**
 * Simple YAML parser for skill frontmatter.
 * Handles basic key-value pairs and nested JSON-like objects.
 *
 * Note: For production, consider using a proper YAML library like `yaml` or `js-yaml`.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = yaml.split('\n');
    let currentKey = '';
    let currentValue = '';
    let inMultiline = false;
    let braceDepth = 0;

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        // Handle JSON-like object continuation
        if (inMultiline) {
            currentValue += line + '\n';
            braceDepth += (line.match(/{/g) || []).length;
            braceDepth -= (line.match(/}/g) || []).length;

            if (braceDepth <= 0) {
                try {
                    // Try to parse as JSON
                    result[currentKey] = JSON.parse(currentValue.trim());
                } catch {
                    result[currentKey] = currentValue.trim();
                }
                inMultiline = false;
                currentValue = '';
            }
            continue;
        }

        // Parse key: value
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
            const key = line.slice(0, colonIndex).trim();
            const value = line.slice(colonIndex + 1).trim();

            if (value === '' || value === '{') {
                // Start of multiline/object
                currentKey = key;
                currentValue = value + '\n';
                braceDepth = (value.match(/{/g) || []).length;
                braceDepth -= (value.match(/}/g) || []).length;
                inMultiline = braceDepth > 0;

                if (!inMultiline && value === '') {
                    result[key] = {};
                }
            } else if (value.startsWith('{') && value.endsWith('}')) {
                // Inline JSON object
                try {
                    result[key] = JSON.parse(value);
                } catch {
                    result[key] = value;
                }
            } else if (value.startsWith('"') && value.endsWith('"')) {
                // Quoted string
                result[key] = value.slice(1, -1);
            } else if (value === 'true') {
                result[key] = true;
            } else if (value === 'false') {
                result[key] = false;
            } else if (!isNaN(Number(value))) {
                result[key] = Number(value);
            } else {
                result[key] = value;
            }
        }
    }

    return result;
}

/**
 * Extract SkillMetadata from parsed frontmatter.
 */
export function extractMetadata(frontmatter: ParsedSkillFrontmatter): SkillMetadata | undefined {
    // Look for metadata in common locations
    const meta =
        (frontmatter.metadata as Record<string, unknown>)?.openclaw ||
        (frontmatter.metadata as Record<string, unknown>)?.wunderland ||
        frontmatter.metadata ||
        frontmatter;

    if (!meta || typeof meta !== 'object') {
        return undefined;
    }

    const m = meta as Record<string, unknown>;

    return {
        always: m.always === true,
        skillKey: typeof m.skillKey === 'string' ? m.skillKey : undefined,
        primaryEnv: typeof m.primaryEnv === 'string' ? m.primaryEnv : undefined,
        emoji: typeof m.emoji === 'string' ? m.emoji : undefined,
        homepage: typeof m.homepage === 'string' ? m.homepage : undefined,
        os: Array.isArray(m.os) ? m.os : undefined,
        requires: m.requires as SkillMetadata['requires'],
        install: Array.isArray(m.install) ? m.install : undefined,
    };
}

/**
 * Extract skill description from body content.
 */
function extractDescription(body: string): string {
    // Skip markdown title and get first paragraph
    const lines = body.split('\n');
    let inParagraph = false;
    const paragraphLines: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip headings
        if (trimmed.startsWith('#')) {
            if (inParagraph) break;
            continue;
        }

        // Skip empty lines before paragraph
        if (!trimmed && !inParagraph) {
            continue;
        }

        // Empty line ends paragraph
        if (!trimmed && inParagraph) {
            break;
        }

        inParagraph = true;
        paragraphLines.push(trimmed);
    }

    return paragraphLines.join(' ').slice(0, 200);
}

// ============================================================================
// SKILL LOADING
// ============================================================================

/**
 * Load a single skill from a directory.
 *
 * @param skillDir - Path to skill directory (should contain SKILL.md)
 * @returns SkillEntry or null if invalid
 */
export async function loadSkillFromDir(skillDir: string): Promise<SkillEntry | null> {
    const skillPath = path.join(skillDir, 'SKILL.md');

    try {
        const stat = await fsp.stat(skillPath);
        if (!stat.isFile()) {
            return null;
        }

        const content = await fsp.readFile(skillPath, 'utf-8');
        const { frontmatter, body } = parseSkillFrontmatter(content);

        const name = frontmatter.name as string || path.basename(skillDir);
        const description =
            (frontmatter.description as string) ||
            extractDescription(body);

        const skill: Skill = {
            name,
            description,
            content: body,
        };

        const metadata = extractMetadata(frontmatter);

        // Default invocation policy
        const invocation: SkillInvocationPolicy = {
            userInvocable: true,
            disableModelInvocation: false,
        };

        return {
            skill,
            frontmatter,
            metadata,
            invocation,
            sourcePath: skillDir,
        };
    } catch (err) {
        // Skill doesn't exist or is invalid
        return null;
    }
}

/**
 * Load all skills from a directory.
 *
 * @param dir - Parent directory containing skill subdirectories
 * @returns Array of SkillEntry objects
 */
export async function loadSkillsFromDir(dir: string): Promise<SkillEntry[]> {
    const entries: SkillEntry[] = [];

    try {
        const items = await fsp.readdir(dir, { withFileTypes: true });

        for (const item of items) {
            if (!item.isDirectory()) continue;
            if (item.name.startsWith('.')) continue;

            const skillDir = path.join(dir, item.name);
            const entry = await loadSkillFromDir(skillDir);

            if (entry) {
                entries.push(entry);
            }
        }
    } catch (err) {
        // Directory doesn't exist or is inaccessible
        console.warn(`[SkillLoader] Failed to load skills from ${dir}:`, err);
    }

    return entries;
}

// ============================================================================
// FILTERING
// ============================================================================

/**
 * Filter skill entries by platform.
 *
 * @param entries - Skill entries to filter
 * @param platform - Current platform (e.g., 'darwin', 'linux', 'win32')
 */
export function filterByPlatform(entries: SkillEntry[], platform: string): SkillEntry[] {
    return entries.filter((entry) => {
        const os = entry.metadata?.os;
        if (!os || os.length === 0) return true;

        // Normalize platform names
        const normalizedPlatform = normalizeOSName(platform);
        return os.some((p) => normalizeOSName(p) === normalizedPlatform);
    });
}

/**
 * Normalize OS name for comparison.
 */
function normalizeOSName(name: string): string {
    const lower = name.toLowerCase();
    if (lower === 'darwin' || lower === 'macos' || lower === 'mac') return 'darwin';
    if (lower === 'win32' || lower === 'windows') return 'win32';
    if (lower === 'linux') return 'linux';
    return lower;
}

/**
 * Filter skill entries by eligibility context.
 *
 * @param entries - Skill entries to filter
 * @param context - Eligibility context with binary/env checks
 */
export function filterByEligibility(
    entries: SkillEntry[],
    context: SkillEligibilityContext
): SkillEntry[] {
    return entries.filter((entry) => {
        const requires = entry.metadata?.requires;
        if (!requires) return true;

        // Check required binaries
        if (requires.bins && requires.bins.length > 0) {
            const allBins = requires.bins.every((bin) => context.hasBin(bin));
            if (!allBins) return false;
        }

        // Check any-of binaries
        if (requires.anyBins && requires.anyBins.length > 0) {
            const anyBin = context.hasAnyBin(requires.anyBins);
            if (!anyBin) return false;
        }

        // Check environment variables
        if (requires.env && requires.env.length > 0 && context.hasEnv) {
            const allEnv = requires.env.every((env) => context.hasEnv!(env));
            if (!allEnv) return false;
        }

        // Platform check
        for (const platform of context.platforms) {
            const entries = filterByPlatform([entry], platform);
            if (entries.length === 0) return false;
        }

        return true;
    });
}

/**
 * Check if all binary requirements for a skill are met.
 */
export function checkBinaryRequirements(
    entry: SkillEntry,
    hasBin: (bin: string) => boolean
): { met: boolean; missing: string[] } {
    const requires = entry.metadata?.requires;
    const missing: string[] = [];

    if (requires?.bins) {
        for (const bin of requires.bins) {
            if (!hasBin(bin)) {
                missing.push(bin);
            }
        }
    }

    return {
        met: missing.length === 0,
        missing,
    };
}
