/**
 * @fileoverview OpenAI-compatible tool-calling loop helpers used by Wunderland runtimes.
 *
 * Integrates {@link StepUpAuthorizationManager} for tiered tool authorization:
 * - Tier 1 (Autonomous): Execute without approval — read-only, safe tools
 * - Tier 2 (Async Review): Execute, then queue for human review
 * - Tier 3 (Sync HITL): Require explicit human approval before execution
 *
 * When `dangerouslySkipPermissions` is true (e.g. via the CLI flag
 * `--dangerously-skip-permissions`), uses {@link FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG}
 * which auto-approves ALL tool calls — skills, side effects, capabilities,
 * destructive commands, build commands, and every other tool type.
 *
 * @module wunderland/runtime/tool-calling
 */

import {
  StepUpAuthorizationManager,
} from '../authorization/StepUpAuthorizationManager.js';
import {
  FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG,
  ToolRiskTier,
  type StepUpAuthorizationConfig,
} from '../core/types.js';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { isWunderlandOtelEnabled } from '../observability/otel.js';
import * as path from 'node:path';
import { resolveApiKeyInput } from './api-key-resolver.js';
import {
  buildToolDefsFromMapping,
  buildToolFunctionNameMapping,
  formatToolNameRewriteSummary,
  resolveStrictToolNames,
  resolveToolMapKeyFromFunctionName,
  sanitizeToolDefsForProvider,
} from './tool-function-names.js';

const tracer = trace.getTracer('wunderland.runtime');

/**
 * When a tool fails, suggest alternative tools the LLM can try instead.
 * The LLM sees `suggestedFallbacks` in the error response and can act on it.
 */
const TOOL_FALLBACK_MAP: Record<string, string[]> = {
  'web_search': ['browser_navigate', 'news_search', 'research_aggregate'],
  'browser_navigate': ['stealth_navigate', 'web_search', 'research_aggregate'],
  'browser_scrape': ['stealth_scrape', 'web_search'],
  'stealth_navigate': ['web_search', 'research_aggregate'],
  'news_search': ['web_search', 'browser_navigate'],
  'research_aggregate': ['web_search', 'browser_navigate', 'deep_research'],
  'deep_research': ['research_aggregate', 'researchInvestigate', 'web_search'],
  'fact_check': ['web_search', 'browser_navigate'],
  'image_search': ['web_search', 'browser_navigate'],
  'agent_delegate': ['agent_ping', 'agent_broadcast'],
  'agent_broadcast': ['agent_delegate'],
  'giphy_search': ['web_search'],
  'file_read': ['read_document', 'list_directory', 'request_folder_access'],
  'file_write': ['create_pdf', 'request_folder_access'],
  'list_directory': ['request_folder_access'],
  'shell_execute': ['request_folder_access'],
};

/**
 * Detects when a tool returned success but with an empty results array.
 * Used to inject `suggestedFallbacks` so the LLM tries alternative tools.
 */

// Helpers, types, and utilities extracted to tool-helpers.ts
export {
  getGuardrailsInstance,
  getSecurityPipeline,
  initializeSecurityPipeline,
  resetSecurityPipeline,
  safeJsonStringify,
  truncateString,
  buildToolDefs,
  openaiChatWithTools,
  type ToolInstance,
  type ToolCallMessage,
  type LLMProviderConfig,
  type SecurityPipelineInitOptions,
} from './tool-helpers.js';
import type { ToolInstance, LLMProviderConfig } from './tool-helpers.js';
import {
  isEmptySearchResult,
  getGuardrails,
  safeJsonStringify,
  toAuthorizableTool,
  createAuthorizationManager,
  parseProviderId,
  toAnthropicMessagePayload,
  anthropicMessagesRequest,
  toAnthropicTools,
  openaiChatWithTools,
  redactToolOutputForLLM,
  getStringProp,
  getBooleanProp,
  normalizeToolFailureMode,
  wrapUntrustedToolOutput,
  getAgentIdForGuardrails,
  getAgentWorkspaceDirFromContext,
  maybeConfigureGuardrailsForAgent,
  emitOtelLog,
  withSpan,
  buildStrictToolNameError,
  shouldLogRewrite,
  getSecurityPipeline,
} from "./tool-helpers.js";

