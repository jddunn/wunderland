/**
 * @fileoverview Unit tests for FolderPermissions
 * @module wunderland/security/__tests__/FolderPermissions
 */

import { describe, it, expect } from 'vitest';
import {
  expandTilde,
  matchesGlob,
  checkFolderAccess,
  validateFolderConfig,
  createDefaultFolderConfig,
  type FolderPermissionConfig,
  type GranularPermissions,
} from '../FolderPermissions.js';
import * as os from 'node:os';
import * as path from 'node:path';

describe('FolderPermissions', () => {
  describe('expandTilde', () => {
    it('should expand ~ to home directory', () => {
      const result = expandTilde('~/workspace/file.txt');
      expect(result).toBe(path.join(os.homedir(), 'workspace/file.txt'));
    });

    it('should not modify paths without ~', () => {
      expect(expandTilde('/etc/passwd')).toBe('/etc/passwd');
      expect(expandTilde('./relative/path')).toBe('./relative/path');
      expect(expandTilde('../parent/path')).toBe('../parent/path');
    });

    it('should only expand ~ at start', () => {
      const result = expandTilde('/path/~/other');
      expect(result).toBe('/path/~/other');
    });
  });

  describe('matchesGlob', () => {
    it('should match exact paths', () => {
      expect(matchesGlob('/home/user/file.txt', '/home/user/file.txt')).toBe(true);
      expect(matchesGlob('/home/user/file.txt', '/home/user/other.txt')).toBe(false);
    });

    it('should match with * wildcard', () => {
      expect(matchesGlob('/home/user/file.txt', '/home/user/*')).toBe(true);
      expect(matchesGlob('/home/user/subdir/file.txt', '/home/user/*')).toBe(false);
      expect(matchesGlob('/home/user/file.txt', '/home/*/file.txt')).toBe(true);
    });

    it('should match with ** recursive wildcard', () => {
      expect(matchesGlob('/home/user/file.txt', '/home/**')).toBe(true);
      expect(matchesGlob('/home/user/subdir/file.txt', '/home/**')).toBe(true);
      expect(matchesGlob('/home/user/a/b/c/file.txt', '/home/**')).toBe(true);
      expect(matchesGlob('/etc/passwd', '/home/**')).toBe(false);
    });

    it('should match dotfiles when dot: true', () => {
      expect(matchesGlob('/home/user/.ssh/config', '/home/user/**')).toBe(true);
      expect(matchesGlob('/home/user/.hidden', '/home/user/*')).toBe(true);
    });

    it('should handle negation patterns', () => {
      // Negation pattern should return opposite
      expect(matchesGlob('/sensitive/data.txt', '!/sensitive/*')).toBe(false);
      expect(matchesGlob('/public/data.txt', '!/sensitive/*')).toBe(true);
      expect(matchesGlob('/sensitive/subdir/file.txt', '!/sensitive/**')).toBe(false);
    });

    it('should expand ~ in patterns', () => {
      const homePath = path.join(os.homedir(), 'workspace/file.txt');
      expect(matchesGlob(homePath, '~/workspace/*')).toBe(true);
      expect(matchesGlob(homePath, '~/workspace/**')).toBe(true);
      expect(matchesGlob(homePath, '~/other/*')).toBe(false);
    });

    it('should expand ~ in file paths', () => {
      expect(matchesGlob('~/workspace/file.txt', '~/workspace/*')).toBe(true);
    });
  });

  describe('checkFolderAccess', () => {
    const config: FolderPermissionConfig = {
      defaultPolicy: 'deny',
      inheritFromTier: false,
      rules: [
        { pattern: '~/workspace/**', read: true, write: true, description: 'Agent workspace' },
        { pattern: '/tmp/**', read: true, write: true },
        { pattern: '/var/log/**', read: true, write: false, description: 'Read-only logs' },
        { pattern: '!/sensitive/*', read: false, write: false, description: 'Block sensitive' },
      ],
    };

    it('should allow access to matching rule', () => {
      const workspacePath = path.join(os.homedir(), 'workspace/file.txt');
      const result = checkFolderAccess(workspacePath, 'write', config);

      expect(result.allowed).toBe(true);
      expect(result.read).toBe(true);
      expect(result.write).toBe(true);
      expect(result.matchedRule?.description).toBe('Agent workspace');
    });

    it('should respect read vs write permissions', () => {
      const readResult = checkFolderAccess('/var/log/system.log', 'read', config);
      expect(readResult.allowed).toBe(true);

      const writeResult = checkFolderAccess('/var/log/system.log', 'write', config);
      expect(writeResult.allowed).toBe(false);
      expect(writeResult.reason).toContain('Write access denied');
    });

    it('should apply first matching rule', () => {
      const configWithOverlap: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '/home/**', read: true, write: false }, // First match
          { pattern: '/home/user/**', read: true, write: true }, // Won't match
        ],
      };

      const result = checkFolderAccess('/home/user/file.txt', 'write', configWithOverlap);
      expect(result.allowed).toBe(false); // First rule denies write
    });

    it('should use default policy when no rule matches', () => {
      const allowConfig: FolderPermissionConfig = {
        defaultPolicy: 'allow',
        inheritFromTier: false,
        rules: [],
      };

      const result = checkFolderAccess('/unknown/path.txt', 'write', allowConfig);
      expect(result.allowed).toBe(true);
    });

    it('should deny by default with deny policy', () => {
      const denyConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [],
      };

      const result = checkFolderAccess('/unknown/path.txt', 'write', denyConfig);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in allowed folders');
    });

    it('should inherit from tier permissions when enabled', () => {
      const inheritConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: true,
        rules: [],
      };

      const tierPermissions: GranularPermissions['filesystem'] = {
        read: true,
        write: false,
        delete: false,
        execute: false,
      };

      const readResult = checkFolderAccess('/any/file.txt', 'read', inheritConfig, tierPermissions);
      expect(readResult.allowed).toBe(true);

      const writeResult = checkFolderAccess('/any/file.txt', 'write', inheritConfig, tierPermissions);
      expect(writeResult.allowed).toBe(false);
    });

    it('should handle negation patterns correctly', () => {
      const sensitiveResult = checkFolderAccess('/sensitive/data.txt', 'read', config);
      expect(sensitiveResult.allowed).toBe(false);
      expect(sensitiveResult.matchedRule?.description).toBe('Block sensitive');
    });
  });

  describe('validateFolderConfig', () => {
    it('should validate correct config', () => {
      const config: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: true,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
          { pattern: '/tmp/**', read: true, write: true },
        ],
      };

      const result = validateFolderConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should reject invalid defaultPolicy', () => {
      const config = {
        defaultPolicy: 'invalid' as any,
        inheritFromTier: true,
        rules: [],
      };

      const result = validateFolderConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('defaultPolicy'))).toBe(true);
    });

    it('should reject rules with non-boolean read/write', () => {
      const config: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: true,
        rules: [
          { pattern: '~/workspace/**', read: 'yes' as any, write: true },
        ],
      };

      const result = validateFolderConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('read must be a boolean'))).toBe(true);
    });

    it('should warn about duplicate patterns', () => {
      const config: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: true,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
          { pattern: '~/workspace/**', read: true, write: false },
        ],
      };

      const result = validateFolderConfig(config);
      expect(result.warnings?.some((w) => w.includes('duplicate'))).toBe(true);
    });

    it('should warn about negation patterns without positive match', () => {
      const config: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: true,
        rules: [
          { pattern: '!/sensitive/*', read: false, write: false },
        ],
      };

      const result = validateFolderConfig(config);
      expect(result.warnings?.some((w) => w.includes('negation pattern'))).toBe(true);
    });
  });

  describe('createDefaultFolderConfig', () => {
    it('should create dangerous config with allow policy', () => {
      const config = createDefaultFolderConfig('dangerous');
      expect(config.defaultPolicy).toBe('allow');
      expect(config.inheritFromTier).toBe(false);
      expect(config.rules).toEqual([]);
    });

    it('should create permissive config with blocked system paths', () => {
      const config = createDefaultFolderConfig('permissive');
      expect(config.defaultPolicy).toBe('allow');
      expect(config.rules.some((r) => r.pattern === '!/etc/**')).toBe(true);
      expect(config.rules.some((r) => r.pattern === '!/root/**')).toBe(true);
    });

    it('should create balanced config with workspace and tmp', () => {
      const config = createDefaultFolderConfig('balanced');
      expect(config.defaultPolicy).toBe('deny');
      expect(config.inheritFromTier).toBe(true);
      expect(config.rules.some((r) => r.pattern === '~/workspace/**')).toBe(true);
      expect(config.rules.some((r) => r.pattern === '/tmp/**')).toBe(true);
      expect(config.rules.some((r) => r.pattern === '/var/log/**')).toBe(true);
    });

    it('should create strict config with limited paths', () => {
      const config = createDefaultFolderConfig('strict');
      expect(config.defaultPolicy).toBe('deny');
      expect(config.rules.some((r) => r.pattern === '~/workspace/**')).toBe(true);
      expect(config.rules.some((r) => r.pattern === '/tmp/agents/**')).toBe(true);
    });

    it('should create paranoid config with workspace only', () => {
      const config = createDefaultFolderConfig('paranoid');
      expect(config.defaultPolicy).toBe('deny');
      expect(config.rules.length).toBe(1);
      expect(config.rules[0].pattern).toBe('~/workspace/**');
    });
  });
});
