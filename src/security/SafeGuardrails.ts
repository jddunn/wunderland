/**
 * @fileoverview Safe Guardrails - validates tool calls before execution
 * @module wunderland/security/SafeGuardrails
 *
 * Pre-execution validation layer that intercepts tool calls and enforces:
 * - Folder-level permissions
 * - File read/write restrictions
 * - CLI execution safety
 * - Audit logging
 * - User notifications for violations
 */

import * as path from 'node:path';
import {
  checkFolderAccess,
  expandTilde,
  type FolderPermissionConfig,
} from './FolderPermissions.js';
import type { GranularPermissions } from './SecurityTiers.js';
import { AuditLogger } from './AuditLogger.js';
import { NotificationManager } from './NotificationManager.js';

// ITool interface for type hints (optional, not strictly required)
interface ITool {
  id: string;
  name: string;
  description?: string;
  category?: string;
  hasSideEffects?: boolean;
  [key: string]: unknown;
}

/**
 * Guardrails validation request
 */
export interface GuardrailsRequest {
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  userId?: string;
  sessionId?: string;
  tool?: ITool; // Full tool metadata
}

/**
 * Guardrails validation result
 */
export interface GuardrailsResult {
  allowed: boolean;
  reason?: string;
  violations?: PermissionViolation[];
  sanitizedArgs?: Record<string, unknown>; // Optional: modified args that would be allowed
}

/**
 * Permission violation record
 */
export interface PermissionViolation {
  timestamp: Date;
  agentId: string;
  userId?: string;
  toolId: string;
  operation: string; // 'file_read', 'file_write', 'shell_execute'
  attemptedPath?: string;
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Safe Guardrails configuration
 */
export interface SafeGuardrailsConfig {
  /** Path to audit log file */
  auditLogPath?: string;

  /** Webhook URLs for notifications */
  notificationWebhooks?: string[];

  /** Email configuration for notifications */
  emailConfig?: {
    to: string;
    from?: string;
    smtpHost?: string;
    smtpPort?: number;
  };

  /** Enable audit logging (default: true) */
  enableAuditLogging?: boolean;

  /** Enable notifications (default: true for high/critical) */
  enableNotifications?: boolean;
}

/**
 * Tool ID to path argument mapping
 * Maps tool IDs to the argument keys that contain file paths
 */
const TOOL_PATH_ARGUMENTS: Record<string, string[]> = {
  file_read: ['file_path', 'path', 'filePath'],
  file_write: ['file_path', 'path', 'destination', 'filePath'],
  list_directory: ['directory', 'path', 'dir'],
  // shell_execute is handled specially (parse command tokens for paths).
  shell_execute: [],

  // Extension tools
  git_clone: ['target_directory', 'destination', 'targetDirectory'],
  obsidian_read: ['file_path', 'path', 'filePath'],
  obsidian_write: ['file_path', 'path', 'filePath'],
  apple_notes_save: ['export_path', 'exportPath'],
  apple_notes_export: ['export_path', 'exportPath'],
  file_append: ['file_path', 'path', 'filePath'],
  file_delete: ['file_path', 'path', 'filePath'],
};

/**
 * Filesystem tool IDs
 */
const FILESYSTEM_TOOLS = new Set([
  'file_read',
  'file_write',
  'file_append',
  'file_delete',
  'list_directory',
  'shell_execute',
  'git_clone',
  'obsidian_read',
  'obsidian_write',
  'apple_notes_save',
  'apple_notes_export',
]);

/**
 * Safe Guardrails - validates tool calls before execution
 */
export class SafeGuardrails {
  private folderPermissions: Map<string, FolderPermissionConfig>;
  private tierPermissions: Map<string, GranularPermissions['filesystem']>;
  private auditLogger?: AuditLogger;
  private notificationManager?: NotificationManager;
  private config: SafeGuardrailsConfig;

  constructor(config: SafeGuardrailsConfig = {}) {
    this.folderPermissions = new Map();
    this.tierPermissions = new Map();
    this.config = {
      enableAuditLogging: true,
      enableNotifications: true,
      ...config,
    };

    // Initialize audit logger
    if (this.config.enableAuditLogging) {
      this.auditLogger = new AuditLogger({
        logFilePath: this.config.auditLogPath,
      });
    }

    // Initialize notification manager
    if (this.config.enableNotifications) {
      this.notificationManager = new NotificationManager({
        webhooks: this.config.notificationWebhooks || [],
        emailConfig: this.config.emailConfig,
      });
    }
  }

