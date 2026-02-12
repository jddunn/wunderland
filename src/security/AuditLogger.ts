/**
 * @fileoverview Audit logger for permission violations
 * @module wunderland/security/AuditLogger
 *
 * Provides structured logging of permission violations:
 * - JSON lines format for easy parsing
 * - Automatic log rotation
 * - Query interface for violation analysis
 * - Statistics aggregation
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { PermissionViolation } from './SafeGuardrails.js';

/**
 * Violation filter for queries
 */
export interface ViolationFilter {
  agentId?: string;
  userId?: string;
  toolId?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  startTime?: Date;
  endTime?: Date;
  limit?: number;
}

/**
 * Violation statistics
 */
export interface ViolationStats {
  total: number;
  bySeverity: Record<string, number>;
  byAgent: Record<string, number>;
  byTool: Record<string, number>;
  byHour: Record<string, number>;
}

/**
 * Audit logger configuration
 */
export interface AuditLoggerConfig {
  /** Path to log file (default: ~/.wunderland/security/violations.log) */
  logFilePath?: string;

  /** Max log file size in bytes before rotation (default: 10MB) */
  rotationSize?: number;

  /** Max number of rotated log files to keep (default: 5) */
  maxRotatedFiles?: number;
}

/**
 * Audit logger for permission violations
 */
export class AuditLogger {
  private logFile: string;
  private rotationSize: number;
  private maxRotatedFiles: number;

  constructor(config: AuditLoggerConfig = {}) {
    this.logFile =
      config.logFilePath ||
      path.join(os.homedir(), '.wunderland', 'security', 'violations.log');
    this.rotationSize = config.rotationSize || 10 * 1024 * 1024; // 10MB
    this.maxRotatedFiles = config.maxRotatedFiles || 5;
  }

  /**
   * Log permission violation to file
   */
  async logViolation(violation: PermissionViolation): Promise<void> {
    // Ensure log directory exists
    await fs.mkdir(path.dirname(this.logFile), { recursive: true });

    // Format as JSON line
    const logEntry = JSON.stringify({
      timestamp: violation.timestamp.toISOString(),
      level: 'SECURITY_VIOLATION',
      agentId: violation.agentId,
      userId: violation.userId,
      toolId: violation.toolId,
      operation: violation.operation,
      attemptedPath: violation.attemptedPath,
      reason: violation.reason,
      severity: violation.severity,
    });

    // Append to log file
    await fs.appendFile(this.logFile, logEntry + '\n', 'utf8');

    // Check if rotation is needed
    await this.checkRotation();
  }

