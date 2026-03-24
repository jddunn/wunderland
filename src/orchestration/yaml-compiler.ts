/**
 * @file yaml-compiler.ts
 * @description Compiles YAML workflow and mission definitions to AgentOS execution graphs.
 *
 * This module bridges YAML-authored automation blueprints and the AgentOS fluent builder
 * API. It parses a YAML string, validates the top-level structure, maps each declared step
 * to the correct node factory (`toolNode`, `gmiNode`, or `humanNode`), and delegates the
 * final compilation to the appropriate builder.
 *
 * Two entry points are exported:
 * - {@link compileWorkflowYaml} — deterministic, acyclic workflow (sequential/branching).
 * - {@link compileMissionYaml}  — goal-oriented mission with a planner strategy.
 *
 * @example Workflow YAML shape:
 * ```yaml
 * name: summarise
 * steps:
 *   - id: fetch
 *     tool: web_fetch
 *   - id: summarise
 *     gmi:
 *       instructions: Summarise the fetched content.
 * ```
 *
 * @example Mission YAML shape:
 * ```yaml
 * name: research
 * goal: Research {{topic}} and return a concise summary
 * planner:
 *   strategy: linear
 *   maxSteps: 6
 * ```
 */

import { parse } from 'yaml';
import { z } from 'zod';
import {
  workflow,
  mission,
} from '@framers/agentos/orchestration';

/**
 * Fallback input schema used when the YAML document does not declare an `input` field.
 * Accepts any key-value payload so the workflow/mission compiles without requiring
 * authors to spell out a schema for every automation.
 */
const OPEN_INPUT_SCHEMA = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// Internal: safe condition expression evaluator
// ---------------------------------------------------------------------------

/**
 * Rewrites a dot-path expression such as `scratch.decision` into safe optional-chain
 * access on the runtime `state` object, then wraps it in a `new Function` closure.
 *
 * The implementation deliberately avoids `with` statements, which are forbidden in
 * ESM strict-mode modules.
 *
 * Supported partitions: `scratch`, `input`, `artifacts`.
 *
 * @param expr - A simple expression string referencing state partitions.
 * @returns A function that takes a runtime `state` object and returns a string label
 *          matching one of the branch route keys.
 *
 * @example
 * ```ts
 * const fn = createConditionFn('scratch.decision');
 * fn({ scratch: { decision: 'yes' } }); // → 'yes'
 * ```
 */
function createConditionFn(expr: string): (state: any) => string {
  return (state: any) => {
    try {
      // Rewrite `partition.a.b.c` → `state.partition?.["a"]?.["b"]?.["c"]`
      const rewritten = expr.replace(
        /\b(scratch|input|artifacts)\b\.(\w+(?:\.\w+)*)/g,
        (_: string, partition: string, path: string) => {
          const parts = path.split('.');
          let access = `state.${partition}`;
          for (const p of parts) access += `?.["${p}"]`;
          return access;
        },
      );
      // eslint-disable-next-line no-new-func
      const fn = new Function('state', `return String(${rewritten});`);
      return fn(state) as string;
    } catch {
      return 'false';
    }
  };
}

// ---------------------------------------------------------------------------
// Internal: YAML step → StepConfig converter
// ---------------------------------------------------------------------------

/**
 * Represents a single step declaration in a YAML workflow definition.
 * Maps to {@link StepConfig} accepted by `WorkflowBuilder.step()`.
 */
interface YamlStepDef {
  /** Unique step identifier within the workflow. */
  id: string;
  /** Registered tool name to invoke. Mutually exclusive with `gmi` and `human`. */
  tool?: string;
  /** GMI (General Model Invocation) configuration. Mutually exclusive with `tool` and `human`. */
  gmi?: { instructions: string; maxTokens?: number };
  /** Human-in-the-loop prompt. Mutually exclusive with `tool` and `gmi`. */
  human?: { prompt: string };
  /** Optional branch condition expression (e.g. `scratch.decision`). */
  condition?: string;
  /**
   * When `condition` is set, maps route label → step config for each branch arm.
   * Each value follows the same `tool`/`gmi`/`human` shape as a regular step.
   */
  routes?: Record<string, Omit<YamlStepDef, 'id' | 'condition' | 'routes'>>;
  /** Maximum wall-clock execution time in milliseconds. */
  timeout?: number;
  /** What to do when the step fails. */
  onFailure?: 'abort' | 'skip' | 'retry';
}

/**
 * Converts a raw YAML step definition to the `StepConfig` shape expected by
 * `WorkflowBuilder.step()`.
 *
 * @param def - A single YAML step definition (may omit `id`).
 * @returns A plain `StepConfig` object.
 * @throws {Error} When none of `tool`, `gmi`, or `human` are specified.
 */
function yamlStepToConfig(def: Omit<YamlStepDef, 'id' | 'condition' | 'routes'>): any {
  if (def.tool) {
    return { tool: def.tool, timeout: def.timeout, onFailure: def.onFailure };
  }
  if (def.gmi) {
    return {
      gmi: { instructions: def.gmi.instructions, maxTokens: def.gmi.maxTokens },
      timeout: def.timeout,
      onFailure: def.onFailure,
    };
  }
  if (def.human) {
    return { human: { prompt: def.human.prompt }, timeout: def.timeout };
  }
  throw new Error(
    `YAML step must specify one of: tool, gmi, or human. Got: ${JSON.stringify(def)}`,
  );
}

