// @ts-nocheck
/**
 * @fileoverview Resolve per-agent workspace directories for filesystem writes.
 * @module wunderland/runtime/workspace
 *
 * An agent's id names its folder under the workspace base, so the id is cleaned and checked by AgentOS's
 * `sanitizeAgentWorkspaceId`, the rule `resolveAgentWorkspaceDir` applies too. An id whose cleaned name starts or
 * ends with a dot is refused with an `InvalidAgentWorkspaceIdError`, so `.` and `..` never name the base folder
 * itself or the folder above it. Dots inside a name stay: `a/../b` cleans to `a-..-b`, one folder name.
 */

import * as os from 'node:os';
import * as path from 'node:path';

export {
  InvalidAgentWorkspaceIdError,
  resolveAgentWorkspaceDir,
  sanitizeAgentWorkspaceId,
} from '@framers/agentos';

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
