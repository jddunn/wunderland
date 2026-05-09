// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateLlmPlan, clearLlmPlanCache } from '../llm-plan-generator.js';

describe('generateLlmPlan', () => {
  beforeEach(() => {
    clearLlmPlanCache();
  });

  it('parses a clean JSON response into a SimplePlan', async () => {
    const llmCaller = vi.fn().mockResolvedValue(JSON.stringify({
      steps: [
        { id: 'survey', action: 'reasoning', description: 'Survey existing literature on quantum computing', phase: 'gather', maxIterations: 6 },
        { id: 'synthesize', action: 'reasoning', description: 'Synthesise key findings into a brief', phase: 'process', maxIterations: 2 },
        { id: 'deliver', action: 'reasoning', description: 'Produce a one-page summary with citations', phase: 'deliver', maxIterations: 2 },
      ],
    }));

    const plan = await generateLlmPlan({ goal: 'Research quantum computing in 2026', llmCaller });

    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0].id).toBe('survey');
    expect(plan.steps[0].phase).toBe('gather');
    expect(llmCaller).toHaveBeenCalledTimes(1);
  });

  it('strips markdown code fences before parsing', async () => {
    const llmCaller = vi.fn().mockResolvedValue([
      '```json',
      JSON.stringify({ steps: [{ id: 'step1', action: 'reasoning', description: 'x', phase: 'deliver' }] }),
      '```',
    ].join('\n'));

    const plan = await generateLlmPlan({ goal: 'Anything', llmCaller });
    expect(plan.steps[0].id).toBe('step1');
  });

  it('caches the generated plan by goal so repeat calls do not re-invoke the LLM', async () => {
    const llmCaller = vi.fn().mockResolvedValue(JSON.stringify({
      steps: [{ id: 'a', action: 'reasoning', description: 'x', phase: 'gather' }],
    }));

    await generateLlmPlan({ goal: 'Identical goal', llmCaller });
    await generateLlmPlan({ goal: 'Identical goal', llmCaller });
    await generateLlmPlan({ goal: 'Identical goal', llmCaller });

    expect(llmCaller).toHaveBeenCalledTimes(1);
  });

  it('does not share cache entries across different goals', async () => {
    const llmCaller = vi.fn().mockResolvedValue(JSON.stringify({
      steps: [{ id: 'a', action: 'reasoning', description: 'x', phase: 'gather' }],
    }));

    await generateLlmPlan({ goal: 'Goal A', llmCaller });
    await generateLlmPlan({ goal: 'Goal B', llmCaller });

    expect(llmCaller).toHaveBeenCalledTimes(2);
  });

  it('does not share cache entries when maxSteps differs (the meta-prompt embeds it)', async () => {
    const llmCaller = vi.fn().mockResolvedValue(JSON.stringify({
      steps: [{ id: 'a', action: 'reasoning', description: 'x', phase: 'gather' }],
    }));

    await generateLlmPlan({ goal: 'Same goal', llmCaller, maxSteps: 4 });
    await generateLlmPlan({ goal: 'Same goal', llmCaller, maxSteps: 8 });

    expect(llmCaller).toHaveBeenCalledTimes(2);
  });

  it('throws a descriptive error when the LLM returns unparseable JSON', async () => {
    const llmCaller = vi.fn().mockResolvedValue('not actually json sorry');

    await expect(generateLlmPlan({ goal: 'x', llmCaller })).rejects.toThrow(/parse|json/i);
  });

  it('throws when the LLM returns a structurally-invalid plan (missing steps array)', async () => {
    const llmCaller = vi.fn().mockResolvedValue(JSON.stringify({ notSteps: 'oops' }));

    await expect(generateLlmPlan({ goal: 'x', llmCaller })).rejects.toThrow(/steps/i);
  });

  it('throws when the LLM returns a plan with zero steps', async () => {
    const llmCaller = vi.fn().mockResolvedValue(JSON.stringify({ steps: [] }));

    await expect(generateLlmPlan({ goal: 'x', llmCaller })).rejects.toThrow(/at least one|empty/i);
  });

  it('throws when the LLM returns more than the max-step cap', async () => {
    // Default cap is 8 — anything past that is the LLM going off-rails.
    const tooMany = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`, action: 'reasoning', description: 'x', phase: 'deliver',
    }));
    const llmCaller = vi.fn().mockResolvedValue(JSON.stringify({ steps: tooMany }));

    await expect(generateLlmPlan({ goal: 'x', llmCaller })).rejects.toThrow(/too many|max.*steps|step count/i);
  });

  it('passes the goal text into the meta-prompt sent to the LLM', async () => {
    const llmCaller = vi.fn().mockResolvedValue(JSON.stringify({
      steps: [{ id: 'a', action: 'reasoning', description: 'x', phase: 'gather' }],
    }));

    await generateLlmPlan({ goal: 'Research the airspeed velocity of an unladen swallow', llmCaller });

    const callArg = llmCaller.mock.calls[0][0];
    expect(callArg).toContain('Research the airspeed velocity of an unladen swallow');
  });
});