  /**
   * Check if log rotation is needed and perform it
   */
  private async checkRotation(): Promise<void> {
    try {
      const stats = await fs.stat(this.logFile);

      if (stats.size >= this.rotationSize) {
        await this.rotateLog();
      }
    } catch (err) {
      // File doesn't exist yet, no rotation needed
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error checking log rotation:', err);
      }
    }
  }

  /**
   * Rotate log files
   *
   * violations.log → violations.log.1
   * violations.log.1 → violations.log.2
   * ...
   * violations.log.5 → deleted
   */
  private async rotateLog(): Promise<void> {
    // Delete oldest log if it exists
    const oldestLog = `${this.logFile}.${this.maxRotatedFiles}`;
    try {
      await fs.unlink(oldestLog);
    } catch (err) {
      // File might not exist, ignore
    }

    // Shift all log files
    for (let i = this.maxRotatedFiles - 1; i >= 1; i--) {
      const currentLog = `${this.logFile}.${i}`;
      const nextLog = `${this.logFile}.${i + 1}`;

      try {
        await fs.rename(currentLog, nextLog);
      } catch (err) {
        // File might not exist, ignore
      }
    }

    // Rename current log to .1
    try {
      await fs.rename(this.logFile, `${this.logFile}.1`);
    } catch (err) {
      console.error('Error rotating log file:', err);
    }
  }

  /**
   * Query violations from log file
   */
  async queryViolations(filter: ViolationFilter = {}): Promise<PermissionViolation[]> {
    const violations: PermissionViolation[] = [];

    // Read current log file
    try {
      const content = await fs.readFile(this.logFile, 'utf8');
      const lines = content.trim().split('\n');

      for (const line of lines) {
        if (!line) continue;

        try {
          const entry = JSON.parse(line);

          // Parse back to PermissionViolation
          const violation: PermissionViolation = {
            timestamp: new Date(entry.timestamp),
            agentId: entry.agentId,
            userId: entry.userId,
            toolId: entry.toolId,
            operation: entry.operation,
            attemptedPath: entry.attemptedPath,
            reason: entry.reason,
            severity: entry.severity,
          };

          // Apply filters
          if (filter.agentId && violation.agentId !== filter.agentId) continue;
          if (filter.userId && violation.userId !== filter.userId) continue;
          if (filter.toolId && violation.toolId !== filter.toolId) continue;
          if (filter.severity && violation.severity !== filter.severity) continue;
          if (filter.startTime && violation.timestamp < filter.startTime) continue;
          if (filter.endTime && violation.timestamp > filter.endTime) continue;

          violations.push(violation);
        } catch (parseErr) {
          // Skip malformed lines
          console.warn('Skipping malformed log line:', line);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error reading log file:', err);
      }
    }

    // Also read rotated logs if needed
    if (!filter.limit || violations.length < filter.limit) {
      for (let i = 1; i <= this.maxRotatedFiles; i++) {
        if (filter.limit && violations.length >= filter.limit) break;

        const rotatedLog = `${this.logFile}.${i}`;
        try {
          const content = await fs.readFile(rotatedLog, 'utf8');
          const lines = content.trim().split('\n');

          for (const line of lines) {
            if (!line) continue;
            if (filter.limit && violations.length >= filter.limit) break;

            try {
              const entry = JSON.parse(line);

              const violation: PermissionViolation = {
                timestamp: new Date(entry.timestamp),
                agentId: entry.agentId,
                userId: entry.userId,
                toolId: entry.toolId,
                operation: entry.operation,
                attemptedPath: entry.attemptedPath,
                reason: entry.reason,
                severity: entry.severity,
              };

              // Apply filters
              if (filter.agentId && violation.agentId !== filter.agentId) continue;
              if (filter.userId && violation.userId !== filter.userId) continue;
              if (filter.toolId && violation.toolId !== filter.toolId) continue;
              if (filter.severity && violation.severity !== filter.severity) continue;
              if (filter.startTime && violation.timestamp < filter.startTime) continue;
              if (filter.endTime && violation.timestamp > filter.endTime) continue;

              violations.push(violation);
            } catch (parseErr) {
              // Skip malformed lines
            }
          }
        } catch (err) {
          // Rotated log might not exist, ignore
        }
      }
    }

    // Sort by timestamp descending (most recent first)
    violations.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Apply limit
    if (filter.limit && violations.length > filter.limit) {
      return violations.slice(0, filter.limit);
    }

    return violations;
  }

  /**
   * Get violation statistics
   */
  async getStats(timeRange?: { start: Date; end: Date }): Promise<ViolationStats> {
    const violations = await this.queryViolations({
      startTime: timeRange?.start,
      endTime: timeRange?.end,
    });

    const stats: ViolationStats = {
      total: violations.length,
      bySeverity: {},
      byAgent: {},
      byTool: {},
      byHour: {},
    };

    for (const v of violations) {
      // By severity
      stats.bySeverity[v.severity] = (stats.bySeverity[v.severity] || 0) + 1;

      // By agent
      stats.byAgent[v.agentId] = (stats.byAgent[v.agentId] || 0) + 1;

      // By tool
      stats.byTool[v.toolId] = (stats.byTool[v.toolId] || 0) + 1;

      // By hour
      const hour = v.timestamp.toISOString().slice(0, 13); // YYYY-MM-DDTHH
      stats.byHour[hour] = (stats.byHour[hour] || 0) + 1;
    }

    return stats;
  }

  /**
   * Clear all logs (use with caution!)
   */
  async clearLogs(): Promise<void> {
    // Delete main log
    try {
      await fs.unlink(this.logFile);
    } catch (err) {
      // Ignore if doesn't exist
    }

    // Delete rotated logs
    for (let i = 1; i <= this.maxRotatedFiles; i++) {
      try {
        await fs.unlink(`${this.logFile}.${i}`);
      } catch (err) {
        // Ignore if doesn't exist
      }
    }
  }

  /**
   * Export logs to JSON file
   */
  async exportLogs(outputPath: string, filter: ViolationFilter = {}): Promise<void> {
    const violations = await this.queryViolations(filter);

    await fs.writeFile(outputPath, JSON.stringify(violations, null, 2), 'utf8');
  }
}
