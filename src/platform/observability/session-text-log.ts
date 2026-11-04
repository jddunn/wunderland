// @ts-nocheck
/**
 * @fileoverview Per-session text log writer for Wunderland agent runs.
 * @module wunderland/observability/session-text-log
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import type { WunderlandAgentConfig, WunderlandWorkspace } from '../../channels/api/types.js';
import { resolveAgentWorkspaceDir } from '../../runtime/tools/workspace.js';

type LoggerLike = {
  warn?: (msg: string, meta?: unknown) => void;
};

export interface WunderlandTextLogConfig {
  enabled?: boolean;
  directory?: string;
  includeToolCalls?: boolean;
}

export interface ResolvedWunderlandTextLogConfig {
  enabled: boolean;
  directory: string;
  includeToolCalls: boolean;
}

export interface WunderlandSessionLogMeta {
  agentId: string;
  seedId?: string;
  displayName?: string;
  providerId?: string;
  model?: string;
  personaId?: string;
}

export interface WunderlandSessionToolLog {
  toolName: string;
  hasSideEffects?: boolean;
  approved?: boolean;
  deniedReason?: string;
  args?: Record<string, unknown>;
  toolResult?: string;
}

export interface WunderlandSessionTurnLog {
  meta: WunderlandSessionLogMeta;
  sessionId: string;
  userText: string;
  reply?: string;
  error?: unknown;
  toolCalls?: WunderlandSessionToolLog[];
  toolCallCount?: number;
  durationMs?: number;
  fallbackTriggered?: boolean;
}

type SessionLogEvent =
  | {
      type: 'checkpoint';
      checkpointId: string;
    }
  | {
      type: 'resume';
      checkpointId: string;
    };

function parseEnvBoolean(name: string): boolean | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return undefined;
}

function resolveDirectory(input: string, workingDirectory: string): string {
  return path.isAbsolute(input) ? input : path.resolve(workingDirectory, input);
}

function toIsoDatePrefix(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * A session's log file name without `.log`: the session id cleaned as agent
 * ids are, to letters, digits, dots, dashes and underscores and at most 80
 * characters. The name is used only as `<name>.log` inside the dated folder,
 * so it is not held to the workspace folder rule: every cleaned id, dots alone
 * included, names one file there. An id that cleans to nothing names
 * `agent.log`.
 */
function sanitizeSessionLogId(raw: string): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[\\/]/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'agent';
}

function logLine(
  timestamp: number,
  kind: string,
  payload: Record<string, unknown>,
): string {
  return `${new Date(timestamp).toISOString()} ${kind} ${JSON.stringify(payload)}\n`;
}

/**
 * Where and whether an agent run writes its per-session text logs.
 *
 * @throws InvalidAgentWorkspaceIdError when the logs go to the agent's folder
 *   under the workspace base and the agent id names no safe folder there.
 */
export function resolveWunderlandTextLogConfig(opts: {
  agentConfig?: WunderlandAgentConfig;
  workingDirectory: string;
  workspace?: Partial<WunderlandWorkspace>;
  defaultAgentId?: string;
  configBacked?: boolean;
}): ResolvedWunderlandTextLogConfig {
  const textLogs = opts.agentConfig?.observability?.textLogs;
  const envEnabled =
    parseEnvBoolean('WUNDERLAND_TEXT_LOGS_ENABLED')
    ?? parseEnvBoolean('AGENTOS_TEXT_LOGS_ENABLED');

  const explicitEnabled = typeof textLogs?.enabled === 'boolean' ? textLogs.enabled : undefined;
  const enabled = envEnabled ?? explicitEnabled ?? (opts.configBacked === true);

  const envDir =
    typeof process.env['WUNDERLAND_TEXT_LOGS_DIR'] === 'string' && process.env['WUNDERLAND_TEXT_LOGS_DIR']?.trim()
      ? process.env['WUNDERLAND_TEXT_LOGS_DIR']!.trim()
      : typeof process.env['AGENTOS_TEXT_LOGS_DIR'] === 'string' && process.env['AGENTOS_TEXT_LOGS_DIR']?.trim()
        ? process.env['AGENTOS_TEXT_LOGS_DIR']!.trim()
        : undefined;

  let directory: string;
  if (typeof textLogs?.directory === 'string' && textLogs.directory.trim()) {
    directory = resolveDirectory(textLogs.directory.trim(), opts.workingDirectory);
  } else if (envDir) {
    directory = resolveDirectory(envDir, opts.workingDirectory);
  } else if (opts.configBacked === true || existsSync(path.join(opts.workingDirectory, 'agent.config.json'))) {
    directory = path.join(opts.workingDirectory, 'logs');
  } else if (opts.workspace?.agentId || opts.defaultAgentId) {
    // The agent's own folder under the workspace base, resolved as its
    // workspace is: an id that would name the base itself or the folder above
    // it (`.`, `..`) is refused instead of given a log folder.
    directory = path.join(
      resolveAgentWorkspaceDir(
        opts.defaultAgentId ?? String(opts.workspace?.agentId ?? 'agent'),
        path.resolve(
          typeof opts.workspace?.baseDir === 'string' && opts.workspace.baseDir.trim()
            ? opts.workspace.baseDir
            : opts.workingDirectory,
        ),
      ),
      'logs',
    );
  } else {
    directory = path.join(opts.workingDirectory, 'logs');
  }

  return {
    enabled,
    directory,
    includeToolCalls: textLogs?.includeToolCalls !== false,
  };
}

