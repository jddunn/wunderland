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
import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { isWunderlandOtelEnabled, shouldExportWunderlandOtelLogs } from '../observability/otel.js';

const tracer = trace.getTracer('wunderland.cli');

function emitOtelLog(opts: {
  name: string;
  body: string;
  severity: SeverityNumber;
  attributes?: Record<string, string | number | boolean>;
}): void {
  if (!isWunderlandOtelEnabled()) return;
  if (!shouldExportWunderlandOtelLogs()) return;

  try {
    const logger = logs.getLogger(opts.name);
    logger.emit({
      severityNumber: opts.severity,
      severityText: String(opts.severity),
      body: opts.body,
      attributes: opts.attributes,
      context: context.active(),
    });
  } catch {
    // ignore
  }
}

async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isWunderlandOtelEnabled()) return fn();

  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (error) {
      try {
        span.recordException(error as any);
      } catch {
        // ignore
      }
      try {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      } catch {
        // ignore
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

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

/**
 * Configuration for an LLM provider endpoint.
 * Both OpenAI and OpenRouter use the same OpenAI-compatible chat completions API.
 */
export interface LLMProviderConfig {
  apiKey: string;
  model: string;
  /** API base URL (without trailing slash). Defaults to OpenAI. */
  baseUrl?: string;
  /** Extra headers (e.g. OpenRouter's HTTP-Referer, X-Title). */
  extraHeaders?: Record<string, string>;
}

/** Default API base URLs for known providers. */
const PROVIDER_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
} as const;

/**
 * Determines whether an error should trigger a fallback attempt.
 * Retryable: rate limits (429), server errors (500+), auth failures (401/403), network errors.
 */
function shouldFallback(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message;
    // HTTP status codes that warrant fallback
    if (/\b(429|500|502|503|504|401|403)\b/.test(msg)) return true;
    // Network-level failures
    if (/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(msg)) return true;
  }
  return false;
}

