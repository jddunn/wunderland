/**
 * @fileoverview Tests for runtime-policy — tool filtering by profile and permissions
 * @module wunderland/cli/__tests__/runtime-policy.test
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSecurityTier,
  normalizePermissionSet,
  normalizeExecutionMode,
  normalizeToolAccessProfile,
  normalizeRuntimePolicy,
  filterToolMapByPolicy,
  getPermissionsForSet,
} from '../security/runtime-policy.js';

// ── Normalizers ─────────────────────────────────────────────────────────────

describe('normalizeSecurityTier', () => {
  it('should accept valid tier names', () => {
    expect(normalizeSecurityTier('balanced')).toBe('balanced');
    expect(normalizeSecurityTier('strict')).toBe('strict');
    expect(normalizeSecurityTier('dangerous')).toBe('dangerous');
  });

  it('should default to balanced for invalid input', () => {
    expect(normalizeSecurityTier('invalid')).toBe('balanced');
    expect(normalizeSecurityTier(undefined)).toBe('balanced');
    expect(normalizeSecurityTier(42)).toBe('balanced');
  });

  it('should trim and lowercase', () => {
    expect(normalizeSecurityTier(' Balanced ')).toBe('balanced');
  });
});

describe('normalizeToolAccessProfile', () => {
  it('should accept valid profile names', () => {
    expect(normalizeToolAccessProfile('assistant')).toBe('assistant');
    expect(normalizeToolAccessProfile('social-citizen')).toBe('social-citizen');
    expect(normalizeToolAccessProfile('unrestricted')).toBe('unrestricted');
  });

  it('should default to assistant for invalid input', () => {
    expect(normalizeToolAccessProfile('invalid')).toBe('assistant');
    expect(normalizeToolAccessProfile(undefined)).toBe('assistant');
    expect(normalizeToolAccessProfile('')).toBe('assistant');
  });
});

describe('normalizeExecutionMode', () => {
  it('should accept valid modes', () => {
    expect(normalizeExecutionMode('autonomous', 'balanced')).toBe('autonomous');
    expect(normalizeExecutionMode('human-all', 'balanced')).toBe('human-all');
    expect(normalizeExecutionMode('human-dangerous', 'balanced')).toBe('human-dangerous');
  });

  it('should derive from tier when not specified', () => {
    expect(normalizeExecutionMode(undefined, 'dangerous')).toBe('autonomous');
    expect(normalizeExecutionMode(undefined, 'permissive')).toBe('autonomous');
    expect(normalizeExecutionMode(undefined, 'paranoid')).toBe('human-all');
    expect(normalizeExecutionMode(undefined, 'balanced')).toBe('human-dangerous');
  });
});

describe('normalizeRuntimePolicy', () => {
  it('should produce complete policy from empty config', () => {
    const policy = normalizeRuntimePolicy({});
    expect(policy.securityTier).toBe('balanced');
    expect(policy.permissionSet).toBeDefined();
    expect(policy.toolAccessProfile).toBe('assistant');
    expect(policy.executionMode).toBe('human-dangerous');
    expect(typeof policy.wrapToolOutputs).toBe('boolean');
  });

  it('should respect explicit config values', () => {
    const policy = normalizeRuntimePolicy({
      securityTier: 'strict',
      toolAccessProfile: 'social-citizen',
      executionMode: 'human-all',
    });
    expect(policy.securityTier).toBe('strict');
    expect(policy.toolAccessProfile).toBe('social-citizen');
    expect(policy.executionMode).toBe('human-all');
  });
});

// ── filterToolMapByPolicy ───────────────────────────────────────────────────

describe('filterToolMapByPolicy', () => {
  function makeTool(name: string, category?: string): any {
    return { name, category, description: `Tool ${name}` };
  }

  function makeToolMap(tools: any[]): Map<string, any> {
    const map = new Map();
    for (const t of tools) map.set(t.name, t);
    return map;
  }

  it('assistant profile should allow skills and meta tools', () => {
    const toolMap = makeToolMap([
      makeTool('web_search', 'search'),
      makeTool('skills_list', 'search'),
      makeTool('skills_enable', 'memory'),
      makeTool('extensions_list', 'search'),
      makeTool('extensions_enable', 'memory'),
    ]);

    const perms = getPermissionsForSet('supervised');
    const { toolMap: filtered, dropped } = filterToolMapByPolicy({
      toolMap,
      toolAccessProfile: 'assistant',
      permissions: perms,
    });

    expect(filtered.has('web_search')).toBe(true);
    expect(filtered.has('skills_list')).toBe(true);
    expect(filtered.has('skills_enable')).toBe(true);
    expect(filtered.has('extensions_list')).toBe(true);
    expect(filtered.has('extensions_enable')).toBe(true);
    expect(dropped).toHaveLength(0);
  });

  it('assistant profile should block system tools', () => {
    const toolMap = makeToolMap([
      makeTool('web_search', 'search'),
      makeTool('cli_executor', 'system'),
      makeTool('shell_exec', 'system'),
    ]);

    const perms = getPermissionsForSet('supervised');
    const { toolMap: filtered, dropped } = filterToolMapByPolicy({
      toolMap,
      toolAccessProfile: 'assistant',
      permissions: perms,
    });

    expect(filtered.has('web_search')).toBe(true);
    expect(filtered.has('cli_executor')).toBe(false);
    expect(filtered.has('shell_exec')).toBe(false);
    expect(dropped.length).toBe(2);
  });

  it('assistant profile should block unknown tools', () => {
    const toolMap = makeToolMap([
      makeTool('totally_custom_tool'),
    ]);

    const perms = getPermissionsForSet('supervised');
    const { toolMap: filtered, dropped } = filterToolMapByPolicy({
      toolMap,
      toolAccessProfile: 'assistant',
      permissions: perms,
    });

    expect(filtered.has('totally_custom_tool')).toBe(false);
    expect(dropped.length).toBe(1);
    expect(dropped[0].reason).toContain('blocked_by_tool_access_profile');
  });

  it('unrestricted profile should allow all tools', () => {
    const toolMap = makeToolMap([
      makeTool('web_search', 'search'),
      makeTool('cli_executor', 'system'),
      makeTool('totally_unknown'),
    ]);

    const perms = getPermissionsForSet('unrestricted');
    const { toolMap: filtered, dropped } = filterToolMapByPolicy({
      toolMap,
      toolAccessProfile: 'unrestricted',
      permissions: perms,
    });

    expect(filtered.size).toBe(3);
    expect(dropped).toHaveLength(0);
  });

  it('social-citizen profile should block filesystem and system', () => {
    const toolMap = makeToolMap([
      makeTool('social_post', 'social'),
      makeTool('web_search', 'search'),
      makeTool('file_read', 'filesystem'),
      makeTool('shell_exec', 'system'),
    ]);

    const perms = getPermissionsForSet('supervised');
    const { toolMap: filtered } = filterToolMapByPolicy({
      toolMap,
      toolAccessProfile: 'social-citizen',
      permissions: perms,
    });

    expect(filtered.has('social_post')).toBe(true);
    expect(filtered.has('web_search')).toBe(true);
    expect(filtered.has('file_read')).toBe(false);
    expect(filtered.has('shell_exec')).toBe(false);
  });

  it('permission set should further restrict filesystem reads', () => {
    const toolMap = makeToolMap([
      makeTool('file_read', 'filesystem'),
      makeTool('read_file', 'filesystem'),
    ]);

    // Use restrictive permissions that block filesystem read
    const perms = getPermissionsForSet('supervised');
    perms.filesystem.read = false;

    const { toolMap: filtered, dropped } = filterToolMapByPolicy({
      toolMap,
      toolAccessProfile: 'assistant',
      permissions: perms,
    });

    expect(filtered.has('file_read')).toBe(false);
    expect(filtered.has('read_file')).toBe(false);
    expect(dropped.every(d => d.reason.includes('filesystem.read'))).toBe(true);
  });
});