  /**
   * Set folder permissions for an agent
   */
  setFolderPermissions(agentId: string, config: FolderPermissionConfig): void {
    this.folderPermissions.set(agentId, config);
  }

  /**
   * Set security tier permissions for an agent
   */
  setTierPermissions(agentId: string, permissions: GranularPermissions['filesystem']): void {
    this.tierPermissions.set(agentId, permissions);
  }

  /**
   * Validate tool call before execution
   * Returns validation result with allow/deny + reason
   */
  async validateBeforeExecution(request: GuardrailsRequest): Promise<GuardrailsResult> {
    // 1. Get agent's folder permissions
    const folderConfig = this.folderPermissions.get(request.agentId);
    if (!folderConfig) {
      // No folder restrictions configured - allow by default
      return { allowed: true };
    }

    // 2. Check if tool requires filesystem access
    if (!this.isFilesystemTool(request.toolId)) {
      // Not a filesystem tool, skip validation
      return { allowed: true };
    }

    // 3. Extract file paths from arguments
    const paths = this.extractFilePaths(request.toolId, request.args);
    if (paths.length === 0) {
      // No paths found - allow (may be a safe command)
      return { allowed: true };
    }

    // 4. Determine operation type (read vs write)
    const operation = this.getOperation(request.toolId, request.args);

    // 5. Get tier permissions for fallback
    const tierPermissions = this.tierPermissions.get(request.agentId);

    // 6. Validate each path
    const violations: PermissionViolation[] = [];

    for (const filepath of paths) {
      const result = checkFolderAccess(filepath, operation, folderConfig, tierPermissions);

      if (!result.allowed) {
        // VIOLATION DETECTED
        const violation: PermissionViolation = {
          timestamp: new Date(),
          agentId: request.agentId,
          userId: request.userId,
          toolId: request.toolId,
          operation: request.toolName,
          attemptedPath: filepath,
          reason: result.reason || 'Access denied',
          severity: this.assessSeverity(filepath, operation, request.toolId),
        };

        violations.push(violation);

        // Log violation
        if (this.auditLogger) {
          await this.logViolation(violation);
        }

        // Notify if severity high/critical
        if (
          this.notificationManager &&
          (violation.severity === 'high' || violation.severity === 'critical')
        ) {
          await this.notifyViolation(violation);
        }
      }
    }

    // 7. Return result
    if (violations.length > 0) {
      const firstViolation = violations[0];
      return {
        allowed: false,
        reason: `Folder access denied: ${firstViolation.reason}`,
        violations,
      };
    }

    // All paths validated successfully
    return { allowed: true };
  }

  /**
   * Check if tool requires filesystem access
   */
  private isFilesystemTool(toolId: string): boolean {
    return FILESYSTEM_TOOLS.has(toolId);
  }

  /**
   * Extract file paths from tool arguments
   */
  private extractFilePaths(toolId: string, args: Record<string, unknown>): string[] {
    const pathKeys = TOOL_PATH_ARGUMENTS[toolId] || [];
    const paths: string[] = [];

    for (const key of pathKeys) {
      const value = args[key];
      if (typeof value === 'string') {
        paths.push(value);
      }
    }

    // Special case: shell_execute - parse command for file paths
    if (toolId === 'shell_execute' && typeof args.command === 'string') {
      const extractedPaths = this.extractPathsFromShellCommand(args.command);
      paths.push(...extractedPaths);
    }

    const normalized = paths
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .filter(Boolean)
      .map((p) => path.resolve(expandTilde(p)));

    // Deduplicate
    return Array.from(new Set(normalized));
  }

  /**
   * Extract file paths from shell command
   *
   * Detects common patterns:
   * - rm /path/to/file
   * - cp /src /dst
   * - mv /old /new
   * - cat /file
   * - touch /file
   */
  private extractPathsFromShellCommand(command: string): string[] {
    const paths: string[] = [];

    // Split command into tokens
    const tokens = command.split(/\s+/);

    // File operation commands
    const fileOps = new Set(['rm', 'cp', 'mv', 'cat', 'touch', 'mkdir', 'rmdir', 'chmod', 'chown']);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      // Check if this is a file operation command
      if (fileOps.has(token)) {
        // Next token(s) are likely paths
        for (let j = i + 1; j < tokens.length && j < i + 3; j++) {
          const potentialPath = tokens[j];

          // Skip flags
          if (potentialPath.startsWith('-')) continue;

          // Check if it looks like a path
          if (
            potentialPath.startsWith('/') ||
            potentialPath.startsWith('~/') ||
            potentialPath.startsWith('./') ||
            potentialPath.startsWith('../')
          ) {
            paths.push(potentialPath);
          }
        }
      }
    }

