/**
 * @fileoverview OpenAI tool-calling loop helpers used by Wunderland CLI commands.
 *
 * Integrates {@link StepUpAuthorizationManager} for tiered tool authorization:
 * - Tier 1 (Autonomous): Execute without approval — read-only, safe tools
 * - Tier 2 (Async Review): Execute, then queue for human review
 * - Tier 3 (Sync HITL): Require explicit human approval before execution
 *
 * When `dangerouslySkipPermissions` is true (via `--yes` or
 * `--dangerously-skip-permissions`), uses {@link FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG}
 * which auto-approves ALL tool calls — skills, side effects, capabilities,
 * destructive commands, build commands, and every other tool type.
 *
 * @module wunderland/cli/openai/tool-calling
 */

import {
  StepUpAuthorizationManager,
} from '../../authorization/StepUpAuthorizationManager.js';
import {
  FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG,
  DEFAULT_STEP_UP_AUTH_CONFIG,
  ToolRiskTier,
} from '../../core/types.js';
import type { AuthorizableTool } from '../../authorization/types.js';

export interface ToolCallMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
}

export interface ToolInstance {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  hasSideEffects?: boolean;
  /** Tool category for tiered authorization */
  category?: string;
  /** Required capabilities */
  requiredCapabilities?: string[];
  execute: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<{ success: boolean; output?: unknown; error?: string }>;
}

export function buildToolDefs(toolMap: Map<string, ToolInstance>): Array<Record<string, unknown>> {
  const tools = [...toolMap.values()].filter((t): t is ToolInstance => !!t && typeof t.name === 'string' && !!t.name);
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

export function truncateString(value: unknown, maxLen: number): string {
  const s = typeof value === 'string' ? value : String(value ?? '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `\n...[truncated ${s.length - maxLen} chars]`;
}

export function safeJsonStringify(value: unknown, maxLen: number): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return truncateString(json, maxLen);
  } catch {
    return truncateString(value, maxLen);
  }
}

export function redactToolOutputForLLM(output: unknown): unknown {
  if (!output || typeof output !== 'object') return output;

  // Shallow clone; avoid pulling huge nested structures into the prompt.
  const out: any = Array.isArray(output) ? output.slice(0, 50) : { ...(output as any) };

  for (const key of ['stdout', 'stderr', 'content', 'html', 'text'] as const) {
    if (typeof out?.[key] === 'string') {
      out[key] = truncateString(out[key], 12000);
    }
  }

  return out;
}

/**
 * Convert a {@link ToolInstance} to an {@link AuthorizableTool} for
 * the StepUpAuthorizationManager.
 */
function toAuthorizableTool(tool: ToolInstance): AuthorizableTool {
  return {
    id: tool.name,
    displayName: tool.name,
    description: tool.description,
    category: tool.category,
    hasSideEffects: tool.hasSideEffects ?? false,
    requiredCapabilities: tool.requiredCapabilities,
  };
}

/**
 * Creates a {@link StepUpAuthorizationManager} appropriate for the given mode.
 *
 * - When `dangerouslySkipPermissions` is true, returns a manager using
 *   {@link FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG} — auto-approves everything.
 * - Otherwise, returns a manager using the provided config (defaults to
 *   {@link DEFAULT_STEP_UP_AUTH_CONFIG}) with an optional HITL callback
 *   for Tier 3 authorization (e.g. interactive terminal prompt).
 */
export function createAuthorizationManager(opts: {
  dangerouslySkipPermissions: boolean;
  askPermission?: (tool: ToolInstance, args: Record<string, unknown>) => Promise<boolean>;
}): StepUpAuthorizationManager {
  if (opts.dangerouslySkipPermissions) {
    return new StepUpAuthorizationManager(FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG);
  }

  // Build HITL callback that bridges the interactive askPermission prompt
  const hitlCallback = opts.askPermission
    ? async (request: { actionId: string; description: string }) => {
        // We can't easily recover the ToolInstance from the request,
        // but the description is human-readable. Use the original
        // askPermission for backward compat via the tool-calling loop.
        // The HITL callback is wired directly in runToolCallingTurn.
        return {
          actionId: request.actionId,
          approved: false,
          decidedBy: 'system',
          decidedAt: new Date(),
          rejectionReason: 'Tier 3 HITL not handled via manager; falling back to direct prompt',
        };
      }
    : undefined;

  return new StepUpAuthorizationManager(DEFAULT_STEP_UP_AUTH_CONFIG, hitlCallback);
}

