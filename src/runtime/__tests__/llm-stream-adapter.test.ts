// @ts-nocheck
/**
 * @file llm-stream-adapter.test.ts
 * Unit tests for wrapLLMAsGenerator.
 *
 * All tests consume the generator via manual `.next()` calls (NOT for-await-of)
 * so that the final `LoopOutput` return value — accessible only when
 * `done === true` — can be captured and asserted.
 */

import { describe, it, expect } from 'vitest';
import {
  wrapLLMAsGenerator,
  type LoopChunk,
  type LoopOutput,
} from '../llm-stream-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drain a generator, collecting all yielded chunks and the final return value.
 */
async function drain(
  gen: AsyncGenerator<LoopChunk, LoopOutput, undefined>,
): Promise<{ chunks: LoopChunk[]; output: LoopOutput }> {
  const chunks: LoopChunk[] = [];
  let result = await gen.next();
  while (!result.done) {
    chunks.push(result.value as LoopChunk);
    result = await gen.next();
  }
  return { chunks, output: result.value as LoopOutput };
}

/** Build a minimal OpenAI-style response. */
function makeResponse(overrides: {
  content?: string | null;
  tool_calls?: unknown[];
  finish_reason?: string;
}) {
  return {
    choices: [
      {
        message: {
          content: overrides.content ?? null,
          tool_calls: overrides.tool_calls ?? undefined,
        },
        finish_reason: overrides.finish_reason ?? 'stop',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wrapLLMAsGenerator', () => {
  // 1. Text-only response
  it('yields a text_delta chunk for a text-only response', async () => {
    const response = makeResponse({ content: 'Hello, world!', finish_reason: 'stop' });
    const gen = wrapLLMAsGenerator(async () => response);

    const { chunks, output } = await drain(gen);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ type: 'text_delta', content: 'Hello, world!' });
    expect(output).toEqual({
      responseText: 'Hello, world!',
      toolCalls: [],
      finishReason: 'stop',
    });
  });

  // 2. Tool-calling response (no text)
  it('yields a tool_call_request chunk for a tool-calling response', async () => {
    const response = makeResponse({
      finish_reason: 'tool_calls',
      tool_calls: [
        {
          id: 'call_abc',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        },
      ],
    });
    const gen = wrapLLMAsGenerator(async () => response);

    const { chunks, output } = await drain(gen);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('tool_call_request');
    expect(chunks[0].toolCalls).toHaveLength(1);
    expect(chunks[0].toolCalls![0]).toEqual({
      id: 'call_abc',
      name: 'get_weather',
      arguments: { city: 'Paris' },
    });
    expect(output.toolCalls).toHaveLength(1);
    expect(output.finishReason).toBe('tool_calls');
    expect(output.responseText).toBe('');
  });

  // 3. Both text and tool calls
  it('yields text_delta then tool_call_request when response has both', async () => {
    const response = makeResponse({
      content: 'Let me check that for you.',
      finish_reason: 'tool_calls',
      tool_calls: [
        {
          id: 'call_xyz',
          function: { name: 'search', arguments: '{"query":"vitest"}' },
        },
      ],
    });
    const gen = wrapLLMAsGenerator(async () => response);

    const { chunks, output } = await drain(gen);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({
      type: 'text_delta',
      content: 'Let me check that for you.',
    });
    expect(chunks[1].type).toBe('tool_call_request');
    expect(chunks[1].toolCalls![0].name).toBe('search');
    expect(output.responseText).toBe('Let me check that for you.');
    expect(output.toolCalls).toHaveLength(1);
  });

  // 4. Empty / null response
  it('handles an empty response gracefully without yielding any chunks', async () => {
    const gen = wrapLLMAsGenerator(async () => null);

    const { chunks, output } = await drain(gen);

    expect(chunks).toHaveLength(0);
    expect(output).toEqual({
      responseText: '',
      toolCalls: [],
      finishReason: 'stop',
    });
  });

  // 5. Stringified function arguments
  it('parses stringified JSON function arguments into a plain object', async () => {
    const args = { lat: 48.8566, lon: 2.3522, unit: 'celsius' };
    const response = makeResponse({
      finish_reason: 'tool_calls',
      tool_calls: [
        {
          id: 'call_geo',
          function: { name: 'get_forecast', arguments: JSON.stringify(args) },
        },
      ],
    });
    const gen = wrapLLMAsGenerator(async () => response);

    const { chunks } = await drain(gen);

    expect(chunks[0].toolCalls![0].arguments).toEqual(args);
  });

  // 6. Missing / undefined fields
  it('handles missing fields without crashing and falls back to safe defaults', async () => {
    // Response with no choices array at all
    const gen1 = wrapLLMAsGenerator(async () => ({}));
    const { chunks: c1, output: o1 } = await drain(gen1);
    expect(c1).toHaveLength(0);
    expect(o1.finishReason).toBe('stop');

    // Tool call entry missing `id` and `function.name`
    const response = makeResponse({
      finish_reason: 'tool_calls',
      tool_calls: [{ function: { arguments: '{}' } }],
    });
    const gen2 = wrapLLMAsGenerator(async () => response);
    const { chunks: c2 } = await drain(gen2);
    const tc = c2[0].toolCalls![0];
    expect(tc.name).toBe('unknown');
    expect(typeof tc.id).toBe('string');
    expect(tc.id.length).toBeGreaterThan(0);
    expect(tc.arguments).toEqual({});
  });
});