async function chatCompletionsRequest(
  provider: LLMProviderConfig,
  messages: Array<Record<string, unknown>>,
  tools: Array<Record<string, unknown>>,
  temperature: number,
  maxTokens: number,
): Promise<{ message: ToolCallMessage; model: string; usage: unknown; provider: string }> {
  const baseUrl = provider.baseUrl || PROVIDER_BASE_URLS.openai;
  const providerName = baseUrl.includes('openrouter') ? 'OpenRouter' : 'OpenAI';

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
      ...(provider.extraHeaders || {}),
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`${providerName} error (${res.status}): ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error(`${providerName} returned an empty response.`);
  return { message: msg, model: data?.model || provider.model, usage: data?.usage, provider: providerName };
}

export async function openaiChatWithTools(opts: {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  temperature: number;
  maxTokens: number;
  /** Override the API base URL (e.g. for OpenRouter). */
  baseUrl?: string;
  /** Fallback provider to try when the primary fails with a retryable error. */
  fallback?: LLMProviderConfig;
  /** Called when a fallback is triggered. */
  onFallback?: (primaryError: Error, fallbackProvider: string) => void;
}): Promise<{ message: ToolCallMessage; model: string; usage: unknown; provider: string }> {
  const primary: LLMProviderConfig = {
    apiKey: opts.apiKey,
    model: opts.model,
    baseUrl: opts.baseUrl,
  };

  try {
    return await chatCompletionsRequest(primary, opts.messages, opts.tools, opts.temperature, opts.maxTokens);
  } catch (err) {
    // If no fallback configured, or error isn't retryable, re-throw
    if (!opts.fallback || !shouldFallback(err)) throw err;

    const primaryError = err instanceof Error ? err : new Error(String(err));
    const fallbackName = opts.fallback.baseUrl?.includes('openrouter') ? 'OpenRouter' : 'fallback';
    opts.onFallback?.(primaryError, fallbackName);

    return await chatCompletionsRequest(opts.fallback, opts.messages, opts.tools, opts.temperature, opts.maxTokens);
  }
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
  /** Override the API base URL for the primary provider. */
  baseUrl?: string;
  /** Fallback provider config (e.g. OpenRouter). */
  fallback?: LLMProviderConfig;
  /** Called when a fallback is triggered. */
  onFallback?: (primaryError: Error, fallbackProvider: string) => void;
}): Promise<string> {
  const rounds = opts.maxRounds > 0 ? opts.maxRounds : 8;

  // Use provided manager or create one based on permission mode
  const authManager = opts.authorizationManager ?? createAuthorizationManager({
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    askPermission: opts.askPermission,
  });

  for (let round = 0; round < rounds; round += 1) {
    const turnResult = await withSpan<string | null>(
      'wunderland.turn',
      { round, has_tools: opts.toolMap.size > 0 },
      async () => {
        const toolDefs = opts.getToolDefs ? opts.getToolDefs() : buildToolDefs(opts.toolMap);

        // LLM call span (safe metadata only; no prompt/output content).
        let fallbackTriggered = false;
        let fallbackProvider = '';

        const llmResult = !isWunderlandOtelEnabled()
          ? await openaiChatWithTools({
              apiKey: opts.apiKey,
              model: opts.model,
              messages: opts.messages,
              tools: toolDefs,
              temperature: 0.2,
              maxTokens: 1400,
              baseUrl: opts.baseUrl,
              fallback: opts.fallback,
              onFallback: (primaryError, providerName) => {
                fallbackTriggered = true;
                fallbackProvider = providerName;
                opts.onFallback?.(primaryError, providerName);
              },
            })
          : await tracer.startActiveSpan(
              'wunderland.llm.chat_completions',
              { attributes: { round, tools_count: toolDefs.length } },
              async (span) => {
                try {
                  const res = await openaiChatWithTools({
                    apiKey: opts.apiKey,
                    model: opts.model,
                    messages: opts.messages,
                    tools: toolDefs,
                    temperature: 0.2,
                    maxTokens: 1400,
                    baseUrl: opts.baseUrl,
                    fallback: opts.fallback,
                    onFallback: (primaryError, providerName) => {
                      fallbackTriggered = true;
                      fallbackProvider = providerName;
                      opts.onFallback?.(primaryError, providerName);
                    },
                  });

                  try {
                    span.setAttribute('provider', res.provider);
                    span.setAttribute('model', res.model);
                    span.setAttribute('llm.fallback.used', fallbackTriggered);
                    if (fallbackTriggered) span.setAttribute('llm.fallback.provider', fallbackProvider);
                  } catch {
                    // ignore
                  }

                  // Best-effort: attach token usage as safe span attributes (no content).
                  try {
                    const u: any = res.usage && typeof res.usage === 'object' ? res.usage : null;
                    const total = typeof u?.total_tokens === 'number' ? u.total_tokens : undefined;
                    const prompt = typeof u?.prompt_tokens === 'number' ? u.prompt_tokens : undefined;
                    const completion = typeof u?.completion_tokens === 'number' ? u.completion_tokens : undefined;
                    if (typeof total === 'number') span.setAttribute('llm.usage.total_tokens', total);
                    if (typeof prompt === 'number') span.setAttribute('llm.usage.prompt_tokens', prompt);
                    if (typeof completion === 'number') span.setAttribute('llm.usage.completion_tokens', completion);
                  } catch {
                    // ignore
                  }

                  return res;
                } catch (error) {
                  try {
                    span.recordException(error as any);
                  } catch {
                    // ignore
                  }
                  try {
                    span.setStatus({
                      code: SpanStatusCode.ERROR,
                      message: error instanceof Error ? error.message : String(error),
                    });
                  } catch {
                    // ignore
                  }
                  throw error;
                } finally {
                  span.end();
                }
              },
            );

        const { message } = llmResult;

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
            // Tier 3 (sync HITL) denial from the manager — fall back to interactive prompt if available.
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

          const start = Date.now();
          let result: { success: boolean; output?: unknown; error?: string };
          try {
            result = await withSpan(
              'wunderland.tool.execute',
              {
                tool_name: toolName,
                tool_category: tool.category ?? '',
                tool_has_side_effects: tool.hasSideEffects === true,
                authorized: true,
              },
              async () => {
                return await tool.execute(args, opts.toolContext);
              },
            );
          } catch (err) {
            const durationMs = Math.max(0, Date.now() - start);
            emitOtelLog({
              name: 'wunderland.cli',
              body: `tool_execute_error:${toolName}`,
              severity: SeverityNumber.ERROR,
              attributes: { tool_name: toolName, duration_ms: durationMs, round },
            });
            opts.messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ error: `Tool threw: ${err instanceof Error ? err.message : String(err)}` }),
            });
            continue;
          }

          const durationMs = Math.max(0, Date.now() - start);
          emitOtelLog({
            name: 'wunderland.cli',
            body: `tool_execute:${toolName}`,
            severity: SeverityNumber.INFO,
            attributes: { tool_name: toolName, success: result?.success === true, duration_ms: durationMs, round },
          });

          const payload = result?.success ? redactToolOutputForLLM(result.output) : { error: result?.error || 'Tool failed' };
          opts.messages.push({ role: 'tool', tool_call_id: call.id, content: safeJsonStringify(payload, 20000) });
        }

        return null;
      },
    );

    if (turnResult !== null) return turnResult;
  }

  return '';
}
