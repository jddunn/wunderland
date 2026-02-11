/**
 * @fileoverview Integration tests for Safe Guardrails system
 * @module wunderland/__tests__/guardrails-integration.e2e
 *
 * Tests the complete guardrails flow:
 * 1. Tool call request
 * 2. Guardrails validation
 * 3. Folder permission check
 * 4. Allow/deny decision
 * 5. Audit logging
 * 6. Violation notifications
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SafeGuardrails } from '../security/SafeGuardrails.js';
import type { FolderPermissionConfig } from '../security/FolderPermissions.js';
import { AuditLogger } from '../security/AuditLogger.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_LOG_DIR = path.join(os.tmpdir(), '.test-wunderland-guardrails');
const TEST_LOG_FILE = path.join(TEST_LOG_DIR, 'violations.log');

describe('Guardrails Integration E2E', () => {
  let guardrails: SafeGuardrails;
  let auditLogger: AuditLogger;

  beforeEach(async () => {
    // Create test directory
    await fs.mkdir(TEST_LOG_DIR, { recursive: true });

    // Initialize guardrails with test audit log
    guardrails = new SafeGuardrails({
      auditLogPath: TEST_LOG_FILE,
      enableAuditLogging: true,
      enableNotifications: false, // Disable notifications for tests
    });

    auditLogger = new AuditLogger({
      logFilePath: TEST_LOG_FILE,
    });
  });

  afterEach(async () => {
    // Cleanup test directory
    try {
      await fs.rm(TEST_LOG_DIR, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  describe('Full Flow: Tool Call → Guardrails → Execution', () => {
    it('should allow file_read when path is permitted', async () => {
      // Setup: Agent with workspace-only permissions
      const agentId = 'test-agent-allowed';
      const workspacePath = path.join(os.homedir(), 'workspace/data.txt');

      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
        ],
      };

      guardrails.setFolderPermissions(agentId, folderConfig);

      // Act: Validate file_read request
      const result = await guardrails.validateBeforeExecution({
        toolId: 'file_read',
        toolName: 'file_read',
        args: { file_path: workspacePath },
        agentId,
        userId: 'user-123',
        sessionId: 'session-abc',
      });

      // Assert: Should be allowed
      expect(result.allowed).toBe(true);
      expect(result.violations).toBeUndefined();

      // Verify: No violations logged
      const violations = await auditLogger.queryViolations({ agentId });
      expect(violations.length).toBe(0);
    });

    it('should block file_write when path is denied', async () => {
      // Setup: Agent with workspace-only permissions
      const agentId = 'test-agent-blocked';
      const blockedPath = '/etc/passwd';

      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
        ],
      };

      guardrails.setFolderPermissions(agentId, folderConfig);

      // Act: Validate file_write request to /etc/passwd
      const result = await guardrails.validateBeforeExecution({
        toolId: 'file_write',
        toolName: 'file_write',
        args: { file_path: blockedPath, content: 'malicious' },
        agentId,
        userId: 'user-123',
        sessionId: 'session-abc',
      });

      // Assert: Should be denied
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Folder access denied');
      expect(result.violations).toBeDefined();
      expect(result.violations!.length).toBe(1);

      const violation = result.violations![0];
      expect(violation.agentId).toBe(agentId);
      expect(violation.toolId).toBe('file_write');
      expect(violation.attemptedPath).toContain('/etc/passwd');
      expect(violation.severity).toBe('critical');

      // Verify: Violation was logged to audit log
      const violations = await auditLogger.queryViolations({ agentId });
      expect(violations.length).toBe(1);
      expect(violations[0].attemptedPath).toContain('/etc/passwd');
      expect(violations[0].severity).toBe('critical');
    });

    it('should extract paths from shell_execute commands', async () => {
      // Setup: Agent with restricted permissions
      const agentId = 'test-agent-shell';

      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
        ],
      };

      guardrails.setFolderPermissions(agentId, folderConfig);

      // Act: Validate shell command that tries to rm /etc
      const result = await guardrails.validateBeforeExecution({
        toolId: 'shell_execute',
        toolName: 'shell_execute',
        args: { command: 'rm -rf /etc/config' },
        agentId,
      });

      // Assert: Should be blocked
      expect(result.allowed).toBe(false);
      expect(result.violations).toBeDefined();
      expect(result.violations![0].attemptedPath).toContain('/etc/config');

      // Verify: High severity for /etc access
      expect(result.violations![0].severity).toBe('critical');
    });

    it('should allow shell_execute with permitted paths', async () => {
      // Setup: Agent with workspace permissions
      const agentId = 'test-agent-shell-allowed';
      const workspacePath = path.join(os.homedir(), 'workspace');

      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
        ],
      };

      guardrails.setFolderPermissions(agentId, folderConfig);

      // Act: Validate shell command in workspace
      const result = await guardrails.validateBeforeExecution({
        toolId: 'shell_execute',
        toolName: 'shell_execute',
        args: { command: `cat ${workspacePath}/file.txt` },
        agentId,
      });

      // Assert: Should be allowed
      expect(result.allowed).toBe(true);
    });

    it('should respect read-only folder permissions', async () => {
      // Setup: Agent with read-only /var/log access
      const agentId = 'test-agent-readonly';

      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '/var/log/**', read: true, write: false, description: 'Read-only logs' },
        ],
      };

      guardrails.setFolderPermissions(agentId, folderConfig);

      // Act 1: Read should be allowed
      const readResult = await guardrails.validateBeforeExecution({
        toolId: 'file_read',
        toolName: 'file_read',
        args: { file_path: '/var/log/system.log' },
        agentId,
      });

      expect(readResult.allowed).toBe(true);

      // Act 2: Write should be denied
      const writeResult = await guardrails.validateBeforeExecution({
        toolId: 'file_write',
        toolName: 'file_write',
        args: { file_path: '/var/log/system.log', content: 'test' },
        agentId,
      });

      expect(writeResult.allowed).toBe(false);
      expect(writeResult.violations![0].severity).toBe('high');
    });

    it('should inherit from security tier permissions', async () => {
      // Setup: Agent with tier fallback enabled
      const agentId = 'test-agent-tier-fallback';

      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: true, // Enable tier inheritance
        rules: [], // No specific rules
      };

      const tierPermissions = {
        read: true,
        write: false,
        delete: false,
        execute: false,
      };

      guardrails.setFolderPermissions(agentId, folderConfig);
      guardrails.setTierPermissions(agentId, tierPermissions);

      // Act 1: Read should inherit tier permission (allowed)
      const readResult = await guardrails.validateBeforeExecution({
        toolId: 'file_read',
        toolName: 'file_read',
        args: { file_path: '/tmp/test.txt' },
        agentId,
      });

      expect(readResult.allowed).toBe(true);

      // Act 2: Write should inherit tier permission (denied)
      const writeResult = await guardrails.validateBeforeExecution({
        toolId: 'file_write',
        toolName: 'file_write',
        args: { file_path: '/tmp/test.txt' },
        agentId,
      });

      expect(writeResult.allowed).toBe(false);
    });

    it('should handle multiple paths in a single command', async () => {
      // Setup: Agent with mixed permissions
      const agentId = 'test-agent-multi-path';
      const workspacePath = path.join(os.homedir(), 'workspace/file.txt');

      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [
          { pattern: '~/workspace/**', read: true, write: true },
        ],
      };

      guardrails.setFolderPermissions(agentId, folderConfig);

      // Act: Shell command with both allowed and denied paths
      const result = await guardrails.validateBeforeExecution({
        toolId: 'shell_execute',
        toolName: 'shell_execute',
        args: { command: `cp ${workspacePath} /etc/passwd` },
        agentId,
      });

      // Assert: Should be denied (fails on first denied path)
      expect(result.allowed).toBe(false);
      expect(result.violations![0].attemptedPath).toContain('/etc/passwd');
    });

    it('should log violations with correct severity levels', async () => {
      // Setup: Agent with no permissions
      const agentId = 'test-agent-severity';

      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [],
      };

      guardrails.setFolderPermissions(agentId, folderConfig);

      // Test critical severity (/etc/passwd)
      await guardrails.validateBeforeExecution({
        toolId: 'file_read',
        toolName: 'file_read',
        args: { file_path: '/etc/passwd' },
        agentId,
      });

      // Test high severity (/usr/bin)
      await guardrails.validateBeforeExecution({
        toolId: 'file_write',
        toolName: 'file_write',
        args: { file_path: '/usr/bin/test' },
        agentId,
      });

      // Test medium severity (write to /tmp)
      await guardrails.validateBeforeExecution({
        toolId: 'file_write',
        toolName: 'file_write',
        args: { file_path: '/tmp/test.txt' },
        agentId,
      });

      // Verify: Check logged violations
      const violations = await auditLogger.queryViolations({ agentId });
      expect(violations.length).toBe(3);

      const criticalViolation = violations.find((v) => v.attemptedPath?.includes('passwd'));
      expect(criticalViolation?.severity).toBe('critical');

      const highViolation = violations.find((v) => v.attemptedPath?.includes('/usr/bin'));
      expect(highViolation?.severity).toBe('high');

      const mediumViolation = violations.find((v) => v.attemptedPath?.includes('/tmp'));
      expect(mediumViolation?.severity).toBe('medium');
    });

    it('should track violation statistics', async () => {
      // Setup: Agent with no permissions
      const agentId = 'test-agent-stats';

      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [],
      };

      guardrails.setFolderPermissions(agentId, folderConfig);

      // Generate multiple violations
      await guardrails.validateBeforeExecution({
        toolId: 'file_write',
        toolName: 'file_write',
        args: { file_path: '/etc/passwd' },
        agentId,
      });

      await guardrails.validateBeforeExecution({
        toolId: 'file_read',
        toolName: 'file_read',
        args: { file_path: '/usr/bin/test' },
        agentId,
      });

      await guardrails.validateBeforeExecution({
        toolId: 'shell_execute',
        toolName: 'shell_execute',
        args: { command: 'rm -rf /' },
        agentId,
      });

      // Get stats
      const stats = await guardrails.getViolationStats(agentId);

      expect(stats.total).toBe(3);
      expect(stats.bySeverity.critical).toBeGreaterThan(0);
      expect(stats.byTool.file_write).toBe(1);
      expect(stats.byTool.file_read).toBe(1);
      expect(stats.byTool.shell_execute).toBe(1);
    });
  });

  describe('Audit Log Rotation', () => {
    it('should rotate logs when size exceeds limit', async () => {
      const smallRotationLogger = new AuditLogger({
        logFilePath: TEST_LOG_FILE,
        rotationSize: 500, // 500 bytes (very small for testing)
        maxRotatedFiles: 3,
      });

      // Generate many violations to trigger rotation
      for (let i = 0; i < 20; i++) {
        await smallRotationLogger.logViolation({
          timestamp: new Date(),
          agentId: `agent-${i}`,
          toolId: 'file_write',
          operation: 'file_write',
          attemptedPath: `/etc/passwd-${i}`,
          reason: 'Test violation for rotation',
          severity: 'critical',
        });
      }

      // Verify: Rotated log files should exist
      const rotatedLog1 = `${TEST_LOG_FILE}.1`;
      const rotatedLog2 = `${TEST_LOG_FILE}.2`;

      const log1Exists = await fs
        .access(rotatedLog1)
        .then(() => true)
        .catch(() => false);
      const log2Exists = await fs
        .access(rotatedLog2)
        .then(() => true)
        .catch(() => false);

      expect(log1Exists || log2Exists).toBe(true);
    });
  });

  describe('Query and Statistics', () => {
    it('should query violations by time range', async () => {
      const agentId = 'test-agent-timerange';

      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [],
      };

      guardrails.setFolderPermissions(agentId, folderConfig);

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      // Generate violation
      await guardrails.validateBeforeExecution({
        toolId: 'file_write',
        toolName: 'file_write',
        args: { file_path: '/etc/passwd' },
        agentId,
      });

      const now = new Date();

      // Query: Recent violations (should include our violation)
      const recentViolations = await auditLogger.queryViolations({
        agentId,
        startTime: oneHourAgo,
        endTime: now,
      });

      expect(recentViolations.length).toBeGreaterThan(0);

      // Query: Old violations (should be empty)
      const oldViolations = await auditLogger.queryViolations({
        agentId,
        startTime: new Date('2020-01-01'),
        endTime: oneHourAgo,
      });

      expect(oldViolations.length).toBe(0);
    });

    it('should aggregate statistics by severity', async () => {
      const agentId = 'test-agent-aggregate';

      const folderConfig: FolderPermissionConfig = {
        defaultPolicy: 'deny',
        inheritFromTier: false,
        rules: [],
      };

      guardrails.setFolderPermissions(agentId, folderConfig);

      // Generate violations of different severities
      await guardrails.validateBeforeExecution({
        toolId: 'file_write',
        toolName: 'file_write',
        args: { file_path: '/etc/passwd' },
        agentId,
      }); // Critical

      await guardrails.validateBeforeExecution({
        toolId: 'file_write',
        toolName: 'file_write',
        args: { file_path: '/usr/bin/test' },
        agentId,
      }); // High

      await guardrails.validateBeforeExecution({
        toolId: 'file_read',
        toolName: 'file_read',
        args: { file_path: '/tmp/test.txt' },
        agentId,
      }); // Low

      // Get stats
      const stats = await auditLogger.getStats();

      expect(stats.total).toBe(3);
      expect(stats.bySeverity.critical).toBe(1);
      expect(stats.bySeverity.high).toBe(1);
      expect(stats.bySeverity.low).toBe(1);
    });
  });
});