export async function runToolCallingTurn(opts: {
  providerId?: string;
  apiKey: string | Promise<string>;
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
  /** Optional step-up auth config — when provided, overrides DEFAULT_STEP_UP_AUTH_CONFIG. */
  stepUpAuthConfig?: StepUpAuthorizationConfig;
  askPermission: (tool: ToolInstance, args: Record<string, unknown>) => Promise<boolean>;
  /** Optional checkpoint hook (used for "human after each round" modes). */
  askCheckpoint?: (info: {
    round: number;
    toolCalls: Array<{ toolName: string; hasSideEffects: boolean; args: Record<string, unknown> }>;
  }) => Promise<boolean>;
  onToolCall?: (tool: ToolInstance, args: Record<string, unknown>) => void;
  /** Called after each tool execution with the result. Use for logging, learning, metrics. */
  onToolResult?: (info: {
    toolName: string;
    args: Record<string, unknown>;
    success: boolean;
    error?: string;
    durationMs: number;
  }) => void;
  /** Optional pre-configured authorization manager. Created automatically if not provided. */
  authorizationManager?: StepUpAuthorizationManager;
  /** Override the API base URL for the primary provider. */
  baseUrl?: string;
  /** Fallback provider config (e.g. OpenRouter). */
  fallback?: LLMProviderConfig;
  /** Called when a fallback is triggered. */
  onFallback?: (primaryError: Error, fallbackProvider: string) => void;
  /** Async key resolver for OAuth. When set, called instead of using the static apiKey. */
  getApiKey?: () => string | Promise<string>;
  /** Native Ollama request options such as num_ctx / num_gpu. */
  ollamaOptions?: Record<string, unknown>;
  /** Tool-call failure behavior. Default: fail_open. */
  toolFailureMode?: 'fail_open' | 'fail_closed';
  /** Enforce strict OpenAI-compatible function names and fail on rewrites/collisions. */
  strictToolNames?: boolean;
  /** Enable verbose tool-calling logs. Defaults to false; set to true or use DEBUG=1 for diagnostics. */
  debug?: boolean;
  /**
   * Optional callback fired when a tool emits progress events during execution.
   * Used by long-running tools like deep_research to report intermediate steps.
   * The callback receives the tool name, a phase label, a human-readable message,
   * and an optional 0-1 progress fraction.
   */
  onToolProgress?: (info: {
    toolName: string;
    phase: string;
    message: string;
    progress?: number;
  }) => void;
}): Promise<string> {
  const rounds = opts.maxRounds > 0 ? opts.maxRounds : 8;
  const debugMode = opts.debug ?? (process.env.DEBUG === '1' || process.env.DEBUG === 'true' || process.env.WUNDERLAND_DEBUG === '1');
  const strictToolNames = resolveStrictToolNames(
    opts.strictToolNames ?? getBooleanProp(opts.toolContext, 'strictToolNames'),
  );
  const loggedRewriteEvents = new Set<string>();

  const shouldWrapToolOutputs = (() => {
    const v = getBooleanProp(opts.toolContext, 'wrapToolOutputs');
    return typeof v === 'boolean' ? v : true;
  })();
  const toolFailureMode = normalizeToolFailureMode(
    opts.toolFailureMode ?? getStringProp(opts.toolContext, 'toolFailureMode'),
    'fail_open',
  );
  const failClosedOnToolFailure = toolFailureMode === 'fail_closed';
  const executionMode = (getStringProp(opts.toolContext, 'executionMode') || '').toLowerCase();
  const turnApprovalMode = (getStringProp(opts.toolContext, 'turnApprovalMode') || '').toLowerCase();
  const requireCheckpointAfterRound =
    typeof opts.askCheckpoint === 'function'
    && !opts.dangerouslySkipPermissions
    && executionMode !== 'autonomous'
    && (turnApprovalMode === 'after-each-round' || turnApprovalMode === 'after-each-turn');

  // Ensure folder-level sandboxing is always configured for filesystem tools.
  try {
    maybeConfigureGuardrailsForAgent(opts.toolContext);
  } catch {
    // Non-fatal: guardrails will still deny filesystem tools when configured to require it.
  }

  // ── Content Security Pipeline: evaluate user input before LLM call ────────
  // The pipeline runs Pre-LLM Classification + guardrail extension packs on
  // the latest user message. If the input is blocked, we return immediately
  // without invoking the LLM.
  const contentPipeline = getSecurityPipeline();
  if (contentPipeline) {
    try {
      // Extract the most recent user message text for classification.
      const lastMsg = opts.messages[opts.messages.length - 1];
      const userText =
        lastMsg?.role === 'user' && typeof lastMsg.content === 'string'
          ? lastMsg.content
          : undefined;

      if (userText) {
        contentPipeline.reset();
        const inputResult = await contentPipeline.evaluateInput({
          input: { textInput: userText },
        } as any);

        if (inputResult?.action === 'block') {
          const blockReason =
            inputResult.metadata?.reason ??
            inputResult.metadata?.explanation ??
            'Input blocked by security pipeline.';
          const blockMsg = `I'm unable to process that request. ${blockReason}`;
          opts.messages.push({ role: 'assistant', content: blockMsg });
          return blockMsg;
        }
      }
    } catch {
      // Non-fatal: if input evaluation fails, proceed without blocking.
    }
  }

  // Use provided manager or create one based on permission mode
  const authManager = opts.authorizationManager ?? createAuthorizationManager({
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    stepUpAuthConfig: opts.stepUpAuthConfig,
    askPermission: opts.askPermission,
  });
  const providerIdRaw = typeof opts.providerId === 'string' ? opts.providerId.trim() : '';
  const providerIdParsed = parseProviderId(providerIdRaw);
  if (providerIdRaw && !providerIdParsed) {
    throw new Error(`Unsupported providerId "${providerIdRaw}". Supported: openai, openrouter, ollama, anthropic, gemini.`);
  }
  const providerId = providerIdParsed ?? 'openai';
  const ollamaProviderPromise =
    providerId === 'ollama'
      ? (async () => {
          const { OllamaProvider } = await import('@framers/agentos/core/llm/providers/implementations/OllamaProvider');
          const provider = new OllamaProvider();
          await provider.initialize({
            baseUrl: opts.baseUrl || 'http://localhost:11434',
            defaultModelId: opts.model,
          });
          return provider;
        })()
      : null;

  for (let round = 0; round < rounds; round += 1) {
    const roundToolCalls: Array<{ toolName: string; hasSideEffects: boolean; args: Record<string, unknown> }> = [];
    const turnResult = await withSpan<string | null>(
      'wunderland.turn',
      { round, has_tools: opts.toolMap.size > 0 },
      async () => {
        const nameMapping = buildToolFunctionNameMapping(opts.toolMap);
        if (nameMapping.rewrites.length > 0) {
          const summary = formatToolNameRewriteSummary(nameMapping.rewrites);
          if (strictToolNames) {
            emitOtelLog({
              name: 'wunderland.runtime',
              body: 'tool_name_strict_block',
              severity: SeverityNumber.ERROR,
              attributes: {
                rewrite_count: nameMapping.rewrites.length,
                round,
              },
            });
            throw buildStrictToolNameError('[tool-calling]', summary);
          }
          const eventKey = `mapping:${summary}`;
          if (shouldLogRewrite(loggedRewriteEvents, eventKey)) {
            console.warn(`[tool-calling] Sanitized tool map function names: ${summary}`);
            emitOtelLog({
              name: 'wunderland.runtime',
              body: 'tool_name_rewrite_mapping',
              severity: SeverityNumber.WARN,
              attributes: {
                rewrite_count: nameMapping.rewrites.length,
                round,
              },
            });
          }
        }

        const rawToolDefs = opts.getToolDefs
          ? opts.getToolDefs()
          : opts.toolDefs ?? buildToolDefsFromMapping(opts.toolMap, nameMapping);

        const sanitizedDefs = sanitizeToolDefsForProvider(rawToolDefs);
        if (sanitizedDefs.rewrites.length > 0) {
          const summary = formatToolNameRewriteSummary(
            sanitizedDefs.rewrites.map((r) => ({
              sourceName: r.originalName,
              rewrittenName: r.sanitizedName,
              reason: r.reason,
            })),
          );

          if (strictToolNames) {
            emitOtelLog({
              name: 'wunderland.runtime',
              body: 'tool_name_strict_block_defs',
              severity: SeverityNumber.ERROR,
              attributes: {
                rewrite_count: sanitizedDefs.rewrites.length,
                round,
              },
            });
            throw buildStrictToolNameError('[tool-calling]', summary);
          }
          const eventKey = `defs:${summary}`;
          if (shouldLogRewrite(loggedRewriteEvents, eventKey)) {
            console.warn(`[tool-calling] Sanitized outbound tool definitions: ${summary}`);
            emitOtelLog({
              name: 'wunderland.runtime',
              body: 'tool_name_rewrite_defs',
              severity: SeverityNumber.WARN,
              attributes: {
                rewrite_count: sanitizedDefs.rewrites.length,
                round,
              },
            });
          }
        }

        const toolDefs = sanitizedDefs.toolDefs;

        // LLM call span (safe metadata only; no prompt/output content).
        let fallbackTriggered = false;
        let fallbackProvider = '';

        const invoke = async () => {
          if (providerId === 'ollama') {
            const provider = await ollamaProviderPromise!;
            const result = await provider.generateCompletion(
              opts.model,
              opts.messages as any,
              {
                temperature: 0.2,
                maxTokens: 1400,
                tools: toolDefs,
                customModelParams: opts.ollamaOptions,
              },
            );
            const message = result.choices?.[0]?.message;
            if (!message) {
              throw new Error('Ollama returned an empty response.');
            }
            return {
              message,
              model: result.modelId || opts.model,
              usage: {
                prompt_tokens: result.usage?.promptTokens,
                completion_tokens: result.usage?.completionTokens,
                total_tokens: result.usage?.totalTokens,
                costUSD: result.usage?.costUSD,
              },
              provider: 'Ollama',
            };
          }

          if (providerId === 'anthropic') {
            const anthropicApiKey = await resolveApiKeyInput(
              opts.getApiKey ? opts.getApiKey : opts.apiKey,
              { source: 'Anthropic Messages API' },
            );
            const payload = toAnthropicMessagePayload(opts.messages);
            return await anthropicMessagesRequest({
              apiKey: anthropicApiKey,
              model: opts.model,
              system: payload.system,
              messages: payload.messages,
              tools: toAnthropicTools(toolDefs),
              temperature: 0.2,
              maxTokens: 1400,
            });
          }

          return await openaiChatWithTools({
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
            getApiKey: opts.getApiKey,
          });
        };

        const llmResult = !isWunderlandOtelEnabled()
          ? await invoke()
          : await tracer.startActiveSpan(
              'wunderland.llm.chat_completions',
              { attributes: { round, tools_count: toolDefs.length, provider: providerId } },
              async (span) => {
                try {
                  const res = await invoke();

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

        // Debug: log LLM response shape (only when debug mode is on)
        if (debugMode) {
          const contentPreview = typeof message.content === 'string' ? message.content.slice(0, 200) : '(null)';
          console.log(`[tool-calling] Round ${round}: toolCalls=${toolCalls.length}, content="${contentPreview}"`);
          if (toolCalls.length > 0) {
            for (const tc of toolCalls) {
              console.log(`[tool-calling]   → ${tc?.function?.name}(${(tc?.function?.arguments || '').slice(0, 100)})`);
            }
          }
        }

        if (toolCalls.length === 0) {
          let content = typeof message.content === 'string' ? message.content.trim() : '';
          // Strip <think>...</think> blocks from models like qwen3 that use thinking mode.
          content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
          // Also strip leading **<think>...</think>** markdown-wrapped variants.
          content = content.replace(/\*{0,2}<think>[\s\S]*?<\/think>\*{0,2}\s*/g, '').trim();

          // ── Content Security Pipeline: evaluate LLM output ──────────────
          // Run Dual-LLM Auditor + guardrail extension packs on the final
          // assistant response. If blocked, replace with a safe message.
          if (contentPipeline && content) {
            try {
              const outputResult = await contentPipeline.evaluateOutput({
                chunk: { finalResponseText: content },
              } as any);

              if (outputResult?.action === 'block') {
                const safeMsg =
                  'I generated a response but it was blocked by the security pipeline. Please try rephrasing your request.';
                opts.messages.push({ role: 'assistant', content: safeMsg });
                return safeMsg;
              }
            } catch {
              // Non-fatal: if output evaluation fails, return the original content.
            }
          }

          opts.messages.push({ role: 'assistant', content: content || '(no content)' });
          return content || '';
        }

        opts.messages.push({
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : null,
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          const maybeFailClosed = (reason: string): string | null => {
            if (!failClosedOnToolFailure) return null;
            const reply = `[tool_failure_mode=fail_closed] ${reason}`;
            opts.messages.push({ role: 'assistant', content: reply });
            return reply;
          };

          const requestedToolName = call?.function?.name;
          const rawArgs = call?.function?.arguments;

          if (!requestedToolName || typeof rawArgs !== 'string') {
            opts.messages.push({ role: 'tool', tool_call_id: call?.id, content: JSON.stringify({ error: 'Malformed tool call.' }) });
            const failReply = maybeFailClosed('Malformed tool call returned by model.');
            if (failReply) return failReply;
            continue;
          }

          const resolvedToolKey = resolveToolMapKeyFromFunctionName({
            functionName: requestedToolName,
            toolMap: opts.toolMap,
            mapping: nameMapping,
            sanitizedAliasByName: sanitizedDefs.aliasBySanitizedName,
          });
          const tool = resolvedToolKey ? opts.toolMap.get(resolvedToolKey) : undefined;
          if (!tool) {
            emitOtelLog({
              name: 'wunderland.runtime',
              body: 'tool_lookup_miss',
              severity: SeverityNumber.WARN,
              attributes: { requested_tool_name: requestedToolName, round },
            });
            opts.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `Tool not found: ${requestedToolName}` }) });
            const failReply = maybeFailClosed(`Tool not found: ${requestedToolName}.`);
            if (failReply) return failReply;
            continue;
          }

          const toolName = tool.name || resolvedToolKey || requestedToolName;

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(rawArgs);
          } catch {
            opts.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: `Invalid JSON arguments for ${requestedToolName}` }) });
            const failReply = maybeFailClosed(`Invalid JSON arguments for ${requestedToolName}.`);
            if (failReply) return failReply;
            continue;
          }

          roundToolCalls.push({ toolName, hasSideEffects: tool.hasSideEffects === true, args });

          if (opts.onToolCall) {
            try {
              opts.onToolCall(tool, args);
            } catch {
              // ignore logging hook errors
            }
          }

          // ── Unified authorization (single prompt path, not three) ──────────
          // Gate 1 (requireApprovalForAllTools) and Gate 2 (StepUpAuth) are merged.
          // If the auth manager classifies a tool as TIER_1 or TIER_2, no prompt fires
          // even when requireApprovalForAllTools is set. This prevents over-prompting
          // for safe navigation tools like change_directory / list_directory.
          let hitlApprovedThisCall = false;
          {
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
              if (authResult.tier === ToolRiskTier.TIER_3_SYNC_HITL && !opts.dangerouslySkipPermissions) {
                // Tier 3: require interactive prompt (exactly one)
                const ok = await opts.askPermission(tool, args);
                if (!ok) {
                  const denial = JSON.stringify({ error: `Permission denied for tool: ${toolName}` });
                  opts.messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: shouldWrapToolOutputs
                      ? wrapUntrustedToolOutput(denial, { toolName, toolCallId: call.id, includeWarning: false })
                      : denial,
                  });
                  const failReply = maybeFailClosed(`Permission denied for tool: ${toolName}.`);
                  if (failReply) return failReply;
                  continue;
                }
                hitlApprovedThisCall = true;
              } else if (!opts.dangerouslySkipPermissions) {
                const denial = JSON.stringify({ error: `Permission denied for tool: ${toolName}` });
                opts.messages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  content: shouldWrapToolOutputs
                    ? wrapUntrustedToolOutput(denial, { toolName, toolCallId: call.id, includeWarning: false })
                    : denial,
                });
                const failReply = maybeFailClosed(`Permission denied for tool: ${toolName}.`);
                if (failReply) return failReply;
                continue;
              }
            }
            // Tier 1 / Tier 2: authorized — no prompt needed
          }

          // Build per-call tool context with progress callback if provided.
          const callToolContext: Record<string, unknown> = opts.onToolProgress
            ? { ...opts.toolContext, onToolProgress: (info: { phase: string; message: string; progress?: number }) => {
                try { opts.onToolProgress!({ toolName, ...info }); } catch { /* ignore */ }
              } }
            : opts.toolContext;

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
                // Pre-check: file_read on directories should fail-fast without permission prompts
                if (tool.name === 'file_read') {
                  const readPath = (args as any).path || (args as any).file_path || (args as any).filePath;
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

                // NEW: Safe Guardrails validation
                const guardrails = getGuardrails();
                const agentId = getAgentIdForGuardrails(opts.toolContext);
                const guardrailsCheck = await guardrails.validateBeforeExecution({
                  toolId: resolvedToolKey || tool.name,
                  toolName: tool.name,
                  args,
                  agentId,
                  userId: (opts.toolContext.userContext as any)?.userId,
                  sessionId: opts.toolContext.sessionId as string | undefined,
                  workingDirectory: getAgentWorkspaceDirFromContext(opts.toolContext, agentId),
                  tool: tool as any,
                });

                if (!guardrailsCheck.allowed) {
                  // Attempt automatic permission escalation via HITL
                  const deniedPaths = (guardrailsCheck.violations || [])
                    .map(v => v.attemptedPath)
                    .filter((p): p is string => !!p);
                  const allEscalatable = deniedPaths.length > 0 && deniedPaths.every(p => guardrails.isEscalatable(p));

                  if (allEscalatable) {
                    const operation = deniedPaths.length > 0 ? (guardrailsCheck.violations?.[0]?.operation || tool.name) : tool.name;
                    const isWrite = operation.includes('write') || operation.includes('delete') || operation.includes('append');

                    // If user already approved this tool call at the HITL gate, auto-grant
                    // folder access instead of prompting again (deduplication).
                    const autoGrant = hitlApprovedThisCall || opts.dangerouslySkipPermissions;
                    const approved = autoGrant || (opts.askPermission
                      ? await opts.askPermission(
                          { ...tool, name: `folder_access:${tool.name}`, description: `Grant ${isWrite ? 'write' : 'read'} access to: ${deniedPaths.join(', ')}` } as ToolInstance,
                          { paths: deniedPaths, operation: isWrite ? 'write' : 'read', originalTool: tool.name },
                        )
                      : false);

                    if (approved) {
                      // Add rules for each denied path
                      for (const p of deniedPaths) {
                        const dir = p.endsWith('/') ? p : path.dirname(p);
                        guardrails.addFolderRule(agentId, {
                          pattern: `${dir}/**`,
                          read: true,
                          write: isWrite,
                          description: `Granted at runtime for ${tool.name}`,
                        });

                        // Propagate to CLI executor's ShellService so its internal
                        // assertFilesystemAllowed() also allows the approved path.
                        const shellSvc = (tool as any).shellService;
                        if (shellSvc && typeof shellSvc.addReadRoot === 'function') {
                          shellSvc.addReadRoot(dir);
                          if (isWrite) {
                            shellSvc.addWriteRoot(dir);
                          }
                        }
                      }
                      // Retry the original tool execution
                      return await tool.execute(args, callToolContext);
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

                // Original execution continues if guardrails pass
                return await tool.execute(args, callToolContext);
              },
            );
          } catch (err) {
            const durationMs = Math.max(0, Date.now() - start);
            emitOtelLog({
              name: 'wunderland.runtime',
              body: `tool_execute_error:${toolName}`,
              severity: SeverityNumber.ERROR,
              attributes: { tool_name: toolName, duration_ms: durationMs, round },
            });
            const errMsg = err instanceof Error ? err.message : String(err);
            // Fire onToolResult for thrown errors
            if (opts.onToolResult) {
              try {
                opts.onToolResult({ toolName, args, success: false, error: errMsg, durationMs });
              } catch { /* ignore */ }
            }
            // Enrich with API key guidance when available
            let apiKeyGuidance: string | undefined;
            try {
              const registry = await import('@framers/agentos-extensions-registry');
              const getApiKeyGuidance = (registry as any).getApiKeyGuidance;
              if (typeof getApiKeyGuidance === 'function') apiKeyGuidance = getApiKeyGuidance(errMsg, toolName) ?? undefined;
            } catch { /* best-effort */ }
            const fallbacks = TOOL_FALLBACK_MAP[toolName];
            const availableFallbacks = fallbacks?.filter(f => opts.toolMap?.has(f));
            opts.messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({
                error: `Tool threw: ${errMsg}`,
                ...(apiKeyGuidance ? { apiKeyGuidance } : null),
                ...(availableFallbacks?.length ? { suggestedFallbacks: availableFallbacks } : null),
              }),
            });
            const failReply = maybeFailClosed(`Tool ${toolName} threw: ${errMsg}`);
            if (failReply) return failReply;
            continue;
          }

          const durationMs = Math.max(0, Date.now() - start);
          emitOtelLog({
            name: 'wunderland.runtime',
            body: `tool_execute:${toolName}`,
            severity: SeverityNumber.INFO,
            attributes: { tool_name: toolName, success: result?.success === true, duration_ms: durationMs, round },
          });

          // Fire onToolResult callback
          if (opts.onToolResult) {
            try {
              opts.onToolResult({
                toolName,
                args,
                success: result?.success === true,
                error: result?.success ? undefined : (result?.error || 'Tool failed'),
                durationMs,
              });
            } catch { /* ignore callback errors */ }
          }

          let payload: unknown;
          if (result?.success) {
            payload = redactToolOutputForLLM(result.output);
            // When a search tool succeeds but returns zero results, inject
            // suggestedFallbacks so the LLM tries alternatives (e.g.
            // browser_navigate) instead of giving up.
            const emptyFallbacks = TOOL_FALLBACK_MAP[toolName];
            const availableEmptyFallbacks = emptyFallbacks?.filter(f => opts.toolMap?.has(f));
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
            const availableFallbacksOnFail = fallbacksOnFail?.filter(f => opts.toolMap?.has(f));
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
          const content = shouldWrapToolOutputs
            ? wrapUntrustedToolOutput(json, { toolName, toolCallId: call.id, includeWarning: true })
            : json;
          opts.messages.push({ role: 'tool', tool_call_id: call.id, content });

          if (!result?.success) {
            const failReply = maybeFailClosed(`Tool ${toolName} failed: ${result?.error || 'Tool failed'}`);
            if (failReply) return failReply;
          }
        }

        if (requireCheckpointAfterRound) {
          const ok = await opts.askCheckpoint!({ round, toolCalls: roundToolCalls });
          if (!ok) {
            return '[HITL] Paused by operator.';
          }
        }

        return null;
      },
    );

    if (turnResult !== null) return turnResult;
  }

  return '';
}
