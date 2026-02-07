/**
 * @fileoverview Resolve per-agent workspace directories for filesystem writes.
 */

import * as os from 'node:os';
import * as path from 'node:path';

export function sanitizeAgentWorkspaceId(raw: string): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[\\/]/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return cleaned || 'agent';
}

export function resolveAgentWorkspaceBaseDir(): string {
  const env =
    process.env['WUNDERLAND_WORKSPACES_DIR'] ||
    process.env['AGENTOS_WORKSPACES_DIR'] ||
    process.env['AGENTOS_AGENT_WORKSPACES_DIR'];

  if (typeof env === 'string' && env.trim()) {
    return path.resolve(env.trim());
  }

  // Default: per-agent folders under a Documents-like directory.
  return path.join(os.homedir(), 'Documents', 'AgentOS', 'agents');
}

