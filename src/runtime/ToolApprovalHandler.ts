/**
 * @fileoverview HITL approval flow, security tier permission checks,
 * step-up authorization, guardrails validation, and tool allowlist/denylist
 * checking.
 *
 * Extracted from `tool-calling.ts` to isolate the authorization and
 * guardrails layer from the LLM loop and streaming logic. Both the
 * non-streaming {@link runToolCallingTurn} and streaming
 * {@link streamToolCallingTurn} delegate tool authorization to the
 * functions exported here.
 *
 * @module wunderland/runtime/ToolApprovalHandler
 */

import * as path from 'node:path';
import {
  ToolRiskTier,
} from '../core/types.js';
import type { StepUpAuthorizationManager } from '../security/StepUpAuthorizationManager.js';
import type { ToolInstance } from './tool-helpers.js';
import {
  getGuardrails,
  toAuthorizableTool,
  wrapUntrustedToolOutput,
  getAgentIdForGuardrails,
  getAgentWorkspaceDirFromContext,
  withSpan,
  redactToolOutputForLLM,
  safeJsonStringify,
  isEmptySearchResult,
  TOOL_FALLBACK_MAP,
} from './tool-helpers.js';

// Re-export TOOL_FALLBACK_MAP for consumers that import from this module.
export { TOOL_FALLBACK_MAP } from './tool-helpers.js';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Options for {@link authorizeToolCall}.
 *
 * Contains everything needed to decide whether a tool call should be
 * executed, denied, or escalated to the user for HITL approval.
 */
export interface ToolAuthorizationOpts {
  /** The resolved tool instance. */
  tool: ToolInstance;
  /** The canonical tool name (after any rewriting). */
  toolName: string;
  /** The tool call arguments from the LLM. */
  args: Record<string, unknown>;
  /** The tool call ID for message correlation. */
  callId: string;
  /** The authorization manager instance. */
  authManager: StepUpAuthorizationManager;
  /** Shared context passed to tool execution. */
  toolContext: Record<string, unknown>;
  /** Whether to skip all permission checks. */
  dangerouslySkipPermissions: boolean;
  /** Interactive permission callback for HITL approval. */
  askPermission: (tool: ToolInstance, args: Record<string, unknown>) => Promise<boolean>;
  /** Whether to wrap tool output for the LLM. */
  shouldWrapToolOutputs: boolean;
  /** Whether to abort on any tool failure. */
  failClosedOnToolFailure: boolean;
  /** Mutable message array for pushing denial messages. */
  messages: Array<Record<string, unknown>>;
}

/**
 * Result of a tool authorization check.
 */
export interface ToolAuthorizationResult {
  /** Whether the tool call is authorized to proceed. */
  authorized: boolean;
  /** Whether the user explicitly approved this call via HITL. */
  hitlApproved: boolean;
  /** If authorization failed and fail_closed is active, the reply to return. */
  earlyReturn?: string;
  /** If authorization failed, the denial reason. */
  error?: string;
}

/**
 * Options for {@link executeWithGuardrails}.
 *
 * Encapsulates the guardrails validation, folder escalation, and
 * tool execution within a single instrumented span.
 */
export interface GuardrailExecutionOpts {
  /** The resolved tool instance. */
  tool: ToolInstance;
  /** The canonical tool name. */
  toolName: string;
  /** The resolved tool key from the tool map. */
  resolvedToolKey: string;
  /** The tool call arguments. */
  args: Record<string, unknown>;
  /** The tool call ID. */
  callId: string;
  /** Shared context passed to tool execution. */
  toolContext: Record<string, unknown>;
  /** Per-call tool context (may include onToolProgress). */
  callToolContext: Record<string, unknown>;
  /** Whether the user already HITL-approved this call (skip re-prompting). */
  hitlApproved: boolean;
  /** Whether to skip all permission checks. */
  dangerouslySkipPermissions: boolean;
  /** Interactive permission callback for folder escalation. */
  askPermission: (tool: ToolInstance, args: Record<string, unknown>) => Promise<boolean>;
}

