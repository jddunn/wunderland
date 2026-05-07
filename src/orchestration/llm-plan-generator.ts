/**
 * @file llm-plan-generator.ts
 * @description Opt-in LLM-driven plan generator for YAML missions.
 *
 * When a YAML mission sets `planner.style: 'llm'`, the wunderland mission
 * compiler calls this generator to ask an LLM to decompose the goal into a
 * `SimplePlan` (the same step-list shape produced by the built-in stub
 * templates). The compiled plan is then injected into agentos via the new
 * `plannerConfig.plan` field, where it bypasses style-based template
 * selection.
 *
 * Two design choices worth noting:
 *
 * 1. Cache by goal text. Process-lifetime memo so re-running the same YAML
 *    (or compiling it twice in one process — explain + run, or test
 *    fixtures) doesn't re-invoke the LLM. The cache is in-memory only.
 *
 * 2. Strict shape validation up front. The agentos compiler will also
 *    validate, but we do a first pass here so error messages mention the
 *    LLM call explicitly and reference the meta-prompt that produced the
 *    bad output. Catches "model returned 12 steps" before the user sees
 *    a generic compiler error.
 */

import type { SimplePlan } from '@framers/agentos/orchestration';

/**
 * Caller-supplied callable that issues a single LLM completion. Signature
 * intentionally minimal so callers don't have to pull in any specific
 * provider SDK; wrap whatever your runtime uses.
 */
export type LlmCaller = (prompt: string) => Promise<string>;

export interface GenerateLlmPlanOptions {
  /** The user-authored mission goal (typically with `{{var}}` placeholders unsubstituted). */
  goal: string;
  /** Function that issues a single LLM completion call and returns the text response. */
  llmCaller: LlmCaller;
  /**
   * Hard cap on the number of steps the LLM may emit. The meta-prompt also
   * communicates this to the model, but we enforce it again on parse so a
   * model that ignores instructions can't blow up the graph.
   * Default: 8.
   */
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 8;

const META_PROMPT_VERSION = 1;
const META_PROMPT = (goal: string, maxSteps: number) =>
  `You are decomposing a research/writing/analysis goal into a sequence of plan steps that an autonomous agent will execute. Return ONLY a JSON object — no commentary, no markdown fences — matching this schema exactly:

{
  "steps": [
    {
      "id": "<short-kebab-case-identifier>",
      "action": "reasoning",
      "description": "<single-paragraph directive for the LLM agent including the original goal>",
      "phase": "gather" | "process" | "validate" | "deliver",
      "maxIterations": <integer 1-10>
    }
  ]
}

Rules:
- Emit between 2 and ${maxSteps} steps total.
- Every step's "description" must explicitly carry the user's goal.
- Step ids must be unique short kebab-case (e.g. "search-papers", "draft-summary").
- "action" must be exactly "reasoning" — the agent runtime decides which tools to call inside each step.
- "phase" categories roughly: gather (research / data collection / tool calls), process (synthesis / dedupe / analysis), validate (quality / consistency check), deliver (final answer formatting).
- "maxIterations": ~5-8 for tool-heavy gather steps, ~2-3 for reasoning-only synthesis/deliver steps.

Goal: ${goal}

Return JSON only:`;

/**
 * Process-lifetime cache keyed by `${metaPromptVersion}:${goal}` so a meta-
 * prompt change invalidates old cache entries automatically. Exported via
 * clearLlmPlanCache for tests.
 */
const cache = new Map<string, SimplePlan>();

export function clearLlmPlanCache(): void {
  cache.clear();
}

/**
 * Strip optional ```json … ``` or ``` … ``` markdown code fences that
 * models often add despite the meta-prompt asking for raw JSON. Returns
 * the inner text trimmed.
 */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  // ```json\n...\n``` or ```\n...\n```
  const fenced = trimmed.match(/^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```$/);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

/**
 * Parse + validate the LLM's response into a SimplePlan. Throws with a
 * descriptive message on failure so callers can surface why the LLM
 * planner couldn't be used (e.g. "model returned 12 steps, max 8").
 */
function parseAndValidate(rawResponse: string, maxSteps: number): SimplePlan {
  const stripped = stripCodeFences(rawResponse);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`generateLlmPlan: failed to parse LLM response as JSON — ${message}. Response head: ${stripped.slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { steps?: unknown }).steps)) {
    throw new Error('generateLlmPlan: response missing required "steps" array.');
  }
  const steps = (parsed as { steps: unknown[] }).steps;
  if (steps.length === 0) {
    throw new Error('generateLlmPlan: response contained at least one step (got empty steps array).');
  }
  if (steps.length > maxSteps) {
    throw new Error(`generateLlmPlan: too many steps — got ${steps.length}, max ${maxSteps}. Lower maxSteps or tighten the meta-prompt.`);
  }
  return parsed as SimplePlan;
}

/**
 * Ask the LLM to decompose the supplied goal into a {@link SimplePlan}.
 * Caches by `${metaPromptVersion}:${goal}` for the lifetime of the process.
 *
 * Errors propagate — callers (notably wunderland's compileMissionYaml)
 * should catch and decide whether to fall back to a stub template or
 * surface to the user.
 */
export async function generateLlmPlan(opts: GenerateLlmPlanOptions): Promise<SimplePlan> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  // Cache key includes maxSteps because the meta-prompt embeds it as a
  // hard cap — two callers with different step budgets need distinct cache
  // entries even for an otherwise identical goal.
  const cacheKey = `${META_PROMPT_VERSION}:${maxSteps}:${opts.goal}`;

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const prompt = META_PROMPT(opts.goal, maxSteps);
  const response = await opts.llmCaller(prompt);
  const plan = parseAndValidate(response, maxSteps);

  cache.set(cacheKey, plan);
  return plan;
}
