/**
 * @fileoverview `wunderland export-session` — export current chat session to a file.
 *
 * Export current session to JSON or Markdown file.
 * Usage: wunderland export-session [--format json|md] [--output path]
 *
 * @module wunderland/cli/commands/export-session
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, dim, muted } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadConfig } from '../config/config-manager.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../config/workspace.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Supported export formats. */
type ExportFormat = 'json' | 'md';

/** Metadata included in session exports. */
interface SessionMetadata {
  /** Agent display name */
  agentName: string;
  /** Agent seed ID */
  seedId: string;
  /** Export timestamp (ISO 8601) */
  exportedAt: string;
  /** LLM model used in this session */
  model: string;
  /** LLM provider */
  provider: string;
  /** Session start time (if determinable) */
  sessionStartedAt: string | null;
  /** Session duration in human-readable form */
  sessionDuration: string | null;
  /** Total number of messages */
  messageCount: number;
  /** Export format */
  format: ExportFormat;
}

/** A single message in the session history. */
interface SessionMessage {
  role: string;
  content: string;
  timestamp?: string;
}

/** Full structured session export. */
interface SessionExport {
  metadata: SessionMetadata;
  messages: SessionMessage[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a default output filename with timestamp.
 */
function defaultOutputPath(format: ExportFormat): string {
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const ext = format === 'md' ? 'md' : 'json';
  return path.resolve(process.cwd(), `session-export-${ts}.${ext}`);
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 0) return 'unknown';
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60_000) % 60;
  const hours = Math.floor(ms / 3_600_000);

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

/**
 * Try to discover session history from the agent workspace directory.
 * Looks for JSON files containing message arrays in the workspace.
 */
async function discoverSessionMessages(workspaceDir: string): Promise<SessionMessage[]> {
  const messages: SessionMessage[] = [];

  // Check common session file locations
  const candidates = [
    path.join(workspaceDir, 'session.json'),
    path.join(workspaceDir, 'history.json'),
    path.join(workspaceDir, 'chat-history.json'),
    path.join(workspaceDir, 'messages.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(await readFile(candidate, 'utf8'));
        const msgs = Array.isArray(raw) ? raw : (Array.isArray(raw?.messages) ? raw.messages : null);
        if (msgs && msgs.length > 0) {
          for (const m of msgs) {
            if (m && typeof m.role === 'string' && typeof m.content === 'string') {
              messages.push({
                role: m.role,
                content: m.content,
                ...(m.timestamp ? { timestamp: String(m.timestamp) } : {}),
              });
            }
          }
          return messages;
        }
      } catch {
        // Not valid JSON or wrong structure — continue
      }
    }
  }

  // Fallback: scan workspace exports/ directory for the most recent session file
  const exportsDir = path.join(workspaceDir, 'exports');
  if (existsSync(exportsDir)) {
    try {
      const files = (await readdir(exportsDir))
        .filter((f) => f.endsWith('.json') && f.includes('session'))
        .sort()
        .reverse();

      for (const file of files.slice(0, 3)) {
        try {
          const raw = JSON.parse(await readFile(path.join(exportsDir, file), 'utf8'));
          const msgs = Array.isArray(raw) ? raw : (Array.isArray(raw?.messages) ? raw.messages : null);
          if (msgs && msgs.length > 0) {
            for (const m of msgs) {
              if (m && typeof m.role === 'string' && typeof m.content === 'string') {
                messages.push({
                  role: m.role,
                  content: m.content,
                  ...(m.timestamp ? { timestamp: String(m.timestamp) } : {}),
                });
              }
            }
            return messages;
          }
        } catch {
          // skip
        }
      }
    } catch {
      // directory read failed
    }
  }

  return messages;
}

/**
 * Render a session export as Markdown.
 */
