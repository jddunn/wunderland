/**
 * @file llm-stream-adapter.ts
 * Bridges Wunderland's single-response LLM calls to the AsyncGenerator interface
 * consumed by AgentOS LoopController.
 *
 * The AgentOS `LoopController` expects an `AsyncGenerator<LoopChunk, LoopOutput>` so
 * it can process incremental events (text deltas, tool-call requests) as they arrive.
 * Wunderland's existing LLM wrappers return a fully-resolved OpenAI-compatible response
 * object. `wrapLLMAsGenerator` adapts that single-shot response into the streaming
 * generator contract without requiring actual HTTP streaming support.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single event emitted by the generator while the LLM response is being
 * processed.  LoopController pattern-matches on `type` to route handling.
 *
 * - `'text_delta'`       — a chunk of assistant text content.
 * - `'tool_call_request'` — one or more tool invocations the model wants to make.
 */
export interface LoopChunk {
  type: 'text_delta' | 'tool_call_request';
  /** Present when `type === 'text_delta'`. */
  content?: string;
  /** Present when `type === 'tool_call_request'`. */
  toolCalls?: ToolCallRequest[];
}

/**
 * The resolved value returned by the generator (accessible via the `value`
 * field of the final `{ done: true }` iteration result).  Summarises
 * everything the model produced so LoopController can record it.
 */
export interface LoopOutput {
  /** Full assistant text response, or an empty string when the model only
   *  issued tool calls. */
  responseText: string;
  /** All tool calls parsed from the response, in order. */
  toolCalls: ToolCallRequest[];
  /** The `finish_reason` string from the underlying API response
   *  (e.g. `'stop'`, `'tool_calls'`, `'length'`). */
  finishReason: string;
}

/**
 * A normalised representation of a single model-requested tool invocation,
 * independent of provider-specific wire formats.
 */
