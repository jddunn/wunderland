/**
 * @fileoverview Folder-level permissions with glob pattern support
 * @module wunderland/security/FolderPermissions
 *
 * Provides fine-grained folder access control for agents:
 * - Per-folder read/write permissions
 * - Glob pattern matching (**, *, !, ~)
 * - Default policy (allow/deny)
 * - Security tier inheritance
 */

import { minimatch } from 'minimatch';
import * as path from 'node:path';
import * as os from 'node:os';
import type { GranularPermissions } from './SecurityTiers.js';

/**
 * Folder access rule with glob pattern support
 *
 * @example
 * { pattern: "~/workspace/**", read: true, write: true, description: "Agent workspace" }
 * { pattern: "/var/log/**", read: true, write: false, description: "Read-only logs" }
 * { pattern: "!/sensitive/*", read: false, write: false, description: "Block sensitive" }
 */
export interface FolderAccessRule {
  /** Glob pattern: /home/user/**, ~/workspace/*, !/sensitive/* */
  pattern: string;

  /** Read permission */
  read: boolean;

  /** Write permission (create, modify, delete) */
  write: boolean;

  /** Optional description for audit logs */
  description?: string;
}

/**
 * Complete folder permission configuration
 */
export interface FolderPermissionConfig {
  /** Default policy when path not matched */
  defaultPolicy: 'allow' | 'deny';

  /** Ordered list of rules (first match wins) */
  rules: FolderAccessRule[];

  /** Inherit security tier's filesystem permissions as fallback */
  inheritFromTier: boolean;
}

/**
 * Result of folder permission check
 */
export interface FolderPermissionResult {
  allowed: boolean;
  read: boolean;
  write: boolean;
  matchedRule?: FolderAccessRule;
  reason?: string; // For denials: "Path /etc/passwd not in allowed folders"
}

/**
 * Validation result for folder permission config
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

/**
 * Expand tilde (~) to home directory
 *
 * @param filepath - Path potentially starting with ~
 * @returns Expanded absolute path
 *
 * @example
 * expandTilde("~/workspace") → "/home/user/workspace"
 * expandTilde("/tmp/file") → "/tmp/file"
 */
export function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return path.join(os.homedir(), filepath.slice(2));
  }
  return filepath;
}

/**
 * Check if path matches glob pattern
 *
 * Supports:
 * - ** (recursive match)
 * - * (single level match)
 * - ! (deny marker; matches the underlying pattern)
 * - ~ (home directory)
 *
 * @param filePath - Absolute file path to check
 * @param pattern - Glob pattern (may include leading "!" to visually indicate a deny rule)
 * @returns True if path matches pattern
 *
 * @example
 * matchesGlob("/home/user/workspace/file.txt", "/home/user/**") → true
 * matchesGlob("/home/user/file.txt", "~/workspace/*") → false
 * matchesGlob("/sensitive/data.txt", "!/sensitive/*") → true (deny marker matches underlying pattern)
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  // 1. Strip deny marker prefix (!/sensitive/* -> /sensitive/*)
  const cleanPattern = pattern.startsWith('!') ? pattern.slice(1) : pattern;

  // 2. Expand tilde to home directory
  const expandedPath = path.resolve(expandTilde(filePath));
  const expandedPattern = expandTilde(cleanPattern);

  // 3. Match using minimatch
  const matches = minimatch(expandedPath, expandedPattern, {
    dot: true, // Match dotfiles
    noglobstar: false, // Support **
    matchBase: false, // Don't match basename only
  });
  return matches;
}

/**
 * Check folder access for a given path
 *
 * Evaluation logic:
 * 1. Iterate through rules in order
 * 2. First matching rule wins
 * 3. If no rule matches, use defaultPolicy
 * 4. If inheritFromTier=true and defaultPolicy='deny', fall back to tier permissions
 *
 * @param filepath - Absolute file path to check
 * @param operation - Operation type ('read' or 'write')
 * @param config - Folder permission configuration
 * @param tierPermissions - Optional security tier filesystem permissions
 * @returns Permission check result
 *
 * @example
 * checkFolderAccess("/home/user/workspace/file.txt", "write", config)
 * → { allowed: true, read: true, write: true, matchedRule: {...} }
 */
