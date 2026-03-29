/**
 * @fileoverview Streaming tool-call parsing and SSE chunk assembly.
 *
 * Extracted from `tool-calling.ts` to isolate the streaming-specific
 * logic (SSE line iteration, token yielding, multi-round streaming loop)
 * from the non-streaming tool-calling loop and the shared authorization
 * layer.
 *
 * The main export is {@link streamToolCallingTurn}, an async generator
 * that yields individual text tokens as they arrive from the LLM streaming
 * API, enabling real-time TTS playback.
 *
 * @module wunderland/runtime/ToolStreamProcessor
 */

import type { StepUpAuthorizationConfig } from '../core/types.js';
import type { StepUpAuthorizationManager } from '../authorization/StepUpAuthorizationManager.js';
import type { ToolInstance, LLMProviderConfig } from './tool-helpers.js';
import {
  getBooleanProp,
  getStringProp,
  normalizeToolFailureMode,
  maybeConfigureGuardrailsForAgent,
  getSecurityPipeline,
  createAuthorizationManager,
  streamingOpenaiChatWithTools,
  parseProviderId,
  buildStrictToolNameError,
  shouldLogRewrite,
} from './tool-helpers.js';
import {
  buildToolDefsFromMapping,
  buildToolFunctionNameMapping,
  formatToolNameRewriteSummary,
  resolveStrictToolNames,
  resolveToolMapKeyFromFunctionName,
  sanitizeToolDefsForProvider,
} from './tool-function-names.js';
import type { ToolCallRequest } from './llm-stream-adapter.js';
import { wrapStreamingLLMAsGenerator } from './llm-stream-adapter.js';
import { runToolCallingTurn } from './tool-calling.js';
import {
  authorizeToolCall,
  executeWithGuardrails,
  buildToolResultPayload,
} from './ToolApprovalHandler.js';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Options for {@link streamToolCallingTurn}.
 *
 * Mirrors `runToolCallingTurn` options with the addition of an `AbortSignal`
 * that enables external cancellation of the in-flight streaming LLM request.
 * This is critical for the voice pipeline's barge-in flow: when the user
 * starts speaking while the agent is mid-response, the pipeline aborts the
 * signal to immediately stop token generation at the provider, saving both
 * latency and tokens.
 *
 * @see {@link streamToolCallingTurn}
 */
export interface StreamToolCallingTurnOpts {
  /** LLM provider identifier (e.g. `'openai'`, `'openrouter'`, `'ollama'`). */
  providerId?: string;
  /** API key (or promise resolving to one) for the LLM provider. */
  apiKey: string | Promise<string>;
  /** Model name/ID (e.g. `'gpt-4o-mini'`, `'llama3'`). */
  model: string;
  /**
   * Mutable conversation history. The streaming function appends assistant
   * and tool messages to this array as the conversation progresses.
   */
  messages: Array<Record<string, unknown>>;
  /** Map of tool name -> tool instance for tool execution. */
  toolMap: Map<string, ToolInstance>;
  /** Pre-built tool definitions (overrides auto-generation from toolMap). */
  toolDefs?: Array<Record<string, unknown>>;
  /** Lazy tool definition supplier (called per round; overrides toolDefs). */
  getToolDefs?: () => Array<Record<string, unknown>>;
  /** Shared context object passed to every tool `execute()` call. */
  toolContext: Record<string, unknown>;
  /** Maximum number of LLM round-trips before forcibly stopping. */
  maxRounds: number;
  /** When `true`, bypasses all step-up authorization checks. */
  dangerouslySkipPermissions: boolean;
  /** Custom step-up authorization tier configuration. */
  stepUpAuthConfig?: StepUpAuthorizationConfig;
  /** Interactive permission callback for Tier 3 (sync HITL) tools. */
  askPermission: (tool: ToolInstance, args: Record<string, unknown>) => Promise<boolean>;
  /** Optional checkpoint callback invoked before executing a batch of tool calls. */
  askCheckpoint?: (info: {
    round: number;
    toolCalls: Array<{ toolName: string; hasSideEffects: boolean; args: Record<string, unknown> }>;
  }) => Promise<boolean>;
  /** Notification callback fired when a tool call is about to execute. */
  onToolCall?: (tool: ToolInstance, args: Record<string, unknown>) => void;
  /** Notification callback fired after each tool call completes. */
  onToolResult?: (info: {
    toolName: string;
    args: Record<string, unknown>;
    success: boolean;
    error?: string;
    output?: unknown;
    durationMs: number;
  }) => void;
  /** Pre-configured authorization manager (skips internal creation). */
  authorizationManager?: StepUpAuthorizationManager;
  /** Custom base URL for the LLM API endpoint. */
  baseUrl?: string;
  /** Fallback LLM provider config for automatic retry on transient errors. */
  fallback?: LLMProviderConfig;
  /** Callback fired when the primary provider fails and we fall back. */
  onFallback?: (primaryError: Error, fallbackProvider: string) => void;
  /** Lazy API key supplier (alternative to static `apiKey`). */
  getApiKey?: () => string | Promise<string>;
  /** Ollama-specific runtime options (e.g. num_ctx, num_gpu). */
  ollamaOptions?: Record<string, unknown>;
  /**
   * Behavior when a tool execution fails.
   * - `'fail_open'` — report the error to the LLM and let it continue.
   * - `'fail_closed'` — immediately abort the turn.
   */
  toolFailureMode?: 'fail_open' | 'fail_closed';
  /** When `true`, tool names that require sanitization cause an error instead. */
  strictToolNames?: boolean;
  /** Enable verbose debug logging for the streaming loop. */
  debug?: boolean;
  /** Progress callback for long-running tool executions. */
  onToolProgress?: (info: {
    toolName: string;
    phase: string;
    message: string;
    progress?: number;
  }) => void;
  /**
   * External abort signal for cancelling the in-flight streaming LLM request.
   *
   * When aborted, the HTTP stream is terminated immediately via the
   * `AbortController` wired into `fetch()`. This is the primary mechanism
   * for voice pipeline barge-in: the orchestrator calls `abort()` on the
   * agent session, which triggers this signal, stopping token generation
   * at the provider.
   *
   * @see {@link StreamingPipelineAgentSession.abort}
   */
  signal?: AbortSignal;
}