export interface ToolCallRequest {
  /** Opaque identifier echoed back when submitting tool results. */
  id: string;
  /** Name of the tool / function to call. */
  name: string;
  /** Parsed argument object. */
  arguments: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Wraps a single-response LLM call as an async generator compatible with
 * `LoopController`.
 *
 * **Generator protocol**
 * 1. Awaits the `callLLM` promise to obtain a full OpenAI-compatible response.
 * 2. If the response contains assistant text, yields a `text_delta` chunk.
 * 3. If the response contains tool calls, yields a `tool_call_request` chunk.
 * 4. Returns a {@link LoopOutput} summary as the generator return value.
 *
 * **Why `.next()` instead of `for-await-of`?**
 * Callers that need the `LoopOutput` return value *must* use manual `.next()`
 * iteration and inspect `result.value` when `result.done === true`, because
 * `for-await-of` silently discards the generator return value.
 *
 * @param callLLM - Zero-argument async factory that performs the LLM call and
 *   resolves to an OpenAI-compatible chat-completion response object.
 *
 * @example
 * ```typescript
 * const gen = wrapLLMAsGenerator(() => openai.chat.completions.create({ ... }));
 * let result = await gen.next();
 * while (!result.done) {
 *   handleChunk(result.value);   // LoopChunk
 *   result = await gen.next();
 * }
 * const output = result.value;   // LoopOutput
 * ```
 */
export async function* wrapLLMAsGenerator(
  callLLM: () => Promise<unknown>,
): AsyncGenerator<LoopChunk, LoopOutput, undefined> {
  // Invoke the LLM and extract the first choice's message.
  const response = await callLLM();
  const choice = (response as any)?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const text: string = message.content ?? '';
  const finishReason: string = choice.finish_reason ?? 'stop';

  // --- Text delta -------------------------------------------------------
  if (text) {
    yield { type: 'text_delta', content: text };
  }

  // --- Tool calls -------------------------------------------------------
  const rawToolCalls: unknown[] = message.tool_calls ?? [];

  const toolCalls: ToolCallRequest[] = rawToolCalls.map((tc: any) => {
    // Parse arguments — the OpenAI API serialises them as a JSON string;
    // some mock/internal callers may already provide a plain object.
    let parsedArgs: Record<string, unknown>;
    if (typeof tc.function?.arguments === 'string') {
      try {
        parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        // Malformed JSON — surface as an empty object to avoid crashing.
        parsedArgs = {};
      }
    } else {
      parsedArgs = (tc.function?.arguments as Record<string, unknown>) ?? {};
    }

    return {
      id: tc.id ?? `tc-${Date.now()}`,
      name: tc.function?.name ?? tc.name ?? 'unknown',
      arguments: parsedArgs,
    };
  });

  if (toolCalls.length > 0) {
    yield { type: 'tool_call_request', toolCalls };
  }

  return { responseText: text, toolCalls, finishReason };
}

// ---------------------------------------------------------------------------
// Streaming SSE adapter
// ---------------------------------------------------------------------------

/**
 * The incremental delta object inside a single SSE chunk.
 *
 * OpenAI's streaming API (`stream: true`) sends these deltas as partial
 * updates. Text content arrives token-by-token in `content`, while tool
 * calls arrive as fragments that must be accumulated across multiple
 * deltas by matching on `tool_calls[].index`.
 *
 * @see https://platform.openai.com/docs/api-reference/chat/streaming
 */
interface StreamDelta {
  /** Partial text token (may be `null` when only tool call fragments arrive). */
  content?: string | null;
  /**
   * Partial tool call fragments. Each fragment carries an `index` that
   * identifies which tool call it belongs to. The `id` and `function.name`
   * fields appear only in the first fragment for a given index; subsequent
   * fragments for the same index append to `function.arguments`.
   */
  tool_calls?: Array<{
    /** Zero-based index identifying which parallel tool call this fragment belongs to. */
    index: number;
    /** Tool call identifier — present only in the first fragment for this index. */
    id?: string;
    function?: {
      /** Tool/function name — present only in the first fragment for this index. */
      name?: string;
      /** JSON argument fragment to be concatenated across deltas. */
      arguments?: string;
    };
  }>;
}

/**
 * A single choice inside a streaming chunk. Mirrors the non-streaming
 * `ChatCompletionChoice` but uses `delta` instead of `message`.
 */
interface StreamChoice {
  /** Incremental content/tool-call fragment for this choice. */
  delta?: StreamDelta;
  /**
   * Non-null only on the final chunk for this choice.
   * Values: `'stop'`, `'tool_calls'`, `'length'`, `'content_filter'`.
   */
  finish_reason?: string | null;
}

/**
 * Top-level object decoded from a single SSE `data:` line.
 *
 * The OpenAI streaming protocol sends one of these per SSE event.
 * The stream terminates with a sentinel `data: [DONE]` line that is
 * handled separately in {@link parseSSELine}.
 */
interface StreamChunk {
  choices?: StreamChoice[];
  model?: string;
  usage?: unknown;
}

/**
 * Parses a single `data:` line from an SSE stream into a typed chunk.
 *
 * Returns `null` for any line that does not contain actionable data:
 * - Empty or whitespace-only lines (SSE comment/keepalive boundaries).
 * - Lines that do not start with `data:` (SSE field names like `event:`).
 * - The `[DONE]` sentinel that signals end-of-stream.
 * - Lines whose `data:` payload is malformed JSON.
 *
 * Malformed JSON lines are silently skipped rather than throwing because
 * some proxy/CDN layers may inject non-JSON keepalive lines into the SSE
 * stream (e.g. Cloudflare edge keepalives). Throwing would abort the
 * entire stream for a single corrupt line, which is too aggressive given
 * that the LLM response may still be recoverable from subsequent chunks.
 *
 * @param line - A single line from the SSE stream (may include the
 *   `data: ` prefix and surrounding whitespace).
 * @returns The parsed chunk, or `null` if the line should be skipped.
 */
function parseSSELine(line: string): StreamChunk | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') return null;
  try {
    return JSON.parse(payload) as StreamChunk;
  } catch {
    // Silently skip malformed lines — see JSDoc above for rationale.
    return null;
  }
}