export class WunderlandSessionTextLogger {
  private readonly queueBySession = new Map<string, Promise<void>>();
  private readonly initializedSessions = new Set<string>();

  constructor(
    private readonly config: ResolvedWunderlandTextLogConfig,
    private readonly logger?: LoggerLike,
  ) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async logTurn(turn: WunderlandSessionTurnLog): Promise<void> {
    if (!this.config.enabled) return;
    await this.enqueue(turn.sessionId, async () => {
      const now = Date.now();
      const lines: string[] = [];
      const filePath = this.getFilePath(turn.sessionId, now);

      if (!this.initializedSessions.has(turn.sessionId)) {
        this.initializedSessions.add(turn.sessionId);
        lines.push(logLine(now, 'SESSION_START', {
          agentId: turn.meta.agentId,
          seedId: turn.meta.seedId,
          displayName: turn.meta.displayName,
          providerId: turn.meta.providerId,
          model: turn.meta.model,
          personaId: turn.meta.personaId,
          sessionId: turn.sessionId,
        }));
      }

      lines.push(logLine(now, 'USER', { content: turn.userText }));

      const toolCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
      if (this.config.includeToolCalls && toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          lines.push(logLine(now, 'TOOL', {
            toolName: toolCall.toolName,
            approved: toolCall.approved,
            hasSideEffects: toolCall.hasSideEffects,
            deniedReason: toolCall.deniedReason,
            args: toolCall.args,
            toolResult: toolCall.toolResult,
          }));
        }
      } else if ((turn.toolCallCount ?? toolCalls.length) > 0) {
        lines.push(logLine(now, 'TOOL_SUMMARY', {
          count: turn.toolCallCount ?? toolCalls.length,
        }));
      }

      if (typeof turn.reply === 'string' && turn.reply.length > 0) {
        lines.push(logLine(now, 'ASSISTANT', { content: turn.reply }));
      }

      if (turn.error !== undefined) {
        lines.push(logLine(now, 'ERROR', {
          message: turn.error instanceof Error ? turn.error.message : String(turn.error),
        }));
      }

      lines.push(logLine(now, 'TURN_END', {
        durationMs: turn.durationMs,
        toolCallCount: turn.toolCallCount ?? toolCalls.length,
        fallbackTriggered: turn.fallbackTriggered === true,
        success: turn.error === undefined,
      }));

      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await appendFile(filePath, lines.join(''), { encoding: 'utf8', mode: 0o600 });
    });
  }

  async logEvent(sessionId: string, meta: WunderlandSessionLogMeta, event: SessionLogEvent): Promise<void> {
    if (!this.config.enabled) return;
    await this.enqueue(sessionId, async () => {
      const now = Date.now();
      const lines: string[] = [];
      const filePath = this.getFilePath(sessionId, now);

      if (!this.initializedSessions.has(sessionId)) {
        this.initializedSessions.add(sessionId);
        lines.push(logLine(now, 'SESSION_START', {
          agentId: meta.agentId,
          seedId: meta.seedId,
          displayName: meta.displayName,
          providerId: meta.providerId,
          model: meta.model,
          personaId: meta.personaId,
          sessionId,
        }));
      }

      if (event.type === 'checkpoint') {
        lines.push(logLine(now, 'CHECKPOINT', { checkpointId: event.checkpointId }));
      } else {
        lines.push(logLine(now, 'RESUME', { checkpointId: event.checkpointId }));
      }

      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await appendFile(filePath, lines.join(''), { encoding: 'utf8', mode: 0o600 });
    });
  }

  private getFilePath(sessionId: string, timestamp: number): string {
    const dateDir = toIsoDatePrefix(timestamp);
    return path.join(this.config.directory, dateDir, `${sanitizeSessionLogId(sessionId)}.log`);
  }

  private async enqueue(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queueBySession.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .catch((error) => {
        this.logger?.warn?.('[wunderland] failed to write session text log', {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
          directory: this.config.directory,
        });
      });
    this.queueBySession.set(sessionId, next);
    await next;
  }
}