export async function openaiChatWithTools(opts: {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  temperature: number;
  maxTokens: number;
}): Promise<{ message: ToolCallMessage; model: string; usage: unknown }> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools.length > 0 ? opts.tools : undefined,
      tool_choice: opts.tools.length > 0 ? 'auto' : undefined,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI error (${res.status}): ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error('OpenAI returned an empty response.');
  return { message: msg, model: data?.model || opts.model, usage: data?.usage };
}

export async function runToolCallingTurn(opts: {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  toolMap: Map<string, ToolInstance>;
  /**
   * Optional static tool defs. Prefer omitting this and letting the loop
   * derive tool defs from the mutable `toolMap` each round.
   */
  toolDefs?: Array<Record<string, unknown>>;
  /** Optional callback to provide tool defs per round (schema-on-demand). */
  getToolDefs?: () => Array<Record<string, unknown>>;
  toolContext: Record<string, unknown>;
  maxRounds: number;
  dangerouslySkipPermissions: boolean;
  askPermission: (tool: ToolInstance, args: Record<string, unknown>) => Promise<boolean>;
  onToolCall?: (tool: ToolInstance, args: Record<string, unknown>) => void;
  /** Optional pre-configured authorization manager. Created automatically if not provided. */
  authorizationManager?: StepUpAuthorizationManager;
}): Promise<string> {
  const rounds = opts.maxRounds > 0 ? opts.maxRounds : 8;

  // Use provided manager or create one based on permission mode
  const authManager = opts.authorizationManager ?? createAuthorizationManager({
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    askPermission: opts.askPermission,
  });

  for (let round = 0; round < rounds; round += 1) {
    const toolDefs = opts.getToolDefs
      ? opts.getToolDefs()
      : buildToolDefs(opts.toolMap);

    const { message } = await openaiChatWithTools({
      apiKey: opts.apiKey,
      model: opts.model,
      messages: opts.messages,
      tools: toolDefs,
      temperature: 0.2,
      maxTokens: 1400,
    });

    const toolCalls = message.tool_calls || [];

    if (toolCalls.length === 0) {
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      opts.messages.push({ role: 'assistant', content: content || '(no content)' });
      return content || '';
    }

    opts.messages.push({
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const toolName = call?.function?.name;
      const rawArgs = call?.function?.arguments;

      if (!toolName || typeof rawArgs !== 'string') {
        opts.messages.push({ role: 'tool', tool_call_id: call?.id, content: JSON.stringify({ error: 'Malformed tool call.' }) });
        continue;
      }

      const tool = opts.toolMap.get(toolName);
      if (!tool) {
        opts.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `Tool not found: ${toolName}` }) });
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(rawArgs);
      } catch {
        opts.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `Invalid JSON arguments for ${toolName}` }) });
        continue;
      }

      if (opts.onToolCall) {
        try {
          opts.onToolCall(tool, args);
        } catch {
          // ignore logging hook errors
        }
      }

      // Tiered authorization via StepUpAuthorizationManager.
      // When autoApproveAll is set (fully autonomous), this is a no-op
      // that immediately returns authorized. Otherwise it checks
      // the tool's tier, category, escalation triggers, etc.
      const authResult = await authManager.authorize({
        tool: toAuthorizableTool(tool),
        args,
        context: {
          userId: String(opts.toolContext?.['userContext'] && typeof opts.toolContext['userContext'] === 'object'
            ? (opts.toolContext['userContext'] as Record<string, unknown>)?.['userId'] ?? 'cli-user'
            : 'cli-user'),
          sessionId: String(opts.toolContext?.['gmiId'] ?? 'cli'),
          gmiId: String(opts.toolContext?.['personaId'] ?? 'cli'),
        },
        timestamp: new Date(),
      });

      if (!authResult.authorized) {
        // Tier 3 (sync HITL) denial from the manager — fall back to
        // interactive askPermission prompt if available.
        if (authResult.tier === ToolRiskTier.TIER_3_SYNC_HITL && !opts.dangerouslySkipPermissions) {
          const ok = await opts.askPermission(tool, args);
          if (!ok) {
            opts.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `Permission denied for tool: ${toolName}` }) });
            continue;
          }
          // User approved interactively — proceed
        } else {
          opts.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `Permission denied for tool: ${toolName}` }) });
          continue;
        }
      }

      let result: { success: boolean; output?: unknown; error?: string };
      try {
        result = await tool.execute(args, opts.toolContext);
      } catch (err) {
        opts.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: `Tool threw: ${err instanceof Error ? err.message : String(err)}` }),
        });
        continue;
      }

      const payload = result?.success ? redactToolOutputForLLM(result.output) : { error: result?.error || 'Tool failed' };
      opts.messages.push({ role: 'tool', tool_call_id: call.id, content: safeJsonStringify(payload, 20000) });
    }
  }

  return '';
}