    return paths;
  }

  /**
   * Determine operation type from tool ID and args
   */
  private getOperation(toolId: string, args: Record<string, unknown>): 'read' | 'write' {
    // Read operations
    if (toolId === 'file_read' || toolId === 'list_directory' || toolId === 'obsidian_read') {
      return 'read';
    }

    // Write operations
    if (
      toolId === 'file_write' ||
      toolId === 'file_append' ||
      toolId === 'file_delete' ||
      toolId === 'obsidian_write' ||
      toolId === 'apple_notes_save'
    ) {
      return 'write';
    }

    // Shell execute: parse command to determine operation
    if (toolId === 'shell_execute' && typeof args.command === 'string') {
      const cmd = args.command.trim().toLowerCase();

      // Write operations
      if (
        cmd.startsWith('rm ') ||
        cmd.startsWith('mv ') ||
        cmd.startsWith('cp ') ||
        cmd.startsWith('touch ') ||
        cmd.startsWith('mkdir ') ||
        cmd.startsWith('echo ') ||
        cmd.includes('>') // Redirection
      ) {
        return 'write';
      }

      // Default to read for shell commands
      return 'read';
    }

    // Default: write (safer to assume write)
    return 'write';
  }

  /**
   * Assess severity of violation
   */
  private assessSeverity(
    filepath: string,
    operation: 'read' | 'write',
    toolId: string
  ): 'low' | 'medium' | 'high' | 'critical' {
    const lowerPath = filepath.toLowerCase();

    // Critical: System-critical paths
    if (
      lowerPath.startsWith('/etc') ||
      lowerPath.startsWith('/root') ||
      lowerPath.startsWith('/boot') ||
      lowerPath === '/' ||
      lowerPath.includes('passwd') ||
      lowerPath.includes('shadow')
    ) {
      return 'critical';
    }

    // High: System paths or sensitive data
    if (
      lowerPath.startsWith('/usr') ||
      lowerPath.startsWith('/var') ||
      lowerPath.startsWith('/sys') ||
      lowerPath.startsWith('/proc') ||
      lowerPath.includes('.ssh') ||
      lowerPath.includes('.aws') ||
      lowerPath.includes('credentials') ||
      lowerPath.includes('secrets')
    ) {
      return 'high';
    }

    // High: Write operations anywhere (potentially destructive)
    if (operation === 'write' && toolId === 'file_delete') {
      return 'high';
    }

    // Medium: Write operations
    if (operation === 'write') {
      return 'medium';
    }

    // Low: Read operations
    return 'low';
  }

  /**
   * Log violation to audit trail
   */
  private async logViolation(violation: PermissionViolation): Promise<void> {
    if (!this.auditLogger) return;

    try {
      await this.auditLogger.logViolation(violation);
    } catch (err) {
      console.error('Failed to log violation:', err);
    }
  }

  /**
   * Send notification for violation
   */
  private async notifyViolation(violation: PermissionViolation): Promise<void> {
    if (!this.notificationManager) return;

    try {
      await this.notificationManager.notify(violation);
    } catch (err) {
      console.error('Failed to send notification:', err);
    }
  }

  /**
   * Get violation statistics for an agent
   */
  async getViolationStats(agentId: string, timeRange?: { start: Date; end: Date }): Promise<{
    total: number;
    bySeverity: Record<string, number>;
    byTool: Record<string, number>;
  }> {
    if (!this.auditLogger) {
      return { total: 0, bySeverity: {}, byTool: {} };
    }

    const violations = await this.auditLogger.queryViolations({
      agentId,
      startTime: timeRange?.start,
      endTime: timeRange?.end,
    });

    const bySeverity: Record<string, number> = {};
    const byTool: Record<string, number> = {};

    for (const v of violations) {
      bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1;
      byTool[v.toolId] = (byTool[v.toolId] || 0) + 1;
    }

    return {
      total: violations.length,
      bySeverity,
      byTool,
    };
  }
}
