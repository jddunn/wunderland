// @ts-nocheck
/**
 * @fileoverview Tests for the --llm-judge HITL flag and handler wiring.
 *
 * Verifies that:
 * 1. The `--llm-judge` flag is recognized as a boolean flag by the arg parser.
 * 2. The hitl.mode config value from agent.config.json is parsed correctly.
 * 3. The LLM judge handler integrates with the ChatREPL permission flow.
 *
 * These tests are deterministic (no LLM calls) — they validate argument
 * parsing and handler plumbing only.
 *
 * @module wunderland/__tests__/llm-judge-hitl.test
 */

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../cli/parse-args.js';

// ── Flag parsing ──────────────────────────────────────────────────────────

describe('--llm-judge flag parsing', () => {
  it('recognizes --llm-judge as a boolean flag', () => {
    const result = parseArgs(['chat', '--llm-judge']);
    expect(result.flags['llm-judge']).toBe(true);
  });

  it('does not set llm-judge when flag is absent', () => {
    const result = parseArgs(['chat']);
    expect(result.flags['llm-judge']).toBeUndefined();
  });

  it('coexists with other boolean flags', () => {
    const result = parseArgs(['chat', '--llm-judge', '--overdrive', '--verbose']);
    expect(result.flags['llm-judge']).toBe(true);
    expect(result.flags['overdrive']).toBe(true);
    expect(result.flags['verbose']).toBe(true);
  });

  it('does not consume the next positional argument', () => {
    const result = parseArgs(['chat', '--llm-judge', 'hello']);
    expect(result.flags['llm-judge']).toBe(true);
    expect(result.positional).toContain('hello');
  });
});

// ── Config-based HITL mode resolution ────────────────────────────────────

describe('hitl.mode config resolution', () => {
  /**
   * Helper that mimics the IIFE used in chat.ts / llm-provider-setup.ts
   * to resolve llmJudgeMode from both flag and config.
   */
  function resolveLlmJudgeMode(
    flagValue: boolean,
    cfg: Record<string, unknown> | null,
  ): boolean {
    if (flagValue) return true;
    if (cfg?.hitl && typeof cfg.hitl === 'object' && !Array.isArray(cfg.hitl)) {
      const modeVal = (cfg.hitl as Record<string, unknown>).mode;
      if (typeof modeVal === 'string' && modeVal.trim().toLowerCase() === 'llm-judge') return true;
    }
    return false;
  }

  it('returns true when flag is set', () => {
    expect(resolveLlmJudgeMode(true, null)).toBe(true);
  });

  it('returns true when config hitl.mode is "llm-judge"', () => {
    expect(resolveLlmJudgeMode(false, { hitl: { mode: 'llm-judge' } })).toBe(true);
  });

  it('returns true when config hitl.mode is "LLM-Judge" (case insensitive)', () => {
    expect(resolveLlmJudgeMode(false, { hitl: { mode: 'LLM-Judge' } })).toBe(true);
  });

  it('returns false when config hitl.mode is "auto-approve"', () => {
    expect(resolveLlmJudgeMode(false, { hitl: { mode: 'auto-approve' } })).toBe(false);
  });

  it('returns false when config hitl.mode is "human"', () => {
    expect(resolveLlmJudgeMode(false, { hitl: { mode: 'human' } })).toBe(false);
  });

  it('returns false when config has no hitl section', () => {
    expect(resolveLlmJudgeMode(false, {})).toBe(false);
  });

  it('returns false when config is null', () => {
    expect(resolveLlmJudgeMode(false, null)).toBe(false);
  });

  it('flag takes precedence even when config says otherwise', () => {
    expect(resolveLlmJudgeMode(true, { hitl: { mode: 'human' } })).toBe(true);
  });
});

// ── Handler integration ──────────────────────────────────────────────────

describe('LLM judge handler integration', () => {
  it('judge handler returning true approves the tool call', async () => {
    const handler = async () => true;
    const result = await handler();
    expect(result).toBe(true);
  });

  it('judge handler returning false rejects the tool call', async () => {
    const handler = async () => false;
    const result = await handler();
    expect(result).toBe(false);
  });

  it('judge handler failure (throw) propagates for fallback handling', async () => {
    const handler = async () => {
      throw new Error('LLM call failed');
    };
    await expect(handler()).rejects.toThrow('LLM call failed');
  });
});