/**
 * Wraps a streaming (SSE) LLM response as an async generator compatible with
 * `LoopController`. Unlike {@link wrapLLMAsGenerator}, this adapter yields
 * **individual text tokens** as they arrive from the SSE stream, enabling
 * real-time TTS playback before the full LLM response completes.
 *
 * ## Generator protocol
 *
 * 1. Accepts an async iterable of raw SSE lines from the streaming HTTP response.
 * 2. For each text delta, yields a `text_delta` chunk immediately.
 * 3. Accumulates tool-call fragments across deltas and yields a single
 *    `tool_call_request` chunk once the stream ends with tool calls.
 * 4. Returns a {@link LoopOutput} summary as the generator return value.
 *
 * ## Tool-call fragment accumulation
 *
 * The OpenAI streaming API splits tool calls across multiple SSE events.
 * Each fragment carries an `index` field identifying which parallel tool
 * call it belongs to. The first fragment for an index contains the `id`
 * and `function.name`; subsequent fragments append to `function.arguments`.
 * This generator accumulates fragments in a `Map<index, accumulator>` and
 * assembles the final {@link ToolCallRequest} array only after the stream
 * ends, sorted by index to preserve the model's intended call order.
 *
 * ## Why tool calls are yielded at the end (not incrementally)
 *
 * Text tokens are useful mid-stream (for TTS), but tool call fragments
 * are not actionable until the full JSON arguments string is complete.
 * Yielding partial tool calls would force callers to re-assemble fragments
 * themselves, adding complexity with no latency benefit.
 *
 * @param sseLines - Async iterable that produces raw SSE lines (including
 *   the `data: ` prefix). Typically created by splitting the streaming
 *   response body on newline boundaries.
 * @yields {LoopChunk} Individual `text_delta` chunks for each token, then
 *   a single `tool_call_request` chunk if the model requested tool calls.
 * @returns {LoopOutput} Summary of the full response (accumulated text,
 *   assembled tool calls, finish reason).
 *
 * @example
 * ```ts
 * const sseLines = streamingChatCompletionsRequest(provider, messages, tools, 0.2, 1400);
 * const gen = wrapStreamingLLMAsGenerator(sseLines);
 * let result = await gen.next();
 * while (!result.done) {
 *   if (result.value.type === 'text_delta') {
 *     process.stdout.write(result.value.content ?? '');
 *   }
 *   result = await gen.next();
 * }
 * const { responseText, toolCalls, finishReason } = result.value;
 * ```
 *
 * @see {@link wrapLLMAsGenerator} for the non-streaming single-shot adapter.
 * @see {@link parseSSELine} for the per-line SSE parser.
 */
export async function* wrapStreamingLLMAsGenerator(
  sseLines: AsyncIterable<string>,
): AsyncGenerator<LoopChunk, LoopOutput, undefined> {
  let fullText = '';
  let finishReason = 'stop';

  // Accumulate tool-call fragments keyed by their index. The index is
  // stable across deltas for the same tool call, so we can concatenate
  // the `function.arguments` JSON fragments in order.
  const toolCallAccumulators = new Map<number, {
    id: string;
    name: string;
    argumentsJson: string;
  }>();

  for await (const line of sseLines) {
    const chunk = parseSSELine(line);
    // Skip non-actionable lines (comments, keepalives, malformed JSON).
    if (!chunk?.choices?.length) continue;

    const choice = chunk.choices[0];
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }

    const delta = choice.delta;
    if (!delta) continue;

    // --- Streaming text content ---
    // Yield each text token immediately so the TTS engine can begin
    // synthesizing audio with minimal latency.
    if (delta.content) {
      fullText += delta.content;
      yield { type: 'text_delta', content: delta.content };
    }

    // --- Streaming tool call fragments ---
    // Accumulate fragments by index; do NOT yield them yet because the
    // arguments JSON is incomplete until the stream finishes.
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        let acc = toolCallAccumulators.get(idx);
        if (!acc) {
          acc = { id: '', name: '', argumentsJson: '' };
          toolCallAccumulators.set(idx, acc);
        }
        if (tc.id) acc.id = tc.id;
        // Name fragments are concatenated — in practice the name arrives
        // in a single delta, but the protocol does not guarantee this.
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.argumentsJson += tc.function.arguments;
      }
    }
  }

  // --- Assemble final tool calls from accumulated fragments ---
  // Sort by index to preserve the model's intended invocation order.
  const toolCalls: ToolCallRequest[] = [];
  const sortedEntries = [...toolCallAccumulators.entries()].sort(
    ([a], [b]) => a - b,
  );
  for (const [, acc] of sortedEntries) {
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(acc.argumentsJson) as Record<string, unknown>;
    } catch {
      // Malformed arguments JSON — surface as empty object rather than
      // crashing the entire turn.
      parsedArgs = {};
    }
    toolCalls.push({
      id: acc.id || `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: acc.name || 'unknown',
      arguments: parsedArgs,
    });
  }

  if (toolCalls.length > 0) {
    yield { type: 'tool_call_request', toolCalls };
  }

  return { responseText: fullText, toolCalls, finishReason };
}