export function checkFolderAccess(
  filepath: string,
  operation: 'read' | 'write',
  config: FolderPermissionConfig,
  tierPermissions?: GranularPermissions['filesystem']
): FolderPermissionResult {
  // Resolve to absolute path
  const absolutePath = path.resolve(expandTilde(filepath));

  // Iterate through rules (first match wins)
  for (const rule of config.rules) {
    if (matchesGlob(absolutePath, rule.pattern)) {
      // Matched a rule
      const allowed = operation === 'read' ? rule.read : rule.write;

      return {
        allowed,
        read: rule.read,
        write: rule.write,
        matchedRule: rule,
        reason: allowed
          ? undefined
          : `${operation === 'read' ? 'Read' : 'Write'} access denied by rule: ${rule.description || rule.pattern}`,
      };
    }
  }

  // No rule matched - apply default policy
  if (config.defaultPolicy === 'allow') {
    return {
      allowed: true,
      read: true,
      write: true,
      reason: undefined,
    };
  }

  // Default policy is 'deny'
  // Check if we should inherit from tier permissions
  if (config.inheritFromTier && tierPermissions) {
    const tierAllowed = operation === 'read' ? tierPermissions.read : tierPermissions.write;

    return {
      allowed: tierAllowed,
      read: tierPermissions.read,
      write: tierPermissions.write,
      reason: tierAllowed
        ? undefined
        : `Path ${absolutePath} not in allowed folders (inherited from security tier)`,
    };
  }

  // Final denial
  return {
    allowed: false,
    read: false,
    write: false,
    reason: `Path ${absolutePath} not in allowed folders (default policy: deny)`,
  };
}

/**
 * Validate folder permission configuration
 *
 * Checks:
 * - All patterns are valid glob patterns
 * - No conflicting rules (warn about overlaps)
 * - Negation patterns come after their positive counterparts
 *
 * @param config - Folder permission configuration to validate
 * @returns Validation result with errors and warnings
 *
 * @example
 * validateFolderConfig({
 *   defaultPolicy: 'deny',
 *   inheritFromTier: true,
 *   rules: [
 *     { pattern: "~/workspace/**", read: true, write: true },
 *     { pattern: "!/workspace/sensitive/*", read: false, write: false }
 *   ]
 * })
 */
