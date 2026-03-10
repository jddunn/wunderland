/**
 * @fileoverview RequestFolderAccessTool — lets agents request filesystem
 * permissions from the user at runtime via HITL approval.
 *
 * Instead of giving up with "I don't have permission", the agent can call
 * this tool to explain WHY it needs access and let the user approve or deny.
 *
 * @module wunderland/tools/RequestFolderAccessTool
 */

import * as path from 'node:path';
import type {
  ITool,
  ToolExecutionContext,
  ToolExecutionResult,
  JSONSchemaObject,
} from '@framers/agentos';
import type { SafeGuardrails } from '../security/SafeGuardrails.js';
import { expandTilde, type FolderAccessRule } from '../security/FolderPermissions.js';

export interface FolderPermissionRequest {
  path: string;
  operation: 'read' | 'write';
  reason: string;
  recursive: boolean;
}

export interface RequestFolderAccessDeps {
  guardrails: SafeGuardrails;
  /** Callback that presents the request to the user and returns true if approved. */
  requestPermission: (req: FolderPermissionRequest) => Promise<boolean>;
  /** Agent ID for guardrails lookups. */
  agentId: string;
}

export function createRequestFolderAccessTool(deps: RequestFolderAccessDeps): ITool {
  const inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory or file path to request access to (e.g. ~/Documents/project or /home/user/data).',
      },
      operation: {
        type: 'string',
        enum: ['read', 'write'],
        description: 'Type of access needed. "write" also grants read access.',
      },
      reason: {
        type: 'string',
        description: 'Human-readable explanation of why you need this access. Be specific about what you plan to do.',
      },
      recursive: {
        type: 'boolean',
        default: true,
        description: 'Whether to include all subdirectories (default: true).',
      },
    },
    required: ['path', 'operation', 'reason'],
  };

  return {
    id: 'request_folder_access',
    name: 'request_folder_access',
    displayName: 'Request Folder Access',
    description:
      'Request permission to access a filesystem directory. Use this when a file operation is denied, ' +
      'or proactively before accessing folders outside your workspace. Explain your reason clearly so the user can make an informed decision.',
    category: 'security',
    hasSideEffects: true,
    inputSchema,

    async execute(
      args: Record<string, unknown>,
      _ctx: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
      if (!rawPath) {
        return { success: false, error: 'Missing required field "path".' };
      }

      const operation = args.operation === 'write' ? 'write' : 'read';
      const reason = typeof args.reason === 'string' ? args.reason.trim() : 'No reason provided';
      const recursive = args.recursive !== false;

      // Resolve to absolute path
      const resolved = path.resolve(expandTilde(rawPath));

      // Check if path is non-escalatable (sensitive credentials/system files)
      if (!deps.guardrails.isEscalatable(resolved)) {
        return {
          success: false,
          error: `Access to "${resolved}" cannot be granted through this tool. This path contains sensitive system files or credentials. To access it, modify the agent's folder permission config directly.`,
        };
      }

      // Check if we already have access
      const existing = deps.guardrails.getFolderPermissions(deps.agentId);
      if (existing) {
        const { checkFolderAccess } = await import('../security/FolderPermissions.js');
        const tierPerms = undefined; // We don't have tier perms here, but the guardrails check will use them
        const currentAccess = checkFolderAccess(resolved, operation, existing, tierPerms);
        if (currentAccess.allowed) {
          return {
            success: true,
            output: {
              granted: true,
              alreadyHadAccess: true,
              path: resolved,
              operation,
            },
          };
        }
      }

      // Request permission from user
      const approved = await deps.requestPermission({
        path: resolved,
        operation,
        reason,
        recursive,
      });

      if (!approved) {
        return {
          success: true,
          output: {
            granted: false,
            path: resolved,
            operation,
            message: 'The user denied this access request.',
          },
        };
      }

      // User approved — add the rule at runtime
      const pattern = recursive ? `${resolved}/**` : resolved;
      const rule: FolderAccessRule = {
        pattern,
        read: true,
        write: operation === 'write',
        description: `Granted at runtime: ${reason}`,
      };

      deps.guardrails.addFolderRule(deps.agentId, rule);

      return {
        success: true,
        output: {
          granted: true,
          path: resolved,
          pattern,
          operation,
          message: `Access granted. You can now ${operation} files in ${resolved}.`,
        },
      };
    },
  };
}