// ── Functions ──────────────────────────────────────────────────────────────

/**
 * Perform step-up authorization for a tool call.
 *
 * Evaluates the tool against the {@link StepUpAuthorizationManager}'s
 * tier configuration:
 *
 * - **Tier 1 (Autonomous)**: Auto-approved, no prompt.
 * - **Tier 2 (Async Review)**: Auto-approved, queued for review.
 * - **Tier 3 (Sync HITL)**: Prompts the user via `askPermission`.
 *
 * When `dangerouslySkipPermissions` is `true`, all tiers are auto-approved.
 *
 * @param opts - Authorization options.
 * @returns Authorization result indicating whether to proceed.
 */
export async function authorizeToolCall(
  opts: ToolAuthorizationOpts,
): Promise<ToolAuthorizationResult> {
  const { tool, toolName, args, callId, authManager, toolContext, dangerouslySkipPermissions, askPermission, shouldWrapToolOutputs, failClosedOnToolFailure, messages } = opts;

  const authResult = await authManager.authorize({
    tool: toAuthorizableTool(tool),
    args,
    context: {
      userId: String(toolContext?.['userContext'] && typeof toolContext['userContext'] === 'object'
        ? (toolContext['userContext'] as Record<string, unknown>)?.['userId'] ?? 'cli-user'
        : 'cli-user'),
      sessionId: String(toolContext?.['gmiId'] ?? 'cli'),
      gmiId: String(toolContext?.['personaId'] ?? 'cli'),
    },
    timestamp: new Date(),
  });

  if (!authResult.authorized) {
    if (authResult.tier === ToolRiskTier.TIER_3_SYNC_HITL && !dangerouslySkipPermissions) {
      const ok = await askPermission(tool, args);
      if (!ok) {
        const denial = JSON.stringify({ error: `Permission denied for tool: ${toolName}` });
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          content: shouldWrapToolOutputs
            ? wrapUntrustedToolOutput(denial, { toolName, toolCallId: callId, includeWarning: false })
            : denial,
        });
        const earlyReturn = failClosedOnToolFailure
          ? `[tool_failure_mode=fail_closed] Permission denied for tool: ${toolName}.`
          : undefined;
        if (earlyReturn) {
          messages.push({ role: 'assistant', content: earlyReturn });
        }
        return { authorized: false, hitlApproved: false, earlyReturn, error: `Permission denied for tool: ${toolName}` };
      }
      return { authorized: true, hitlApproved: true };
    } else if (!dangerouslySkipPermissions) {
      const denial = JSON.stringify({ error: `Permission denied for tool: ${toolName}` });
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: shouldWrapToolOutputs
          ? wrapUntrustedToolOutput(denial, { toolName, toolCallId: callId, includeWarning: false })
          : denial,
      });
      const earlyReturn = failClosedOnToolFailure
        ? `[tool_failure_mode=fail_closed] Permission denied for tool: ${toolName}.`
        : undefined;
      if (earlyReturn) {
        messages.push({ role: 'assistant', content: earlyReturn });
      }
      return { authorized: false, hitlApproved: false, earlyReturn, error: `Permission denied for tool: ${toolName}` };
    }
    // dangerouslySkipPermissions — fall through to authorized
  }

  return { authorized: true, hitlApproved: false };
}

/**
 * Execute a tool with guardrails validation and folder escalation.
 *
 * Wraps tool execution inside an OTel span and performs:
 *
 * 1. **Pre-check**: `file_read` on directories fails fast with a helpful message.
 * 2. **Guardrails validation**: Checks folder access rules, sandbox boundaries.
 * 3. **Folder escalation**: If denied paths are escalatable, prompts the user
 *    (or auto-grants if HITL already approved this call) and adds folder rules.
 * 4. **Execution**: Calls `tool.execute(args, callToolContext)`.
 *
 * @param opts - Execution options.
 * @returns The tool execution result.
 */