// ---------------------------------------------------------------------------
// Public API: compileWorkflowYaml
// ---------------------------------------------------------------------------

/**
 * Parses a YAML string describing a workflow and compiles it to a `CompiledWorkflow`.
 *
 * The YAML document must contain:
 * - `name` (string) — workflow identifier.
 * - `steps` (array)  — ordered list of step definitions.
 *
 * Each step requires an `id` and exactly one of `tool`, `gmi`, or `human`.  A step may
 * also carry a `condition` (string expression) and `routes` (map of route key → step)
 * to declare a conditional branch.
 *
 * @param yamlContent - Raw YAML string to parse and compile.
 * @returns A `CompiledWorkflow` ready to be invoked or streamed.
 *
 * @throws {Error} When required fields are missing or a step has an invalid shape.
 *
 * @example
 * ```yaml
 * name: fetch-and-summarise
 * steps:
 *   - id: fetch
 *     tool: web_fetch
 *   - id: summarise
 *     gmi:
 *       instructions: Summarise the fetched content in 3 sentences.
 * ```
 */
export function compileWorkflowYaml(yamlContent: string): any {
  const doc = parse(yamlContent) as any;

  if (!doc.name) throw new Error('YAML workflow must have a `name` field');
  if (!Array.isArray(doc.steps)) throw new Error('YAML workflow must have a `steps` array');

  let builder = workflow(doc.name)
    // When the YAML document omits `input` or `returns`, fall back to an open
    // schema so authors are not forced to spell out schemas for simple automations.
    .input(doc.input ?? OPEN_INPUT_SCHEMA)
    .returns(doc.returns ?? OPEN_INPUT_SCHEMA);

  for (const stepDef of doc.steps as YamlStepDef[]) {
    if (!stepDef.id) throw new Error(`Each YAML step must have an \`id\` field: ${JSON.stringify(stepDef)}`);

    if (stepDef.condition) {
      // Branch step: convert each route arm to a StepConfig.
      if (!stepDef.routes || typeof stepDef.routes !== 'object') {
        throw new Error(`Step "${stepDef.id}" has a condition but no routes map`);
      }
      const conditionFn = createConditionFn(stepDef.condition);
      const routeConfigs: Record<string, any> = {};
      for (const [routeKey, routeStep] of Object.entries(stepDef.routes)) {
        routeConfigs[routeKey] = yamlStepToConfig(routeStep);
      }
      builder = builder.branch(conditionFn, routeConfigs);
    } else {
      // Regular sequential step.
      const config = yamlStepToConfig(stepDef);
      builder = builder.step(stepDef.id, config);
    }
  }

  return builder.compile();
}

// ---------------------------------------------------------------------------
// Public API: compileMissionYaml
// ---------------------------------------------------------------------------

/**
 * Represents a YAML mission document structure.
 */
interface YamlMissionDef {
  /** Human-readable mission name. */
  name: string;
  /** Goal template, may contain `{{variable}}` placeholders. */
  goal: string;
  /** Planner configuration for step decomposition. */
  planner: {
    /** Decomposition strategy for the planner. */
    strategy: 'linear' | 'tree' | 'react';
    /** Maximum number of steps the planner may emit. */
    maxSteps?: number;
    /** Maximum internal iterations for ReAct-style planners. */
    maxIterations?: number;
  };
  /** Optional policy overrides (e.g. guardrails). */
  policy?: {
    guardrails?: string[];
  };
}

/**
 * Parses a YAML string describing a mission and compiles it to a `CompiledMission`.
 *
 * The YAML document must contain:
 * - `name`    — mission identifier.
 * - `goal`    — goal prompt template (supports `{{variable}}` placeholders).
 * - `planner` — object with at least `strategy` (`linear` | `tree` | `react`).
 *
 * @param yamlContent - Raw YAML string to parse and compile.
 * @returns A `CompiledMission` with `invoke()`, `stream()`, `resume()`, and `explain()`.
 *
 * @throws {Error} When required fields (`name`, `goal`, `planner`) are missing.
 *
 * @example
 * ```yaml
 * name: research
 * goal: Research {{topic}} and produce a concise summary
 * planner:
 *   strategy: linear
 *   maxSteps: 6
 * ```
 */
export function compileMissionYaml(yamlContent: string): any {
  const doc = parse(yamlContent) as YamlMissionDef;

  if (!doc.name) throw new Error('YAML mission must have a `name` field');
  if (!doc.goal) throw new Error('YAML mission must have a `goal` field');
  if (!doc.planner) throw new Error('YAML mission must have a `planner` field');
  if (!doc.planner.strategy) throw new Error('YAML mission `planner` must have a `strategy`');

  let builder = mission(doc.name)
    // When the YAML document omits `input` or `returns`, fall back to open schemas.
    .input((doc as any).input ?? OPEN_INPUT_SCHEMA)
    .returns((doc as any).returns ?? OPEN_INPUT_SCHEMA)
    .goal(doc.goal)
    .planner({
      strategy: doc.planner.strategy,
      maxSteps: doc.planner.maxSteps,
      maxIterations: doc.planner.maxIterations,
    });

  if (doc.policy) {
    builder = builder.policy(doc.policy as any);
  }

  return builder.compile();
}
