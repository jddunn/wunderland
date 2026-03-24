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