export async function executeWithGuardrails(
  opts: GuardrailExecutionOpts,
): Promise<{ success: boolean; output?: unknown; error?: string }> {
  return await withSpan(
    'wunderland.tool.execute',
    {
      tool_name: opts.toolName,
      tool_category: opts.tool.category ?? '',
      tool_has_side_effects: opts.tool.hasSideEffects === true,
      authorized: true,
    },
    async () => {
      // Pre-check: file_read on directories should fail-fast
      if (opts.tool.name === 'file_read') {
        const readPath = (opts.args as any).path || (opts.args as any).file_path || (opts.args as any).filePath;
        if (typeof readPath === 'string') {
          try {
            const fsp = await import('node:fs/promises');
            const s = await fsp.stat(path.resolve(readPath));
            if (s.isDirectory()) {
              return {
                success: false,
                error: `"${readPath}" is a directory, not a file. Use list_directory to view directory contents.`,
              };
            }
          } catch { /* path doesn't exist — let normal flow handle */ }
        }
      }

      // Guardrails validation
      const guardrails = getGuardrails();
      const agentId = getAgentIdForGuardrails(opts.toolContext);
      const guardrailsCheck = await guardrails.validateBeforeExecution({
        toolId: opts.resolvedToolKey || opts.tool.name,
        toolName: opts.tool.name,
        args: opts.args,
        agentId,
        userId: (opts.toolContext.userContext as any)?.userId,
        sessionId: opts.toolContext.sessionId as string | undefined,
        workingDirectory: getAgentWorkspaceDirFromContext(opts.toolContext, agentId),
        tool: opts.tool as any,
      });

      if (!guardrailsCheck.allowed) {
        // Attempt automatic permission escalation via HITL
        const deniedPaths = (guardrailsCheck.violations || [])
          .map(v => v.attemptedPath)
          .filter((p): p is string => !!p);
        const allEscalatable = deniedPaths.length > 0 && deniedPaths.every(p => guardrails.isEscalatable(p));

        if (allEscalatable) {
          const operation = deniedPaths.length > 0 ? (guardrailsCheck.violations?.[0]?.operation || opts.tool.name) : opts.tool.name;
          const isWrite = operation.includes('write') || operation.includes('delete') || operation.includes('append');

          const autoGrant = opts.hitlApproved || opts.dangerouslySkipPermissions;
          const approved = autoGrant || (opts.askPermission
            ? await opts.askPermission(
                { ...opts.tool, name: `folder_access:${opts.tool.name}`, description: `Grant ${isWrite ? 'write' : 'read'} access to: ${deniedPaths.join(', ')}` } as ToolInstance,
                { paths: deniedPaths, operation: isWrite ? 'write' : 'read', originalTool: opts.tool.name },
              )
            : false);

          if (approved) {
            for (const p of deniedPaths) {
              const dir = p.endsWith('/') ? p : path.dirname(p);
              guardrails.addFolderRule(agentId, {
                pattern: `${dir}/**`,
                read: true,
                write: isWrite,
                description: `Granted at runtime for ${opts.tool.name}`,
              });

              const shellSvc = (opts.tool as any).shellService;
              if (shellSvc && typeof shellSvc.addReadRoot === 'function') {
                shellSvc.addReadRoot(dir);
                if (isWrite) {
                  shellSvc.addWriteRoot(dir);
                }
              }
            }
            return await opts.tool.execute(opts.args, opts.callToolContext);
          }
        }

        return {
          success: false,
          error: guardrailsCheck.reason,
          output: {
            violations: guardrailsCheck.violations,
            canRequestAccess: allEscalatable,
          },
        };
      }

      return await opts.tool.execute(opts.args, opts.callToolContext);
    },
  );
}

