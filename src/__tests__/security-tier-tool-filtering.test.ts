// @ts-nocheck
/**
 * @fileoverview E2E tests for security tier tool filtering via filterToolMapByPolicy()
 * @module wunderland/__tests__/security-tier-tool-filtering.e2e
 *
 * Validates that each named security tier (dangerous, permissive, balanced,
 * strict, paranoid) correctly includes or removes tools based on its
 * permission set. Uses the real SECURITY_TIERS configs and the real
 * filterToolMapByPolicy() function — no mocking of policy logic.
 *
 * Tool naming follows the conventions in policy.ts helper functions:
 *   - shell_execute  => CLI execution (system.cliExecution via isCliExecutionTool)
 *   - file_write     => Filesystem write (filesystem.write via isFilesystemWriteTool)
 *   - file_read      => Filesystem read  (filesystem.read via isFilesystemReadTool)
 *   - list_directory  => Filesystem read  (filesystem.read via isFilesystemReadTool)
 *
 * create_spreadsheet / create_document are in the isFilesystemWriteTool() list,
 * so they are correctly removed when filesystem.write=false (balanced, strict,
 * paranoid tiers).
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — stub transitive dependencies that fail to resolve in vitest
// ---------------------------------------------------------------------------

vi.mock('@framers/agentos/safety/guardrails', () => ({
  GuardrailAction: { PASS: 'pass', BLOCK: 'block', FLAG: 'flag', REDACT: 'redact' },
}));

vi.mock('@framers/agentos', () => ({
  resolveAgentWorkspaceDir: () => '/tmp/test-workspace',
}));

import {
  SECURITY_TIERS,
  PERMISSION_SETS,
  type SecurityTierName,
} from '../security/SecurityTiers.js';
import {
  filterToolMapByPolicy,
  getPermissionsForSet,
} from '../runtime/policy.js';
import type { ToolInstance } from '../runtime/tool-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ToolInstance stub. Only fields consumed by
 * filterToolMapByPolicy are populated — no actual execute() needed.
 */
function stubTool(overrides: Partial<ToolInstance> & { name: string }): ToolInstance {
  return {
    description: `Stub for ${overrides.name}`,
    inputSchema: {},
    hasSideEffects: false,
    execute: async () => ({ success: true }),
    ...overrides,
  };
}

/**
 * Create a standard tool map containing the core tools we care about.
 * Every tier test starts from the same baseline so the only variable is the
 * permission set derived from the security tier.
 */
function buildBaseToolMap(): Map<string, ToolInstance> {
  const map = new Map<string, ToolInstance>();

  // System / CLI execution tools
  map.set('shell_execute', stubTool({
    name: 'shell_execute',
    description: 'Execute a shell command',
    category: 'system',
    hasSideEffects: true,
  }));

  // Filesystem write tools (in the isFilesystemWriteTool allowlist)
  map.set('file_write', stubTool({
    name: 'file_write',
    description: 'Write content to a file',
    category: 'filesystem',
    hasSideEffects: true,
  }));

  map.set('file_append', stubTool({
    name: 'file_append',
    description: 'Append content to a file',
    category: 'filesystem',
    hasSideEffects: true,
  }));

  // Filesystem read tools (in the isFilesystemReadTool allowlist)
  map.set('file_read', stubTool({
    name: 'file_read',
    description: 'Read content from a file',
    category: 'filesystem',
    hasSideEffects: false,
  }));

  // Directory listing (in the isFilesystemReadTool allowlist — read-only)
  map.set('list_directory', stubTool({
    name: 'list_directory',
    description: 'List contents of a directory',
    category: 'filesystem',
    hasSideEffects: false,
  }));

  // Hypothetical write tools NOT in the isFilesystemWriteTool allowlist.
  // These have category "filesystem" but their names are not recognized by
  // isFilesystemWriteTool(), so the filesystem.write permission check does
  // not apply to them. They also aren't in isFilesystemReadTool(). The only
  // layer that can block them is the tool access profile category filter.
  map.set('create_spreadsheet', stubTool({
    name: 'create_spreadsheet',
    description: 'Create a new spreadsheet file',
    category: 'filesystem',
    hasSideEffects: true,
  }));

  map.set('create_document', stubTool({
    name: 'create_document',
    description: 'Create a new document file',
    category: 'filesystem',
    hasSideEffects: true,
  }));

  // Memory tools (read + write) — useful baseline sanity check
  map.set('memory_read', stubTool({
    name: 'memory_read',
    description: 'Read from agent memory',
    category: 'memory',
    hasSideEffects: false,
  }));

  map.set('memory_write', stubTool({
    name: 'memory_write',
    description: 'Write to agent memory',
    category: 'memory',
    hasSideEffects: true,
  }));

  // Search tool — follows network.httpRequests permission
  map.set('web_search', stubTool({
    name: 'web_search',
    description: 'Search the web',
    category: 'search',
    hasSideEffects: false,
  }));

  return map;
}

