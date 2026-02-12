/**
 * @fileoverview Unit tests for SafeGuardrails
 * @module wunderland/security/__tests__/SafeGuardrails
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SafeGuardrails, type GuardrailsRequest } from '../SafeGuardrails.js';
import type { FolderPermissionConfig } from '../FolderPermissions.js';
import * as path from 'node:path';
import * as os from 'node:os';

describe('SafeGuardrails', () => {
  let guardrails: SafeGuardrails;

  beforeEach(() => {
    guardrails = new SafeGuardrails({
      enableAuditLogging: false, // Disable for tests
      enableNotifications: false,
    });
  });

  describe('validateBeforeExecution', () => {
    it('should allow tools without folder permissions configured', async () => {
      const request: GuardrailsRequest = {
        toolId: 'file_read',
        toolName: 'file_read',
        args: { file_path: '/etc/passwd' },
        agentId: 'test-agent',
      };

      const result = await guardrails.validateBeforeExecution(request);
      expect(result.allowed).toBe(true);
    });

    it('should allow non-filesystem tools', async () => {
      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [],
      };

      guardrails.setFolderPermissions('test-agent', folderConfig);

      const request: GuardrailsRequest = {
        toolId: 'web_search',
        toolName: 'web_search',
        args: { query: 'test' },
        agentId: 'test-agent',
      };

      const result = await guardrails.validateBeforeExecution(request);
      expect(result.allowed).toBe(true);
    });

    it('should block file_read when path not allowed', async () => {
      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
        ],
      };

      guardrails.setFolderPermissions('test-agent', folderConfig);

      const request: GuardrailsRequest = {
        toolId: 'file_read',
        toolName: 'file_read',
        args: { file_path: '/etc/passwd' },
        agentId: 'test-agent',
      };

      const result = await guardrails.validateBeforeExecution(request);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Folder access denied');
      expect(result.violations).toBeDefined();
      expect(result.violations?.[0].attemptedPath).toContain('/etc/passwd');
      expect(result.violations?.[0].severity).toBe('critical');
    });

    it('should allow file_read when path is allowed', async () => {
      const workspacePath = path.join(os.homedir(), 'workspace/file.txt');
      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
        ],
      };

      guardrails.setFolderPermissions('test-agent', folderConfig);

      const request: GuardrailsRequest = {
        toolId: 'file_read',
        toolName: 'file_read',
        args: { file_path: workspacePath },
        agentId: 'test-agent',
      };

      const result = await guardrails.validateBeforeExecution(request);
      expect(result.allowed).toBe(true);
    });

    it('should block file_write when path is read-only', async () => {
      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '/var/log/**', read: true, write: false },
        ],
      };

      guardrails.setFolderPermissions('test-agent', folderConfig);

      const request: GuardrailsRequest = {
        toolId: 'file_write',
        toolName: 'file_write',
        args: { file_path: '/var/log/test.log', content: 'test' },
        agentId: 'test-agent',
      };

      const result = await guardrails.validateBeforeExecution(request);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Folder access denied');
    });

    it('should extract paths from shell_execute commands', async () => {
      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [],
      };

      guardrails.setFolderPermissions('test-agent', folderConfig);

      const request: GuardrailsRequest = {
        toolId: 'shell_execute',
        toolName: 'shell_execute',
        args: { command: 'rm -rf /sensitive/data' },
        agentId: 'test-agent',
      };

      const result = await guardrails.validateBeforeExecution(request);
      expect(result.allowed).toBe(false);
      expect(result.violations?.[0].attemptedPath).toContain('/sensitive/data');
    });

    it('should allow shell_execute when paths are allowed', async () => {
      const workspacePath = path.join(os.homedir(), 'workspace');
      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
        ],
      };

      guardrails.setFolderPermissions('test-agent', folderConfig);

      const request: GuardrailsRequest = {
        toolId: 'shell_execute',
        toolName: 'shell_execute',
        args: { command: `cat ${workspacePath}/file.txt` },
        agentId: 'test-agent',
      };

      const result = await guardrails.validateBeforeExecution(request);
      expect(result.allowed).toBe(true);
    });

    it('should assess severity correctly', async () => {
      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [],
      };

      guardrails.setFolderPermissions('test-agent', folderConfig);

      // Critical: /etc/passwd
      const criticalRequest: GuardrailsRequest = {
        toolId: 'file_read',
        toolName: 'file_read',
        args: { file_path: '/etc/passwd' },
        agentId: 'test-agent',
      };

      const criticalResult = await guardrails.validateBeforeExecution(criticalRequest);
      expect(criticalResult.violations?.[0].severity).toBe('critical');

      // High: /usr/bin
      const highRequest: GuardrailsRequest = {
        toolId: 'file_write',
        toolName: 'file_write',
        args: { file_path: '/usr/bin/test' },
        agentId: 'test-agent',
      };

      const highResult = await guardrails.validateBeforeExecution(highRequest);
      expect(highResult.violations?.[0].severity).toBe('high');

      // Medium: write operation
      const mediumRequest: GuardrailsRequest = {
        toolId: 'file_write',
        toolName: 'file_write',
        args: { file_path: '/tmp/test.txt' },
        agentId: 'test-agent',
      };

      const mediumResult = await guardrails.validateBeforeExecution(mediumRequest);
      expect(mediumResult.violations?.[0].severity).toBe('medium');
    });

    it('should use tier permissions as fallback', async () => {
      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: true,
        rules: [],
      };

      const tierPermissions = {
        read: true,
        write: false,
        delete: false,
        execute: false,
      };

      guardrails.setFolderPermissions('test-agent', folderConfig);
      guardrails.setTierPermissions('test-agent', tierPermissions);

      // Read should be allowed via tier permissions
      const readRequest: GuardrailsRequest = {
        toolId: 'file_read',
        toolName: 'file_read',
        args: { file_path: '/tmp/test.txt' },
        agentId: 'test-agent',
      };

      const readResult = await guardrails.validateBeforeExecution(readRequest);
      expect(readResult.allowed).toBe(true);

      // Write should be denied
      const writeRequest: GuardrailsRequest = {
        toolId: 'file_write',
        toolName: 'file_write',
        args: { file_path: '/tmp/test.txt' },
        agentId: 'test-agent',
      };

      const writeResult = await guardrails.validateBeforeExecution(writeRequest);
      expect(writeResult.allowed).toBe(false);
    });

    it('should handle multiple paths in request', async () => {
      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
        ],
      };

      guardrails.setFolderPermissions('test-agent', folderConfig);

      const workspacePath = path.join(os.homedir(), 'workspace/file.txt');

      // Command with both allowed and disallowed paths
      const request: GuardrailsRequest = {
        toolId: 'shell_execute',
        toolName: 'shell_execute',
        args: { command: `cp ${workspacePath} /etc/passwd` },
        agentId: 'test-agent',
      };

      const result = await guardrails.validateBeforeExecution(request);
      expect(result.allowed).toBe(false); // Should fail on /etc/passwd
      expect(result.violations?.[0].attemptedPath).toContain('/etc/passwd');
    });
  });

  describe('getViolationStats', () => {
    it('should return zero stats when no violations logged', async () => {
      const stats = await guardrails.getViolationStats('test-agent');
      expect(stats.total).toBe(0);
      expect(stats.bySeverity).toEqual({});
      expect(stats.byTool).toEqual({});
    });
  });
});