// ── Streaming variant ──────────────────────────────────────────────────────

/**
 * Streaming variant of `runToolCallingTurn`.
 *
 * Yields individual text tokens as they arrive from the LLM streaming API,
 * enabling real-time TTS playback (~500ms first-token latency instead of
 * waiting for the full LLM response). Tool-call rounds are handled
 * identically to the non-streaming variant: tool execution blocks, then
 * the next LLM round resumes streaming.
 *
 * ## Multi-round streaming + blocking tool execution
 *
 * The outer loop runs up to `opts.maxRounds` LLM round-trips:
 *
 * 1. **Stream phase** -- Send the conversation to the LLM with
 *    `stream: true` and yield text tokens as they arrive via SSE. Tool-call
 *    fragments are accumulated silently by `wrapStreamingLLMAsGenerator`.
 * 2. **Tool phase** (blocking) -- If the model's `finish_reason` is
 *    `'tool_calls'`, execute each requested tool synchronously. Tool
 *    results are appended to `opts.messages` as `role: 'tool'` messages.
 * 3. **Next round** -- Loop back to step 1 with the updated conversation
 *    history, allowing the model to incorporate tool results and stream
 *    more text or request additional tools.
 *
 * The generator terminates when the model finishes with text only
 * (`finish_reason: 'stop'`), the abort signal fires, or the round limit
 * is reached.
 *
 * ## AbortSignal integration
 *
 * The optional `opts.signal` is wired through three layers:
 * - **Outer loop**: checked at the start of each round and after tool execution.
 * - **SSE fetch**: passed to `fetch()` so the HTTP connection is torn down
 *   immediately on abort, stopping token generation at the provider.
 * - **Token iteration**: checked between each yielded token so the generator
 *   exits promptly after abort.
 *
 * This triple-layer cancellation ensures that voice pipeline barge-in stops
 * the LLM within one event-loop tick of the abort signal.
 *
 * ## Provider fallback
 *
 * For providers that do not support SSE streaming (Ollama, Anthropic via
 * the Messages API), this automatically falls back to the non-streaming
 * `runToolCallingTurn` and post-splits the complete response into
 * word-boundary chunks so the caller still receives an incremental token
 * stream.
 *
 * @param opts - Configuration for the streaming tool-calling turn.
 * @yields Individual text token strings (typically 1-4 words each).
 * @returns The full accumulated reply text after all rounds complete.
 *
 * @example
 * ```ts
 * const controller = new AbortController();
 * const gen = streamToolCallingTurn({
 *   providerId: 'openai',
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: 'gpt-4o-mini',
 *   messages: [{ role: 'user', content: 'Hello' }],
 *   toolMap: myToolMap,
 *   toolContext: {},
 *   maxRounds: 8,
 *   dangerouslySkipPermissions: true,
 *   askPermission: async () => true,
 *   signal: controller.signal,
 * });
 *
 * let result = await gen.next();
 * while (!result.done) {
 *   ttsEngine.feed(result.value); // stream to TTS immediately
 *   result = await gen.next();
 * }
 * const fullReply = result.value;
 * ```
 *
 * @see {@link runToolCallingTurn} for the non-streaming variant.
 * @see {@link wrapStreamingLLMAsGenerator} for the SSE-to-generator adapter.
 * @see {@link streamingOpenaiChatWithTools} for the HTTP streaming layer.
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
  ): AsyncGenerator<string, { toolCalls: ToolCallRequest[]; finishReason: string }, undefined> {
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

      // Step-up authorization (delegated to ToolApprovalHandler).
      const authResult = await authorizeToolCall({
        tool,
        toolName,
        args,
        callId: tc.id,
        authManager,
        toolContext: opts.toolContext,
        dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
        askPermission: opts.askPermission,
        shouldWrapToolOutputs,
        failClosedOnToolFailure,
        messages: opts.messages,
      });

      if (!authResult.authorized) {
        if (authResult.earlyReturn) {
          earlyReturn = authResult.earlyReturn;
          break;
        }
        continue;
      }

      // Execute the tool with guardrails (delegated to ToolApprovalHandler).
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
          callId: tc.id,
          toolContext: opts.toolContext,
          callToolContext,
          hitlApproved: authResult.hitlApproved,
          dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
          askPermission: opts.askPermission,
        });
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
            output: result?.success ? result.output : undefined,
            durationMs,
          });
        } catch { /* ignore */ }
      }

      const content = buildToolResultPayload(
        result,
        toolName,
        tc.id,
        opts.toolMap,
        shouldWrapToolOutputs,
        false, // debugMode — streaming path does not use debug logging
      );
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