export function validateFolderConfig(config: FolderPermissionConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate defaultPolicy
  if (config.defaultPolicy !== 'allow' && config.defaultPolicy !== 'deny') {
    errors.push(`Invalid defaultPolicy: ${config.defaultPolicy}. Must be 'allow' or 'deny'.`);
  }

  // Validate rules
  if (!Array.isArray(config.rules)) {
    errors.push('rules must be an array');
    return { valid: false, errors, warnings };
  }

  // Track patterns for overlap detection
  const seenPatterns = new Set<string>();

  for (let i = 0; i < config.rules.length; i++) {
    const rule = config.rules[i];

    // Validate pattern exists
    if (!rule.pattern || typeof rule.pattern !== 'string') {
      errors.push(`Rule ${i}: pattern must be a non-empty string`);
      continue;
    }

    // Validate read/write are booleans
    if (typeof rule.read !== 'boolean') {
      errors.push(`Rule ${i} (${rule.pattern}): read must be a boolean`);
    }
    if (typeof rule.write !== 'boolean') {
      errors.push(`Rule ${i} (${rule.pattern}): write must be a boolean`);
    }

    // Check for duplicate patterns
    if (seenPatterns.has(rule.pattern)) {
      warnings.push(`Rule ${i}: duplicate pattern ${rule.pattern}`);
    }
    seenPatterns.add(rule.pattern);

    // Validate glob pattern syntax (basic check)
    try {
      const testPattern = rule.pattern.startsWith('!') ? rule.pattern.slice(1) : rule.pattern;
      const expanded = expandTilde(testPattern);
      // minimatch will throw on invalid patterns
      minimatch('/test/path', expanded);
    } catch (err) {
      errors.push(`Rule ${i}: invalid glob pattern ${rule.pattern}: ${err}`);
    }

    // Warn if a deny rule is likely shadowed by earlier allow rules.
    if (rule.pattern.startsWith('!')) {
      const denyPattern = rule.pattern.slice(1);
      const denyExpanded = expandTilde(denyPattern);
      const shadowingAllow = config.rules.slice(0, i).some((earlier) => {
        if (earlier.pattern.startsWith('!')) return false;
        const earlierExpanded = expandTilde(earlier.pattern);
        return (
          earlierExpanded === denyExpanded ||
          (earlierExpanded.includes('**') &&
            denyExpanded.startsWith(earlierExpanded.replace('/**', '')))
        );
      });

      if (shadowingAllow) {
        warnings.push(
          `Rule ${i}: deny pattern ${rule.pattern} may be shadowed by an earlier allow rule. With "first match wins", place deny rules before broader allow patterns.`
        );
      }
    }

    // Warn about conflicting permissions (overlapping patterns with different permissions)
    for (let j = i + 1; j < config.rules.length; j++) {
      const laterRule = config.rules[j];

      const rulePattern = rule.pattern.startsWith('!') ? rule.pattern.slice(1) : rule.pattern;
      const laterPattern = laterRule.pattern.startsWith('!')
        ? laterRule.pattern.slice(1)
        : laterRule.pattern;

      // Simple overlap check: if patterns are identical or one is subset of other
      if (
        rulePattern === laterPattern ||
        (rulePattern.includes('**') && laterPattern.startsWith(rulePattern.replace('/**', '')))
      ) {
        if (rule.read !== laterRule.read || rule.write !== laterRule.write) {
          warnings.push(
            `Rules ${i} and ${j} have overlapping patterns with different permissions. First match wins: ${rule.pattern} takes precedence over ${laterRule.pattern}`
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Validates that a resolved path stays within its expected parent directory.
 * Prevents path traversal attacks via symlinks or `..` sequences.
 *
 * Ported from OpenClaw upstream security fix for plugin/hook path containment.
 *
 * @param resolvedPath - The path to validate (already resolved via path.resolve)
 * @param allowedBase - The base directory the path must stay within
 * @returns True if the path is contained within allowedBase
 *
 * @example
 * isContainedPath('/home/user/workspace/file.txt', '/home/user/workspace') → true
 * isContainedPath('/etc/passwd', '/home/user/workspace') → false
 */
export function isContainedPath(resolvedPath: string, allowedBase: string): boolean {
  const normalizedPath = path.resolve(resolvedPath);
  const normalizedBase = path.resolve(allowedBase);

  return normalizedPath === normalizedBase || normalizedPath.startsWith(normalizedBase + path.sep);
}

/**
 * Validates a plugin or hook path stays within allowed directories.
 *
 * @param pluginPath - Path to the plugin/hook file
 * @param allowedDirs - Directories the plugin is allowed to be in
 * @returns Validation result
 */
export function validatePluginPath(
  pluginPath: string,
  allowedDirs: string[]
): { allowed: boolean; reason?: string } {
  const resolved = path.resolve(expandTilde(pluginPath));

  for (const dir of allowedDirs) {
    const resolvedDir = path.resolve(expandTilde(dir));
    if (isContainedPath(resolved, resolvedDir)) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    reason: `Plugin path "${resolved}" is not within any allowed directory: ${allowedDirs.join(', ')}`,
  };
}

/**
 * Create a default folder permission config for a security tier
 *
 * @param tierName - Security tier name
 * @returns Default folder permission config for tier
 */
export function createDefaultFolderConfig(
  tierName: 'dangerous' | 'permissive' | 'balanced' | 'strict' | 'paranoid'
): FolderPermissionConfig {
  switch (tierName) {
    case 'dangerous':
      return {
        defaultPolicy: 'allow',
        inheritFromTier: false,
        rules: [],
      };

    case 'permissive':
      return {
        defaultPolicy: 'allow',
        inheritFromTier: true,
        rules: [
          { pattern: '!/etc/**', read: false, write: false, description: 'Block system config' },
          { pattern: '!/root/**', read: false, write: false, description: 'Block root home' },
        ],
      };

    case 'balanced':
      return {
        defaultPolicy: 'deny',
        inheritFromTier: true,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true, description: 'Agent workspace' },
          { pattern: '/tmp/**', read: true, write: true, description: 'Temp files' },
          { pattern: '/var/log/**', read: true, write: false, description: 'Read-only logs' },
        ],
      };

    case 'strict':
      return {
        defaultPolicy: 'deny',
        inheritFromTier: true,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true, description: 'Agent workspace' },
          { pattern: '/tmp/agents/**', read: true, write: true, description: 'Agent temp files' },
        ],
      };

    case 'paranoid':
      return {
        defaultPolicy: 'deny',
        inheritFromTier: true,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true, description: 'Agent workspace only' },
        ],
      };
  }
}