function renderMarkdown(data: SessionExport): string {
  const lines: string[] = [];

  lines.push(`# Session Export`);
  lines.push('');
  lines.push(`**Agent:** ${data.metadata.agentName}`);
  lines.push(`**Seed ID:** ${data.metadata.seedId}`);
  lines.push(`**Model:** ${data.metadata.model}`);
  lines.push(`**Provider:** ${data.metadata.provider}`);
  lines.push(`**Exported:** ${data.metadata.exportedAt}`);
  if (data.metadata.sessionStartedAt) {
    lines.push(`**Session Started:** ${data.metadata.sessionStartedAt}`);
  }
  if (data.metadata.sessionDuration) {
    lines.push(`**Duration:** ${data.metadata.sessionDuration}`);
  }
  lines.push(`**Messages:** ${data.metadata.messageCount}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of data.messages) {
    const roleLabel = msg.role === 'user'
      ? 'User'
      : msg.role === 'assistant'
        ? 'Assistant'
        : msg.role === 'system'
          ? 'System'
          : msg.role === 'tool'
            ? 'Tool'
            : msg.role.charAt(0).toUpperCase() + msg.role.slice(1);

    lines.push(`### ${roleLabel}`);
    if (msg.timestamp) {
      lines.push(`_${msg.timestamp}_`);
    }
    lines.push('');
    lines.push(msg.content);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Command ──────────────────────────────────────────────────────────────────

export default async function cmdExportSession(
  _args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const config = await loadConfig(globals.config);

  // Parse flags
  const formatRaw = typeof flags['format'] === 'string' ? flags['format'].toLowerCase() : 'json';
  const format: ExportFormat = formatRaw === 'md' || formatRaw === 'markdown' ? 'md' : 'json';

  const outputPath = typeof flags['output'] === 'string'
    ? path.resolve(process.cwd(), flags['output'])
    : typeof flags['o'] === 'string'
      ? path.resolve(process.cwd(), flags['o'])
      : defaultOutputPath(format);

  // Read agent config for metadata
  let agentName = config.agentName || 'Unknown Agent';
  let seedId = 'unknown';
  let model = config.llmModel || 'unknown';
  let provider = config.llmProvider || 'unknown';

  const localConfigPath = path.resolve(process.cwd(), 'agent.config.json');
  if (existsSync(localConfigPath)) {
    try {
      const cfg = JSON.parse(await readFile(localConfigPath, 'utf8'));
      agentName = cfg.displayName || cfg.name || agentName;
      seedId = cfg.seedId || seedId;
      if (cfg.llmModel) model = cfg.llmModel;
      if (cfg.llmProvider) provider = cfg.llmProvider;
    } catch {
      // non-fatal
    }
  }

  // Discover session messages from workspace
  const workspaceBase = resolveAgentWorkspaceBaseDir();
  const workspaceAgentId = sanitizeAgentWorkspaceId(`chat-${path.basename(process.cwd())}`);
  const workspaceDir = path.join(workspaceBase, workspaceAgentId);

  let messages: SessionMessage[] = [];

  if (existsSync(workspaceDir)) {
    messages = await discoverSessionMessages(workspaceDir);
  }

  if (messages.length === 0) {
    // Also try current directory
    messages = await discoverSessionMessages(process.cwd());
  }

  // Compute session timing
  let sessionStartedAt: string | null = null;
  let sessionDuration: string | null = null;

  if (messages.length > 0 && messages[0].timestamp) {
    sessionStartedAt = messages[0].timestamp;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.timestamp) {
      const startMs = new Date(messages[0].timestamp).getTime();
      const endMs = new Date(lastMsg.timestamp).getTime();
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        sessionDuration = formatDuration(endMs - startMs);
      }
    }
  }

  const exportData: SessionExport = {
    metadata: {
      agentName,
      seedId,
      exportedAt: new Date().toISOString(),
      model,
      provider,
      sessionStartedAt,
      sessionDuration,
      messageCount: messages.length,
      format,
    },
    messages,
  };

  // Render output
  let content: string;
  if (format === 'md') {
    content = renderMarkdown(exportData);
  } else {
    content = JSON.stringify(exportData, null, 2) + '\n';
  }

  try {
    await writeFile(outputPath, content, 'utf-8');

    fmt.section('Session Exported');
    fmt.kvPair('Agent', accent(agentName));
    fmt.kvPair('Seed ID', seedId);
    fmt.kvPair('Format', accent(format.toUpperCase()));
    fmt.kvPair('Messages', String(messages.length));
    if (sessionDuration) fmt.kvPair('Duration', sessionDuration);
    fmt.kvPair('Model', dim(model));
    fmt.kvPair('Output', accent(outputPath));

    if (messages.length === 0) {
      fmt.blank();
      fmt.warning(
        'No session messages found. The export contains metadata only.',
      );
      fmt.note(
        `Session history is read from the agent workspace at ${muted(workspaceDir)}`,
      );
    }

    fmt.blank();
  } catch (err) {
    fmt.errorBlock(
      'Export failed',
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1;
  }
}