/**
 * Build the tool result message payload, including fallback suggestions
 * for failed or empty-result tools.
 *
 * @param result - The tool execution result.
 * @param toolName - The canonical tool name.
 * @param callId - The tool call ID.
 * @param toolMap - The current tool map (to check fallback availability).
 * @param shouldWrapToolOutputs - Whether to wrap output for the LLM.
 * @param debugMode - Whether to log debug output.
 * @returns The message content string to push into the conversation.
 */
export async function buildToolResultPayload(
  result: { success: boolean; output?: unknown; error?: string },
  toolName: string,
  callId: string,
  toolMap: Map<string, ToolInstance>,
  shouldWrapToolOutputs: boolean,
  debugMode: boolean,
): Promise<string> {
  let payload: unknown;
  if (result?.success) {
    payload = redactToolOutputForLLM(result.output);
    const emptyFallbacks = TOOL_FALLBACK_MAP[toolName];
    const availableEmptyFallbacks = emptyFallbacks?.filter(f => toolMap?.has(f));
    if (availableEmptyFallbacks?.length && isEmptySearchResult(result.output)) {
      payload = {
        ...((typeof payload === 'object' && payload) || { output: payload }),
        suggestedFallbacks: availableEmptyFallbacks,
        hint: 'Search returned 0 results. Try the suggested fallback tools.',
      };
    }
  } else {
    const errorMsg = result?.error || 'Tool failed';
    let apiKeyHint: string | undefined;
    try {
      const registry = await import('@framers/agentos-extensions-registry');
      const getApiKeyGuidance = (registry as any).getApiKeyGuidance;
      if (typeof getApiKeyGuidance === 'function') apiKeyHint = getApiKeyGuidance(errorMsg, toolName) ?? undefined;
    } catch { /* best-effort */ }
    const fallbacksOnFail = TOOL_FALLBACK_MAP[toolName];
    const availableFallbacksOnFail = fallbacksOnFail?.filter(f => toolMap?.has(f));
    payload = {
      error: errorMsg,
      ...(apiKeyHint ? { apiKeyGuidance: apiKeyHint } : null),
      ...(availableFallbacksOnFail?.length ? { suggestedFallbacks: availableFallbacksOnFail } : null),
    };
  }

  const json = safeJsonStringify(payload, 20000);
  if (debugMode) {
    console.log(`[tool-calling] Tool ${toolName} result: success=${result?.success}, output=${json.slice(0, 300)}`);
  }
  return shouldWrapToolOutputs
    ? wrapUntrustedToolOutput(json, { toolName, toolCallId: callId, includeWarning: true })
    : json;
}

/**
 * Build the error payload for a tool that threw an exception.
 *
 * Includes API key guidance hints and suggested fallback tools when
 * available in the tool map.
 *
 * @param errMsg - The error message from the thrown exception.
 * @param toolName - The canonical tool name.
 * @param toolMap - The current tool map.
 * @returns The JSON-serialized error payload.
 */
export async function buildToolErrorPayload(
  errMsg: string,
  toolName: string,
  toolMap: Map<string, ToolInstance>,
): Promise<string> {
  let apiKeyGuidance: string | undefined;
  try {
    const registry = await import('@framers/agentos-extensions-registry');
    const getApiKeyGuidance = (registry as any).getApiKeyGuidance;
    if (typeof getApiKeyGuidance === 'function') apiKeyGuidance = getApiKeyGuidance(errMsg, toolName) ?? undefined;
  } catch { /* best-effort */ }
  const fallbacks = TOOL_FALLBACK_MAP[toolName];
  const availableFallbacks = fallbacks?.filter(f => toolMap?.has(f));
  return JSON.stringify({
    error: `Tool threw: ${errMsg}`,
    ...(apiKeyGuidance ? { apiKeyGuidance } : null),
    ...(availableFallbacks?.length ? { suggestedFallbacks: availableFallbacks } : null),
  });
}