/**
 * Run filterToolMapByPolicy using a security tier's permission set and the
 * "unrestricted" tool access profile so that ONLY permission-set rules
 * determine which tools survive. Using "unrestricted" ensures the tool
 * access profile does not add its own category blocks.
 */
function filterForTier(tierName: SecurityTierName) {
  const tier = SECURITY_TIERS[tierName];
  const permissions = getPermissionsForSet(tier.permissionSet);
  const toolMap = buildBaseToolMap();

  return filterToolMapByPolicy({
    toolMap,
    toolAccessProfile: 'unrestricted',
    permissions,
  });
}

/** Convenience: names of tools present in the filtered map. */
function surviving(tierName: SecurityTierName): string[] {
  const { toolMap } = filterForTier(tierName);
  return [...toolMap.keys()].sort();
}

/** Convenience: names of tools that were dropped. */
function droppedNames(tierName: SecurityTierName): string[] {
  const { dropped } = filterForTier(tierName);
  return dropped.map(d => d.tool).sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Security tier tool filtering (E2E)', { timeout: 15_000 }, () => {
  // -----------------------------------------------------------------------
  // 1. dangerous — unrestricted permission set: everything survives
  // -----------------------------------------------------------------------
  describe('dangerous tier', () => {
    it('should keep shell_execute, file_write, and file_read', () => {
      const tools = surviving('dangerous');
      expect(tools).toContain('shell_execute');
      expect(tools).toContain('file_write');
      expect(tools).toContain('file_read');
    });

    it('should drop zero tools', () => {
      expect(droppedNames('dangerous')).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 2. permissive — autonomous permission set: broad access
  // -----------------------------------------------------------------------
  describe('permissive tier', () => {
    it('should keep shell_execute, file_write, and file_read', () => {
      const tools = surviving('permissive');
      expect(tools).toContain('shell_execute');
      expect(tools).toContain('file_write');
      expect(tools).toContain('file_read');
    });

    it('should keep list_directory', () => {
      expect(surviving('permissive')).toContain('list_directory');
    });

    it('should keep memory_read and memory_write', () => {
      const tools = surviving('permissive');
      expect(tools).toContain('memory_read');
      expect(tools).toContain('memory_write');
    });
  });

  // -----------------------------------------------------------------------
  // 3. balanced — supervised permission set
  //    filesystem.read=true, filesystem.write=false, system.cliExecution=false
  // -----------------------------------------------------------------------
  describe('balanced tier', () => {
    it('should remove shell_execute (supervised set: system.cliExecution=false)', () => {
      const tools = surviving('balanced');
      expect(tools).not.toContain('shell_execute');
    });

    it('should remove file_write (supervised set: filesystem.write=false)', () => {
      expect(surviving('balanced')).not.toContain('file_write');
    });

    it('should remove file_append (supervised set: filesystem.write=false)', () => {
      expect(surviving('balanced')).not.toContain('file_append');
    });

    it('should keep file_read (supervised set: filesystem.read=true)', () => {
      expect(surviving('balanced')).toContain('file_read');
    });

    it('should keep list_directory (read-only filesystem)', () => {
      expect(surviving('balanced')).toContain('list_directory');
    });
  });

  // -----------------------------------------------------------------------
  // 4. strict — supervised permission set (same as balanced for tool filtering)
  // -----------------------------------------------------------------------
  describe('strict tier', () => {
    it('should remove shell_execute (system.cliExecution=false)', () => {
      expect(surviving('strict')).not.toContain('shell_execute');
    });

    it('should remove file_write (filesystem.write=false)', () => {
      expect(surviving('strict')).not.toContain('file_write');
    });

    it('should keep file_read (filesystem.read=true)', () => {
      expect(surviving('strict')).toContain('file_read');
    });

    it('should keep list_directory (filesystem.read=true)', () => {
      expect(surviving('strict')).toContain('list_directory');
    });
  });

  // -----------------------------------------------------------------------
  // 5. paranoid — minimal permission set
  //    filesystem.read=false, filesystem.write=false, system.cliExecution=false
  //    network.httpRequests=true (minimal allows HTTP but blocks sockets/APIs)
  // -----------------------------------------------------------------------
  describe('paranoid tier', () => {
    it('should remove shell_execute', () => {
      expect(surviving('paranoid')).not.toContain('shell_execute');
    });

    it('should remove file_write', () => {
      expect(surviving('paranoid')).not.toContain('file_write');
    });

    it('should remove file_read (minimal set: filesystem.read=false)', () => {
      expect(surviving('paranoid')).not.toContain('file_read');
    });

    it('should remove list_directory (minimal set: filesystem.read=false)', () => {
      expect(surviving('paranoid')).not.toContain('list_directory');
    });

    it('should keep memory_read (minimal set: data.memoryRead=true)', () => {
      expect(surviving('paranoid')).toContain('memory_read');
    });

    it('should remove memory_write (minimal set: data.memoryWrite=false)', () => {
      expect(surviving('paranoid')).not.toContain('memory_write');
    });

    it('should keep web_search (minimal set: network.httpRequests=true)', () => {
      expect(surviving('paranoid')).toContain('web_search');
    });
  });

  // -----------------------------------------------------------------------
  // 6. list_directory availability across tiers
  // -----------------------------------------------------------------------
  describe('list_directory read-only tool across tiers', () => {
    it('should be available on tiers with filesystem.read=true', () => {
      for (const tier of ['dangerous', 'permissive', 'balanced', 'strict'] as SecurityTierName[]) {
        const permissions = getPermissionsForSet(SECURITY_TIERS[tier].permissionSet);
        expect(permissions.filesystem.read).toBe(true);
        expect(surviving(tier)).toContain('list_directory');
      }
    });

    it('should be blocked on paranoid tier (minimal set: filesystem.read=false)', () => {
      const permissions = getPermissionsForSet(SECURITY_TIERS.paranoid.permissionSet);
      expect(permissions.filesystem.read).toBe(false);
      expect(surviving('paranoid')).not.toContain('list_directory');
    });
  });

  // -----------------------------------------------------------------------
  // 7. create_spreadsheet and create_document follow filesystem.write
  //    (now correctly in the isFilesystemWriteTool allowlist)
  // -----------------------------------------------------------------------
  describe('create_spreadsheet and create_document', () => {
    it('should survive on dangerous and permissive tiers (filesystem.write=true)', () => {
      for (const tier of ['dangerous', 'permissive'] as SecurityTierName[]) {
        const tools = surviving(tier);
        expect(tools).toContain('create_spreadsheet');
        expect(tools).toContain('create_document');
      }
    });

    it('should be removed on balanced tier (filesystem.write=false)', () => {
      const tools = surviving('balanced');
      expect(tools).not.toContain('create_spreadsheet');
      expect(tools).not.toContain('create_document');
    });

    it('should be removed on strict tier (filesystem.write=false)', () => {
      const tools = surviving('strict');
      expect(tools).not.toContain('create_spreadsheet');
      expect(tools).not.toContain('create_document');
    });

    it('should be removed on paranoid tier (filesystem.write=false)', () => {
      const tools = surviving('paranoid');
      expect(tools).not.toContain('create_spreadsheet');
      expect(tools).not.toContain('create_document');
    });
  });

  // -----------------------------------------------------------------------
  // Drop reasons contain useful diagnostics
  // -----------------------------------------------------------------------
  describe('drop reasons', () => {
    it('should report filesystem.write=false for file_write on strict tier', () => {
      const { dropped } = filterForTier('strict');
      const fileWriteDrop = dropped.find(d => d.tool === 'file_write');
      expect(fileWriteDrop).toBeDefined();
      expect(fileWriteDrop!.reason).toContain('filesystem.write');
    });

    it('should report system.cliExecution=false for shell_execute on strict tier', () => {
      const { dropped } = filterForTier('strict');
      const shellDrop = dropped.find(d => d.tool === 'shell_execute');
      expect(shellDrop).toBeDefined();
      expect(shellDrop!.reason).toContain('cliExecution');
    });

    it('should report filesystem.read=false for file_read on paranoid tier', () => {
      const { dropped } = filterForTier('paranoid');
      const fileReadDrop = dropped.find(d => d.tool === 'file_read');
      expect(fileReadDrop).toBeDefined();
      expect(fileReadDrop!.reason).toContain('filesystem.read');
    });

    it('should report data.memoryWrite=false for memory_write on paranoid tier', () => {
      const { dropped } = filterForTier('paranoid');
      const memDrop = dropped.find(d => d.tool === 'memory_write');
      expect(memDrop).toBeDefined();
      expect(memDrop!.reason).toContain('data.memoryWrite');
    });
  });

  // -----------------------------------------------------------------------
  // Sanity: permission set mapping matches tier expectations
  // -----------------------------------------------------------------------
  describe('tier-to-permission-set mapping sanity', () => {
    it('dangerous tier uses unrestricted permission set', () => {
      expect(SECURITY_TIERS.dangerous.permissionSet).toBe('unrestricted');
    });

    it('permissive tier uses autonomous permission set', () => {
      expect(SECURITY_TIERS.permissive.permissionSet).toBe('autonomous');
    });

    it('balanced tier uses supervised permission set', () => {
      expect(SECURITY_TIERS.balanced.permissionSet).toBe('supervised');
    });

    it('strict tier uses supervised permission set', () => {
      expect(SECURITY_TIERS.strict.permissionSet).toBe('supervised');
    });

    it('paranoid tier uses minimal permission set', () => {
      expect(SECURITY_TIERS.paranoid.permissionSet).toBe('minimal');
    });
  });

  // -----------------------------------------------------------------------
  // Permission set field-level verification
  // -----------------------------------------------------------------------
  describe('permission set field-level verification', () => {
    it('unrestricted set allows everything', () => {
      const p = PERMISSION_SETS.unrestricted;
      expect(p.filesystem.read).toBe(true);
      expect(p.filesystem.write).toBe(true);
      expect(p.system.cliExecution).toBe(true);
      expect(p.network.httpRequests).toBe(true);
      expect(p.data.memoryRead).toBe(true);
      expect(p.data.memoryWrite).toBe(true);
    });

    it('supervised set blocks writes and CLI', () => {
      const p = PERMISSION_SETS.supervised;
      expect(p.filesystem.read).toBe(true);
      expect(p.filesystem.write).toBe(false);
      expect(p.system.cliExecution).toBe(false);
      expect(p.network.httpRequests).toBe(true);
    });

    it('minimal set blocks all filesystem access', () => {
      const p = PERMISSION_SETS.minimal;
      expect(p.filesystem.read).toBe(false);
      expect(p.filesystem.write).toBe(false);
      expect(p.system.cliExecution).toBe(false);
      expect(p.data.memoryRead).toBe(true);
      expect(p.data.memoryWrite).toBe(false);
    });
  });
});
