// @ts-nocheck
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
} from '../security/StepUpAuthorizationManager.js';
import {
  FULLY_AUTONOMOUS_STEP_UP_AUTH_CONFIG,
  type StepUpAuthorizationConfig,
} from '../core/types.js';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { isWunderlandOtelEnabled } from '../observability/otel.js';
import { recordWunderlandTokenUsage } from '../observability/token-usage.js';
import { resolveApiKeyInput } from './api-key-resolver.js';
import {
  buildToolDefsFromMapping,
  buildToolFunctionNameMapping,
  formatToolNameRewriteSummary,
  resolveStrictToolNames,
  resolveToolMapKeyFromFunctionName,
  sanitizeToolDefsForProvider,
} from './tool-function-names.js';
import {
  LoopController,
  type LoopConfig,
  type LoopContext,
} from '@framers/agentos/orchestration';
import { wrapLLMAsGenerator } from './llm-stream-adapter.js';
import {
  authorizeToolCall,
  executeWithGuardrails,
  buildToolResultPayload,
  buildToolErrorPayload,
} from './ToolApprovalHandler.js';

type LoopToolCallRequest = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type ToolCallResult = {
  id: string;
  name: string;
  success: boolean;
  output?: unknown;
  error?: string;
};

const tracer = trace.getTracer('wunderland.runtime');

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
  createAuthorizationManager,
  parseProviderId,
  toAnthropicMessagePayload,
  anthropicMessagesRequest,
  toAnthropicTools,
  openaiChatWithTools,
  getStringProp,
  getBooleanProp,
  normalizeToolFailureMode,
  maybeConfigureGuardrailsForAgent,
  emitOtelLog,
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
    output?: unknown;
    durationMs: number;
  }) => void;
  /** Called when the LLM emits streamed text before the turn completes. */
  onTextDelta?: (content: string) => void;
  /**
   * Called once per provider response with token usage and cost — same
   * payload shape as `recordWunderlandTokenUsage`'s observability hook,
   * surfaced to the caller so per-node accumulators (e.g. mission report
   * cost telemetry) can be built without going through the global
   * observability sink.
   *
   * Fired on every successful round of the ReAct loop — caller is
   * responsible for accumulating across rounds.
   */
  onUsage?: (usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    costUSD?: number;
    model?: string;
    providerId?: string;
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

  // ---------------------------------------------------------------------------
  // Extracted helper: callLLMForTurn
  // Performs the provider-specific LLM call with OTel instrumentation, fallback
  // tracking, and debug logging. Returns the raw OpenAI-compatible response
  // (wrapped in { choices: [{ message, finish_reason }] } shape for the
  // wrapLLMAsGenerator adapter).
  // ---------------------------------------------------------------------------
  const callLLMForTurn = async (
    round: number,
    toolDefs: Array<Record<string, unknown>>,
  ): Promise<unknown> => {
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
	                const costUsd = typeof u?.costUSD === 'number' ? u.costUSD : undefined;
	                if (typeof total === 'number') span.setAttribute('llm.usage.total_tokens', total);
	                if (typeof prompt === 'number') span.setAttribute('llm.usage.prompt_tokens', prompt);
	                if (typeof completion === 'number') span.setAttribute('llm.usage.completion_tokens', completion);
	                if (typeof costUsd === 'number') span.setAttribute('llm.usage.cost_usd', costUsd);
	              } catch {
	                // ignore
	              }

	              await recordWunderlandTokenUsage({
	                sessionId: typeof opts.toolContext?.['sessionId'] === 'string' ? opts.toolContext['sessionId'] as string : undefined,
	                personaId: typeof opts.toolContext?.['personaId'] === 'string' ? opts.toolContext['personaId'] as string : undefined,
	                providerId,
	                model: typeof res.model === 'string' ? res.model : opts.model,
	                userId:
                    opts.toolContext?.['userContext'] && typeof opts.toolContext['userContext'] === 'object'
                      ? String((opts.toolContext['userContext'] as Record<string, unknown>)['userId'] ?? '')
                      : undefined,
	                tenantId:
                    opts.toolContext?.['tenantId'] && typeof opts.toolContext['tenantId'] === 'string'
                      ? opts.toolContext['tenantId'] as string
                      : opts.toolContext?.['userContext'] && typeof opts.toolContext['userContext'] === 'object'
                        ? typeof (opts.toolContext['userContext'] as Record<string, unknown>)['organizationId'] === 'string'
                          ? (opts.toolContext['userContext'] as Record<string, unknown>)['organizationId'] as string
                          : undefined
                        : undefined,
	                source: 'tool-calling',
	                configDirOverride:
                    typeof opts.toolContext?.['wunderlandConfigDir'] === 'string'
                      ? opts.toolContext['wunderlandConfigDir'] as string
                      : undefined,
	                usage: res.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; costUSD?: number } | null,
	              });

              // Surface per-round usage to the caller so node-level
              // accumulators (e.g. mission report cost telemetry) don't have
              // to fish it out of the global observability sink.
              if (opts.onUsage && res.usage && typeof res.usage === 'object') {
                try {
                  const u = res.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; costUSD?: number };
                  opts.onUsage({
                    prompt_tokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
                    completion_tokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
                    total_tokens: typeof u.total_tokens === 'number' ? u.total_tokens : undefined,
                    costUSD: typeof u.costUSD === 'number' ? u.costUSD : undefined,
                    model: typeof res.model === 'string' ? res.model : opts.model,
                    providerId,
                  });
                } catch { /* caller bug shouldn't break the round */ }
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

	    if (!isWunderlandOtelEnabled()) {
	      await recordWunderlandTokenUsage({
	        sessionId: typeof opts.toolContext?.['sessionId'] === 'string' ? opts.toolContext['sessionId'] as string : undefined,
	        personaId: typeof opts.toolContext?.['personaId'] === 'string' ? opts.toolContext['personaId'] as string : undefined,
	        providerId,
	        model: typeof (llmResult as any)?.model === 'string' ? (llmResult as any).model : opts.model,
	        userId:
            opts.toolContext?.['userContext'] && typeof opts.toolContext['userContext'] === 'object'
              ? String((opts.toolContext['userContext'] as Record<string, unknown>)['userId'] ?? '')
              : undefined,
	        tenantId:
            opts.toolContext?.['tenantId'] && typeof opts.toolContext['tenantId'] === 'string'
              ? opts.toolContext['tenantId'] as string
              : opts.toolContext?.['userContext'] && typeof opts.toolContext['userContext'] === 'object'
                ? typeof (opts.toolContext['userContext'] as Record<string, unknown>)['organizationId'] === 'string'
                  ? (opts.toolContext['userContext'] as Record<string, unknown>)['organizationId'] as string
                  : undefined
                : undefined,
	        source: 'tool-calling',
	        configDirOverride:
            typeof opts.toolContext?.['wunderlandConfigDir'] === 'string'
              ? opts.toolContext['wunderlandConfigDir'] as string
              : undefined,
	        usage: (llmResult as any)?.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; costUSD?: number } | null,
	      });

	      // Same per-round usage callback as the OTel branch — fires here so
	      // callers don't miss it when OTel is disabled.
	      if (opts.onUsage && (llmResult as any)?.usage && typeof (llmResult as any).usage === 'object') {
	        try {
	          const u = (llmResult as any).usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; costUSD?: number };
	          opts.onUsage({
	            prompt_tokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
	            completion_tokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
	            total_tokens: typeof u.total_tokens === 'number' ? u.total_tokens : undefined,
	            costUSD: typeof u.costUSD === 'number' ? u.costUSD : undefined,
	            model: typeof (llmResult as any)?.model === 'string' ? (llmResult as any).model : opts.model,
	            providerId,
	          });
	        } catch { /* caller bug shouldn't break the round */ }
	      }
	    }

	    // Re-wrap into standard { choices: [{ message, finish_reason }] } shape
    // so wrapLLMAsGenerator can consume it uniformly.
    return {
      choices: [{
        message: (llmResult as any).message,
        finish_reason: (llmResult as any).message?.tool_calls?.length ? 'tool_calls' : 'stop',
      }],
    };
  };

  // ---------------------------------------------------------------------------
  // Extracted helper: executeToolWithContext
  // Handles tool-name rewriting resolution, step-up auth, guardrails,
  // content security, fallback suggestions, telemetry, and message pushing.
  // Returns a ToolCallResult. On fail_closed abort, sets the earlyReturn
  // sentinel so the outer loop terminates.
  // ---------------------------------------------------------------------------

  /** Sentinel: when set to a non-null string, the outer loop returns this value. */
  let earlyReturn: string | null = null;
  /** Set to true after addToolResults; consumed by the next generateStream call. */
  let pendingCheckpoint = false;

  /**
   * Per-round state shared between generateStream and executeTool callbacks.
   * Reset at the top of each LoopController iteration via the generateStream wrapper.
   */
  let currentRound = 0;
  let currentNameMapping: ReturnType<typeof buildToolFunctionNameMapping> | null = null;
  let currentSanitizedDefs: ReturnType<typeof sanitizeToolDefsForProvider> | null = null;
  const roundToolCalls: Array<{ toolName: string; hasSideEffects: boolean; args: Record<string, unknown> }> = [];

  const executeToolWithContext = async (tc: LoopToolCallRequest): Promise<ToolCallResult> => {
    const round = currentRound;
    const nameMapping = currentNameMapping!;
    const sanitizedDefs = currentSanitizedDefs!;

    const maybeFailClosed = (reason: string): string | null => {
      if (!failClosedOnToolFailure) return null;
      const reply = `[tool_failure_mode=fail_closed] ${reason}`;
      opts.messages.push({ role: 'assistant', content: reply });
      return reply;
    };

    const requestedToolName = tc.name;
    const callId = tc.id;

    // Malformed tool call guard (shouldn't happen with wrapLLMAsGenerator, but be safe)
    if (!requestedToolName) {
      opts.messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ error: 'Malformed tool call.' }) });
      const failReply = maybeFailClosed('Malformed tool call returned by model.');
      if (failReply) { earlyReturn = failReply; }
      return { id: callId, name: requestedToolName || 'unknown', success: false, error: 'Malformed tool call.' };
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
      opts.messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ error: `Tool not found: ${requestedToolName}` }) });
      const failReply = maybeFailClosed(`Tool not found: ${requestedToolName}.`);
      if (failReply) { earlyReturn = failReply; }
      return { id: callId, name: requestedToolName, success: false, error: `Tool not found: ${requestedToolName}` };
    }

    const toolName = tool.name || resolvedToolKey || requestedToolName;
    const args = tc.arguments;

    roundToolCalls.push({ toolName, hasSideEffects: tool.hasSideEffects === true, args });

    if (opts.onToolCall) {
      try {
        opts.onToolCall(tool, args);
      } catch {
        // ignore logging hook errors
      }
    }

    // ── Unified authorization (delegated to ToolApprovalHandler) ──────────
    const authorizationResult = await authorizeToolCall({
      tool,
      toolName,
      args,
      callId,
      authManager,
      toolContext: opts.toolContext,
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
      askPermission: opts.askPermission,
      shouldWrapToolOutputs,
      failClosedOnToolFailure,
      messages: opts.messages,
    });

    if (!authorizationResult.authorized) {
      if (authorizationResult.earlyReturn) {
        earlyReturn = authorizationResult.earlyReturn;
      }
      return { id: callId, name: toolName, success: false, error: authorizationResult.error || `Permission denied for tool: ${toolName}` };
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
      result = await executeWithGuardrails({
        tool,
        toolName,
        resolvedToolKey: resolvedToolKey || tool.name,
        args,
        callId,
        toolContext: opts.toolContext,
        callToolContext,
        hitlApproved: authorizationResult.hitlApproved,
        dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
        askPermission: opts.askPermission,
      });
    } catch (err) {
      const durationMs = Math.max(0, Date.now() - start);
      emitOtelLog({
        name: 'wunderland.runtime',
        body: `tool_execute_error:${toolName}`,
        severity: SeverityNumber.ERROR,
        attributes: { tool_name: toolName, duration_ms: durationMs, round },
      });
      const errMsg = err instanceof Error ? err.message : String(err);
      if (opts.onToolResult) {
        try {
          opts.onToolResult({ toolName, args, success: false, error: errMsg, durationMs });
        } catch { /* ignore */ }
      }
      const errorPayload = await buildToolErrorPayload(errMsg, toolName, opts.toolMap);
      opts.messages.push({ role: 'tool', tool_call_id: callId, content: errorPayload });
      const failReply = maybeFailClosed(`Tool ${toolName} threw: ${errMsg}`);
      if (failReply) { earlyReturn = failReply; }
      return { id: callId, name: toolName, success: false, error: errMsg };
    }

    const durationMs = Math.max(0, Date.now() - start);
    emitOtelLog({
      name: 'wunderland.runtime',
      body: `tool_execute:${toolName}`,
      severity: SeverityNumber.INFO,
      attributes: { tool_name: toolName, success: result?.success === true, duration_ms: durationMs, round },
    });

    if (opts.onToolResult) {
      try {
        opts.onToolResult({
          toolName,
          args,
          success: result?.success === true,
          error: result?.success ? undefined : (result?.error || 'Tool failed'),
          output: result?.success ? result.output : undefined,
          durationMs,
        });
      } catch { /* ignore callback errors */ }
    }

    const content = await buildToolResultPayload(
      result,
      toolName,
      callId,
      opts.toolMap,
      shouldWrapToolOutputs,
      debugMode,
    );
    opts.messages.push({ role: 'tool', tool_call_id: callId, content });

    if (!result?.success) {
      const failReply = maybeFailClosed(`Tool ${toolName} failed: ${result?.error || 'Tool failed'}`);
      if (failReply) { earlyReturn = failReply; }
    }

    return {
      id: callId,
      name: toolName,
      success: result?.success === true,
      output: result?.output,
      error: result?.success ? undefined : (result?.error || 'Tool failed'),
    };
  };

  // ---------------------------------------------------------------------------
  // Main loop: LoopController-driven ReAct cycle
  // ---------------------------------------------------------------------------
  const controller = new LoopController();
  const loopConfig: LoopConfig = {
    maxIterations: rounds,
    parallelTools: false,
    failureMode: toolFailureMode,
  };

  /** Tracks the final text response across rounds for the return value. */
  let finalText = '';
  /** Accumulates text within a single round (reset when tool_call_request arrives). */
  let pendingText = '';

  const loopContext: LoopContext = {
    generateStream: () => {
      // We return an async generator that:
      // 1. Fires the per-round checkpoint from the previous round (async, awaitable)
      // 2. Builds tool name mappings for this round
      // 3. Delegates to wrapLLMAsGenerator for the actual LLM call
      const self = (async function* (): AsyncGenerator<
        import('./llm-stream-adapter.js').LoopChunk,
        import('./llm-stream-adapter.js').LoopOutput,
        undefined
      > {
        // Fire the per-round checkpoint from the previous round (if any).
        // addToolResults is synchronous so checkpoint must be deferred here.
        if (pendingCheckpoint && requireCheckpointAfterRound && earlyReturn === null) {
          const ok = await opts.askCheckpoint!({ round: currentRound, toolCalls: [...roundToolCalls] });
          if (!ok) {
            earlyReturn = '[HITL] Paused by operator.';
          }
        }
        pendingCheckpoint = false;
        currentRound++;

        if (earlyReturn !== null) {
          // Checkpoint rejected — return empty output to terminate the loop.
          return { responseText: '', toolCalls: [], finishReason: 'stop' };
        }

        // Reset per-round state.
        const round = currentRound - 1;
        roundToolCalls.length = 0;

        // Build tool name mapping and defs for this round.
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

        // Stash for executeTool to reference.
        currentNameMapping = nameMapping;
        currentSanitizedDefs = sanitizedDefs;

        const toolDefs = sanitizedDefs.toolDefs;

        // Delegate to the LLM adapter generator, yielding all chunks and
        // returning its LoopOutput as our own return value.
        const llmGen = wrapLLMAsGenerator(() => callLLMForTurn(round, toolDefs));
        let iterResult = await llmGen.next();
        while (!iterResult.done) {
          yield iterResult.value as import('./llm-stream-adapter.js').LoopChunk;
          iterResult = await llmGen.next();
        }
        return iterResult.value;
      })();

      // Cast needed because LoopContext expects the AgentOS LoopChunk/LoopOutput
      // types which are structurally identical to the adapter's types.
      return self as any;
    },

    executeTool: (tc: LoopToolCallRequest) => executeToolWithContext(tc),

    addToolResults: (_results: ToolCallResult[]) => {
      // Tool result messages are already pushed by executeToolWithContext.
      // Mark that this round had tools executed so the checkpoint fires
      // at the start of the next generateStream call (where we can await).
      pendingCheckpoint = true;
    },
  };

  for await (const event of controller.execute(loopConfig, loopContext)) {
    // Check for fail_closed early abort after each event.
    if (earlyReturn !== null) {
      return earlyReturn;
    }

    switch (event.type) {
      case 'text_delta': {
        // Accumulate text. If the model also emits tool calls in this round,
        // pendingText will be included in the assistant message. If not,
        // finalText captures it for the loop_complete handler.
        pendingText += event.content;
        finalText += event.content;
        opts.onTextDelta?.(event.content);
        break;
      }

      case 'tool_call_request': {
        // Push the assistant message with tool_calls (and any preceding text).
        const rawToolCalls = event.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
        if (debugMode) {
          const roundNum = currentRound - 1;
          const contentPreview = pendingText ? pendingText.slice(0, 200) : '(null)';
          console.log(`[tool-calling] Round ${roundNum}: toolCalls=${rawToolCalls.length}, content="${contentPreview}"`);
          for (const tc of rawToolCalls) {
            console.log(`[tool-calling]   → ${tc.function.name}(${tc.function.arguments.slice(0, 100)})`);
          }
        }

        opts.messages.push({
          role: 'assistant',
          content: pendingText || null,
          tool_calls: rawToolCalls,
        });
        pendingText = '';
        break;
      }

      case 'tool_result':
      case 'tool_error':
        // Already handled inside executeToolWithContext (messages pushed, hooks fired).
        break;

      case 'loop_complete': {
        // Natural termination: model returned text without tool calls.
        // Apply content security and think-tag stripping to finalText.
        let content = finalText.trim();
        content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
        content = content.replace(/\*{0,2}<think>[\s\S]*?<\/think>\*{0,2}\s*/g, '').trim();

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

      case 'max_iterations_reached':
        // Exceeded maxRounds without a natural stop.
        return finalText || '';

      default:
        break;
    }

    // Re-check earlyReturn after processing the event (executeTool may have set it).
    if (earlyReturn !== null) {
      return earlyReturn;
    }
  }

  return finalText || '';
}

// =============================================================================
// Streaming variant — re-exported from ToolStreamProcessor.ts
// =============================================================================

export {
  streamToolCallingTurn,
  type StreamToolCallingTurnOpts,
} from './ToolStreamProcessor.js';

// Keep TOOL_FALLBACK_MAP re-export for backwards compatibility
export { TOOL_FALLBACK_MAP } from './ToolApprovalHandler.js';

