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
import { recordWunderlandTokenUsage } from '../observability/token-usage.js';
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
import {
  LoopController,
  type LoopConfig,
  type LoopContext,
} from '@framers/agentos/orchestration';
import { wrapLLMAsGenerator, wrapStreamingLLMAsGenerator } from './llm-stream-adapter.js';

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
  streamingOpenaiChatWithTools,
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

    // ── Unified authorization (single prompt path, not three) ──────────
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
          const ok = await opts.askPermission(tool, args);
          if (!ok) {
            const denial = JSON.stringify({ error: `Permission denied for tool: ${toolName}` });
            opts.messages.push({
              role: 'tool',
              tool_call_id: callId,
              content: shouldWrapToolOutputs
                ? wrapUntrustedToolOutput(denial, { toolName, toolCallId: callId, includeWarning: false })
                : denial,
            });
            const failReply = maybeFailClosed(`Permission denied for tool: ${toolName}.`);
            if (failReply) { earlyReturn = failReply; }
            return { id: callId, name: toolName, success: false, error: `Permission denied for tool: ${toolName}` };
          }
          hitlApprovedThisCall = true;
        } else if (!opts.dangerouslySkipPermissions) {
          const denial = JSON.stringify({ error: `Permission denied for tool: ${toolName}` });
          opts.messages.push({
            role: 'tool',
            tool_call_id: callId,
            content: shouldWrapToolOutputs
              ? wrapUntrustedToolOutput(denial, { toolName, toolCallId: callId, includeWarning: false })
              : denial,
          });
          const failReply = maybeFailClosed(`Permission denied for tool: ${toolName}.`);
          if (failReply) { earlyReturn = failReply; }
          return { id: callId, name: toolName, success: false, error: `Permission denied for tool: ${toolName}` };
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

          // Safe Guardrails validation
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

              const autoGrant = hitlApprovedThisCall || opts.dangerouslySkipPermissions;
              const approved = autoGrant || (opts.askPermission
                ? await opts.askPermission(
                    { ...tool, name: `folder_access:${tool.name}`, description: `Grant ${isWrite ? 'write' : 'read'} access to: ${deniedPaths.join(', ')}` } as ToolInstance,
                    { paths: deniedPaths, operation: isWrite ? 'write' : 'read', originalTool: tool.name },
                  )
                : false);

              if (approved) {
                for (const p of deniedPaths) {
                  const dir = p.endsWith('/') ? p : path.dirname(p);
                  guardrails.addFolderRule(agentId, {
                    pattern: `${dir}/**`,
                    read: true,
                    write: isWrite,
                    description: `Granted at runtime for ${tool.name}`,
                  });

                  const shellSvc = (tool as any).shellService;
                  if (shellSvc && typeof shellSvc.addReadRoot === 'function') {
                    shellSvc.addReadRoot(dir);
                    if (isWrite) {
                      shellSvc.addWriteRoot(dir);
                    }
                  }
                }
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
      if (opts.onToolResult) {
        try {
          opts.onToolResult({ toolName, args, success: false, error: errMsg, durationMs });
        } catch { /* ignore */ }
      }
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
        tool_call_id: callId,
        content: JSON.stringify({
          error: `Tool threw: ${errMsg}`,
          ...(apiKeyGuidance ? { apiKeyGuidance } : null),
          ...(availableFallbacks?.length ? { suggestedFallbacks: availableFallbacks } : null),
        }),
      });
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
          durationMs,
        });
      } catch { /* ignore callback errors */ }
    }

    let payload: unknown;
    if (result?.success) {
      payload = redactToolOutputForLLM(result.output);
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
      ? wrapUntrustedToolOutput(json, { toolName, toolCallId: callId, includeWarning: true })
      : json;
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
// Streaming variant — yields text tokens incrementally for real-time TTS
// =============================================================================

/**
 * Options for {@link streamToolCallingTurn}.
 *
 * Identical to `runToolCallingTurn` options, plus an optional `signal` for
 * aborting the in-flight LLM streaming request (e.g. on barge-in).
 */
export interface StreamToolCallingTurnOpts {
  providerId?: string;
  apiKey: string | Promise<string>;
  model: string;
  messages: Array<Record<string, unknown>>;
  toolMap: Map<string, ToolInstance>;
  toolDefs?: Array<Record<string, unknown>>;
  getToolDefs?: () => Array<Record<string, unknown>>;
  toolContext: Record<string, unknown>;
  maxRounds: number;
  dangerouslySkipPermissions: boolean;
  stepUpAuthConfig?: import('../core/types.js').StepUpAuthorizationConfig;
  askPermission: (tool: ToolInstance, args: Record<string, unknown>) => Promise<boolean>;
  askCheckpoint?: (info: {
    round: number;
    toolCalls: Array<{ toolName: string; hasSideEffects: boolean; args: Record<string, unknown> }>;
  }) => Promise<boolean>;
  onToolCall?: (tool: ToolInstance, args: Record<string, unknown>) => void;
  onToolResult?: (info: {
    toolName: string;
    args: Record<string, unknown>;
    success: boolean;
    error?: string;
    durationMs: number;
  }) => void;
  authorizationManager?: import('../authorization/StepUpAuthorizationManager.js').StepUpAuthorizationManager;
  baseUrl?: string;
  fallback?: import('./tool-helpers.js').LLMProviderConfig;
  onFallback?: (primaryError: Error, fallbackProvider: string) => void;
  getApiKey?: () => string | Promise<string>;
  ollamaOptions?: Record<string, unknown>;
  toolFailureMode?: 'fail_open' | 'fail_closed';
  strictToolNames?: boolean;
  debug?: boolean;
  onToolProgress?: (info: {
    toolName: string;
    phase: string;
    message: string;
    progress?: number;
  }) => void;
  /**
   * External abort signal. When aborted, the in-flight streaming LLM request
   * is cancelled immediately (saves tokens, reduces latency on barge-in).
   */
  signal?: AbortSignal;
}

/**
 * Streaming variant of {@link runToolCallingTurn}.
 *
 * Yields individual text tokens as they arrive from the LLM streaming API,
 * enabling real-time TTS playback (~500ms first-token latency instead of
 * waiting for the full LLM response). Tool-call rounds are handled
 * identically to the non-streaming variant: tool execution blocks, then
 * the next LLM round resumes streaming.
 *
 * **Protocol:**
 * - Each `yield` emits a small text token string (typically 1-4 words).
 * - The generator returns the full accumulated reply text when done.
 * - If the signal is aborted mid-stream, iteration stops gracefully.
 *
 * **Fallback:** For providers that do not support streaming (Ollama,
 * Anthropic via the Messages API), this automatically falls back to the
 * non-streaming `runToolCallingTurn` and post-splits the complete response
 * into word-boundary chunks.
 *
 * @param opts - Same options as `runToolCallingTurn`, plus an optional
 *   `signal` for cancellation.
 * @yields Individual text token strings as they arrive from the LLM.
 * @returns The full accumulated reply text.
 */
export async function* streamToolCallingTurn(
  opts: StreamToolCallingTurnOpts,
): AsyncGenerator<string, string, undefined> {
  // Determine whether we can use true streaming for this provider.
  const providerIdRaw = typeof opts.providerId === 'string' ? opts.providerId.trim() : '';
  const providerIdParsed = parseProviderId(providerIdRaw);
  const providerId = providerIdParsed ?? 'openai';

  // Only OpenAI-compatible endpoints support SSE streaming in our stack.
  // Ollama, Anthropic, and Gemini use different protocols — fall back to
  // non-streaming with post-split chunking for those providers.
  const canStream = providerId === 'openai' || providerId === 'openrouter';

  if (!canStream) {
    // Fallback: run the blocking variant, then post-split into word chunks.
    const fullReply = await runToolCallingTurn({
      ...opts,
      // Strip the signal — runToolCallingTurn does not support it.
    });
    if (fullReply) {
      const chunks = fullReply.match(/\S+\s*/g) ?? [fullReply];
      for (const chunk of chunks) {
        if (opts.signal?.aborted) break;
        yield chunk;
      }
    }
    return fullReply;
  }

  // --- True streaming path (OpenAI / OpenRouter) ---

  const rounds = opts.maxRounds > 0 ? opts.maxRounds : 8;
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

  // Ensure folder-level sandboxing is always configured.
  try { maybeConfigureGuardrailsForAgent(opts.toolContext); } catch { /* non-fatal */ }

  // Content security pipeline (pre-LLM input check).
  const contentPipeline = getSecurityPipeline();
  if (contentPipeline) {
    try {
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
          yield blockMsg;
          return blockMsg;
        }
      }
    } catch { /* non-fatal */ }
  }

  const authManager = opts.authorizationManager ?? createAuthorizationManager({
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    stepUpAuthConfig: opts.stepUpAuthConfig,
    askPermission: opts.askPermission,
  });

  let fullText = '';

  /**
   * Performs one LLM round with streaming, yielding text tokens as they
   * arrive. Returns the collected tool calls (empty if the model finished
   * with text only) and the finish reason.
   */
  async function* streamOneRound(
    toolDefs: Array<Record<string, unknown>>,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<string, { toolCalls: import('./llm-stream-adapter.js').ToolCallRequest[]; finishReason: string }, undefined> {
    let sseLines: AsyncIterable<string>;
    try {
      sseLines = await streamingOpenaiChatWithTools({
        apiKey: opts.apiKey,
        model: opts.model,
        messages: opts.messages,
        tools: toolDefs,
        temperature: 0.2,
        maxTokens: 1400,
        baseUrl: opts.baseUrl,
        fallback: opts.fallback,
        onFallback: (primaryError, providerName) => {
          opts.onFallback?.(primaryError, providerName);
        },
        getApiKey: opts.getApiKey,
        signal,
      });
    } catch (err) {
      // If aborted, return empty result gracefully.
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { toolCalls: [], finishReason: 'abort' };
      }
      throw err;
    }

    const gen = wrapStreamingLLMAsGenerator(sseLines);
    let iterResult = await gen.next();
    while (!iterResult.done) {
      const chunk = iterResult.value;
      if (chunk.type === 'text_delta' && chunk.content) {
        yield chunk.content;
      }
      // tool_call_request chunks are handled after the loop via the return value.
      iterResult = await gen.next();
    }
    return iterResult.value;
  }

  // --- Main multi-round loop ---
  for (let round = 0; round < rounds; round++) {
    if (opts.signal?.aborted) break;

    // Build tool name mapping and defs for this round.
    const nameMapping = buildToolFunctionNameMapping(opts.toolMap);
    if (nameMapping.rewrites.length > 0) {
      const summary = formatToolNameRewriteSummary(nameMapping.rewrites);
      if (strictToolNames) {
        throw buildStrictToolNameError('[stream-tool-calling]', summary);
      }
      const eventKey = `mapping:${summary}`;
      if (shouldLogRewrite(loggedRewriteEvents, eventKey)) {
        console.warn(`[stream-tool-calling] Sanitized tool map function names: ${summary}`);
      }
    }

    const rawToolDefs = opts.getToolDefs
      ? opts.getToolDefs()
      : opts.toolDefs ?? buildToolDefsFromMapping(opts.toolMap, nameMapping);
    const sanitizedDefs = sanitizeToolDefsForProvider(rawToolDefs);
    if (sanitizedDefs.rewrites.length > 0 && strictToolNames) {
      const summary = formatToolNameRewriteSummary(
        sanitizedDefs.rewrites.map((r) => ({
          sourceName: r.originalName,
          rewrittenName: r.sanitizedName,
          reason: r.reason,
        })),
      );
      throw buildStrictToolNameError('[stream-tool-calling]', summary);
    }
    const toolDefs = sanitizedDefs.toolDefs;

    // Stream the LLM response, yielding tokens as they arrive.
    let roundText = '';
    const roundGen = streamOneRound(toolDefs, opts.signal);
    let roundResult = await roundGen.next();
    while (!roundResult.done) {
      const token = roundResult.value;
      roundText += token;
      fullText += token;
      yield token;
      roundResult = await roundGen.next();
    }
    const { toolCalls, finishReason } = roundResult.value;

    if (opts.signal?.aborted) break;

    // No tool calls — model is done generating text.
    if (toolCalls.length === 0 || finishReason === 'stop' || finishReason === 'abort') {
      // Strip think tags.
      let content = fullText.trim();
      content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
      content = content.replace(/\*{0,2}<think>[\s\S]*?<\/think>\*{0,2}\s*/g, '').trim();

      // Content security (post-LLM output check).
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
        } catch { /* non-fatal */ }
      }

      opts.messages.push({ role: 'assistant', content: content || '(no content)' });
      return content || '';
    }

    // --- Tool calls: push assistant message, execute tools, loop ---
    const rawToolCallMessages = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    }));

    opts.messages.push({
      role: 'assistant',
      content: roundText || null,
      tool_calls: rawToolCallMessages,
    });

    // Execute each tool call (blocking — tool execution is not streamed).
    let earlyReturn: string | null = null;
    for (const tc of toolCalls) {
      if (opts.signal?.aborted) break;

      const resolvedToolKey = resolveToolMapKeyFromFunctionName({
        functionName: tc.name,
        toolMap: opts.toolMap,
        mapping: nameMapping,
        sanitizedAliasByName: sanitizedDefs.aliasBySanitizedName,
      });
      const tool = resolvedToolKey ? opts.toolMap.get(resolvedToolKey) : undefined;

      if (!tool) {
        opts.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: `Tool not found: ${tc.name}` }),
        });
        if (failClosedOnToolFailure) {
          earlyReturn = `[tool_failure_mode=fail_closed] Tool not found: ${tc.name}.`;
          break;
        }
        continue;
      }

      const toolName = tool.name || resolvedToolKey || tc.name;
      const args = tc.arguments;

      if (opts.onToolCall) {
        try { opts.onToolCall(tool, args); } catch { /* ignore */ }
      }

      // Step-up authorization.
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

      if (!authResult.authorized && !opts.dangerouslySkipPermissions) {
        if (authResult.tier === ToolRiskTier.TIER_3_SYNC_HITL) {
          const ok = await opts.askPermission(tool, args);
          if (!ok) {
            const denial = JSON.stringify({ error: `Permission denied for tool: ${toolName}` });
            opts.messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: shouldWrapToolOutputs
                ? wrapUntrustedToolOutput(denial, { toolName, toolCallId: tc.id, includeWarning: false })
                : denial,
            });
            if (failClosedOnToolFailure) {
              earlyReturn = `[tool_failure_mode=fail_closed] Permission denied for tool: ${toolName}.`;
              break;
            }
            continue;
          }
        } else {
          const denial = JSON.stringify({ error: `Permission denied for tool: ${toolName}` });
          opts.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: shouldWrapToolOutputs
              ? wrapUntrustedToolOutput(denial, { toolName, toolCallId: tc.id, includeWarning: false })
              : denial,
          });
          if (failClosedOnToolFailure) {
            earlyReturn = `[tool_failure_mode=fail_closed] Permission denied for tool: ${toolName}.`;
            break;
          }
          continue;
        }
      }

      // Execute the tool.
      const callToolContext: Record<string, unknown> = opts.onToolProgress
        ? { ...opts.toolContext, onToolProgress: (info: { phase: string; message: string; progress?: number }) => {
            try { opts.onToolProgress!({ toolName, ...info }); } catch { /* ignore */ }
          } }
        : opts.toolContext;

      const start = Date.now();
      let result: { success: boolean; output?: unknown; error?: string };
      try {
        // Guardrails check.
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
          result = {
            success: false,
            error: guardrailsCheck.reason,
          };
        } else {
          result = await tool.execute(args, callToolContext);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        result = { success: false, error: `Tool threw: ${errMsg}` };
      }

      const durationMs = Math.max(0, Date.now() - start);
      if (opts.onToolResult) {
        try {
          opts.onToolResult({
            toolName,
            args,
            success: result?.success === true,
            error: result?.success ? undefined : (result?.error || 'Tool failed'),
            durationMs,
          });
        } catch { /* ignore */ }
      }

      let payload: unknown;
      if (result?.success) {
        payload = redactToolOutputForLLM(result.output);
      } else {
        const errorMsg = result?.error || 'Tool failed';
        const fallbacks = TOOL_FALLBACK_MAP[toolName];
        const availableFallbacks = fallbacks?.filter(f => opts.toolMap?.has(f));
        payload = {
          error: errorMsg,
          ...(availableFallbacks?.length ? { suggestedFallbacks: availableFallbacks } : null),
        };
      }

      const json = safeJsonStringify(payload, 20000);
      const content = shouldWrapToolOutputs
        ? wrapUntrustedToolOutput(json, { toolName, toolCallId: tc.id, includeWarning: true })
        : json;
      opts.messages.push({ role: 'tool', tool_call_id: tc.id, content });

      if (!result?.success && failClosedOnToolFailure) {
        earlyReturn = `[tool_failure_mode=fail_closed] Tool ${toolName} failed: ${result?.error || 'Tool failed'}`;
        break;
      }
    }

    if (earlyReturn !== null) {
      opts.messages.push({ role: 'assistant', content: earlyReturn });
      return earlyReturn;
    }

    // Reset per-round text — the next round's text delta will accumulate freshly.
    roundText = '';
    // Continue to the next round (tool results are now in messages).
  }

  // Exceeded max rounds without a natural stop.
  return fullText || '';
}
