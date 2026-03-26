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
import { schemaFromYaml, type YamlFieldDef } from './yaml-schema.js';

/**
 * Fallback input schema used when the YAML document does not declare an `input` field.
 * Accepts any key-value payload so the workflow/mission compiles without requiring
 * authors to spell out a schema for every automation.
 */
const OPEN_INPUT_SCHEMA = z.record(z.string(), z.unknown());

function resolveYamlSchema(
  schema: Record<string, YamlFieldDef> | undefined,
  fallback: z.ZodTypeAny = OPEN_INPUT_SCHEMA,
): z.ZodTypeAny {
  if (!schema || Object.keys(schema).length === 0) {
    return fallback;
  }
  return schemaFromYaml(schema);
}

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
/**
 * Creates a safe condition evaluator function from a DSL expression string.
 *
 * Replaces the previous `new Function()` approach that was vulnerable to
 * arbitrary code injection from YAML inputs. Now resolves partition references
 * directly against state and supports only simple comparisons and boolean
 * connectives — no arbitrary JS execution.
 *
 * @param expr - The condition expression (e.g. `'scratch.decision === "yes"'`).
 * @returns A function that evaluates the expression against graph state.
 */
function createConditionFn(expr: string): (state: Record<string, unknown>) => string {
  return (state: Record<string, unknown>) => {
    try {
      return safeEvalCondition(expr, state);
    } catch {
      return 'false';
    }
  };
}

/** Allowed partitions that can be referenced in YAML condition expressions. */
const ALLOWED_PARTITIONS = new Set(['scratch', 'input', 'artifacts', 'memory', 'diagnostics']);

/** Pattern matching `partition.path.to.value` references. */
const PARTITION_REF = /\b(scratch|input|artifacts|memory|diagnostics)(?:\.(\w+(?:\.\w+)*))?/g;

/**
 * Resolve a dot-separated path against a nested object.
 *
 * @param root - The root object to traverse.
 * @param path - Dot-separated field path.
 * @returns The resolved value, or `undefined` if any segment is missing.
 */
function resolveDotPath(root: unknown, path: string): unknown {
  let current = root;
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Parse a value token from a condition expression.
 *
 * @param token - The token string.
 * @param refs  - Resolved partition references.
 * @returns The parsed value.
 */
function parseCondToken(token: string, refs: Map<string, unknown>): unknown {
  const t = token.trim();
  if (refs.has(t)) return refs.get(t);
  // String literal (single or double quotes)
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t === 'undefined') return undefined;
  const num = Number(t);
  if (!isNaN(num) && t !== '') return num;
  return t;
}

/** Comparison operators ordered longest-first to avoid partial matches. */
const CMP_OPS = ['===', '!==', '==', '!=', '>=', '<=', '>', '<'] as const;

/**
 * Safely evaluate a YAML condition expression against state.
 * Supports partition references, comparisons, and `&&`/`||` connectives.
 * No `new Function()` or `eval()` — zero code execution risk.
 *
 * @param expr  - The condition expression.
 * @param state - Graph state object.
 * @returns The result as a string.
 */
function safeEvalCondition(expr: string, state: Record<string, unknown>): string {
  // Resolve all partition references to their actual values
  const refs = new Map<string, unknown>();
  const pattern = new RegExp(PARTITION_REF.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(expr)) !== null) {
    const [fullMatch, partition, path] = match;
    if (!ALLOWED_PARTITIONS.has(partition)) continue;
    const partitionObj = state[partition];
    refs.set(fullMatch, path ? resolveDotPath(partitionObj, path) : partitionObj);
  }

  // Evaluate a single comparison (no boolean connectives)
  const evalSingle = (part: string): unknown => {
    const trimmed = part.trim();
    for (const op of CMP_OPS) {
      const idx = trimmed.indexOf(op);
      if (idx === -1) continue;
      const left = parseCondToken(trimmed.slice(0, idx), refs);
      const right = parseCondToken(trimmed.slice(idx + op.length), refs);
      switch (op) {
        case '===': return left === right;
        case '!==': return left !== right;
        case '==': return left == right;  // eslint-disable-line eqeqeq
        case '!=': return left != right;  // eslint-disable-line eqeqeq
        case '>=': return Number(left) >= Number(right);
        case '<=': return Number(left) <= Number(right);
        case '>':  return Number(left) > Number(right);
        case '<':  return Number(left) < Number(right);
      }
    }
    return parseCondToken(trimmed, refs);
  };

  // Split on || (lower precedence) then && (higher precedence)
  const orParts = expr.split('||').map(s => s.trim());
  for (const orPart of orParts) {
    const andParts = orPart.split('&&').map(s => s.trim());
    const allTrue = andParts.every(p => Boolean(evalSingle(p)));
    if (allTrue) {
      if (orParts.length === 1 && andParts.length === 1) {
        return String(evalSingle(expr) ?? 'false');
      }
      return 'true';
    }
  }
  return 'false';
}

// ---------------------------------------------------------------------------
// Internal: YAML step → StepConfig converter
// ---------------------------------------------------------------------------

/**
 * Voice pipeline configuration for a YAML step.
 *
 * When present on a step definition, the step is compiled to a `voice`
 * {@link NodeExecutorConfig} and dispatched to {@link VoiceNodeExecutor}.
 */
interface YamlVoiceStepConfig {
  /**
   * Voice session mode.
   * - `conversation`  — bidirectional STT + TTS (default call flow).
   * - `listen-only`   — STT only; agent never speaks during this step.
   * - `speak-only`    — TTS only; user speech is ignored.
   */
  mode: 'conversation' | 'listen-only' | 'speak-only';
  /** STT provider override (e.g. `'deepgram'`, `'openai'`). Defaults to agent config value. */
  stt?: string;
  /** TTS provider override (e.g. `'openai'`, `'elevenlabs'`). Defaults to agent config value. */
  tts?: string;
  /** TTS voice name forwarded to the TTS provider. */
  voice?: string;
  /**
   * Endpoint detection mode.
   * - `acoustic`   — energy/VAD + silence timeout.
   * - `heuristic`  — punctuation + silence heuristics.
   * - `semantic`   — LLM-assisted turn boundary detection.
   */
  endpointing?: string;
  /**
   * Barge-in handling strategy.
   * - `hard-cut`  — interrupt TTS immediately on user speech.
   * - `soft-fade` — ramp TTS down before cutting.
   * - `disabled`  — ignore user speech while agent is speaking.
   */
  bargeIn?: string;
  /** Enable speaker diarization for multi-speaker sessions. */
  diarization?: boolean;
  /** BCP-47 language tag forwarded to STT (e.g. `'en-US'`). */
  language?: string;
  /** Maximum number of turns before the node exits with `turns-exhausted`. `0` = unlimited. */
  maxTurns?: number;
  /**
   * Primary exit condition.
   * - `hangup`          — exit when the caller disconnects.
   * - `silence-timeout` — exit after 30 s of no speech.
   * - `keyword`         — exit when an {@link exitKeywords} phrase is detected.
   * - `turns-exhausted` — exit when {@link maxTurns} is reached.
   * - `manual`          — exit only when triggered programmatically.
   */
  exitOn?: string;
  /** Phrases that trigger exit when `exitOn` is `'keyword'`. Case-insensitive substring match. */
  exitKeywords?: string[];
}

/**
 * Represents a single step declaration in a YAML workflow definition.
 * Maps to {@link StepConfig} accepted by `WorkflowBuilder.step()`.
 */
interface YamlStepDef {
  /** Unique step identifier within the workflow. */
  id: string;
  /** Registered tool name to invoke. Mutually exclusive with `gmi`, `human`, and `voice`. */
  tool?: string;
  /** GMI (General Model Invocation) configuration. Mutually exclusive with `tool`, `human`, and `voice`. */
  gmi?: { instructions: string; maxTokens?: number };
  /** Human-in-the-loop prompt. Mutually exclusive with `tool`, `gmi`, and `voice`. */
  human?: { prompt: string };
  /**
   * Voice pipeline configuration. When present, the step runs as a voice node.
   * Mutually exclusive with `tool`, `gmi`, and `human`.
   */
  voice?: YamlVoiceStepConfig;
  /** Optional branch condition expression (e.g. `scratch.decision`). */
  condition?: string;
  /**
   * When `condition` is set, maps route label → step config for each branch arm.
   * Each value follows the same `tool`/`gmi`/`human`/`voice` shape as a regular step.
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
  if (def.voice) {
    if (!def.voice.mode) {
      throw new Error(
        `YAML voice step must specify a \`mode\` (conversation|listen-only|speak-only). Got: ${JSON.stringify(def.voice)}`,
      );
    }
    // Return a StepConfig shape with `voice` set — WorkflowBuilder.configToNode()
    // handles voice steps and lowers them to a NodeExecutorConfig of type 'voice'.
    return {
      voice: def.voice,
    };
  }
  throw new Error(
    `YAML step must specify one of: tool, gmi, human, or voice. Got: ${JSON.stringify(def)}`,
  );
}

// ---------------------------------------------------------------------------
// Public API: compileWorkflowYaml
// ---------------------------------------------------------------------------

/**
 * Top-level transport configuration in a YAML workflow document.
 *
 * When `type` is `'voice'`, the compiled workflow is expected to be driven by a
 * {@link VoiceTransportAdapter} that bridges graph I/O to the voice pipeline for
 * the duration of the entire call rather than just a single node.
 */
interface YamlTransportDef {
  /**
   * Transport type. Currently only `'voice'` is supported.
   * Future values may include `'websocket'` or `'telephony'`.
   */
  type: 'voice';
  /** STT provider identifier (e.g. `'deepgram'`, `'openai'`). */
  stt?: string;
  /** TTS provider identifier (e.g. `'openai'`, `'elevenlabs'`). */
  tts?: string;
  /** TTS voice name forwarded to the provider. */
  voice?: string;
  /** Barge-in handling mode (`'hard-cut'` | `'soft-fade'` | `'disabled'`). */
  bargeIn?: string;
  /** Endpoint detection mode (`'acoustic'` | `'heuristic'` | `'semantic'`). */
  endpointing?: string;
}

/**
 * Parses a YAML string describing a workflow and compiles it to a `CompiledWorkflow`.
 *
 * The YAML document must contain:
 * - `name` (string) — workflow identifier.
 * - `steps` (array)  — ordered list of step definitions.
 *
 * Each step requires an `id` and exactly one of `tool`, `gmi`, `human`, or `voice`.  A step
 * may also carry a `condition` (string expression) and `routes` (map of route key → step) to
 * declare a conditional branch.
 *
 * An optional top-level `transport` field configures the I/O layer used to drive the whole
 * workflow.  When `transport.type` is `'voice'`, the workflow is intended to be executed inside
 * a phone call or real-time voice session; every node receives input from STT and delivers
 * output to TTS via a {@link VoiceTransportAdapter}.
 *
 * @param yamlContent - Raw YAML string to parse and compile.
 * @returns A `CompiledWorkflow` ready to be invoked or streamed.
 *          The compiled graph carries `transport` metadata at `compiled._transport` when
 *          a transport block is present in the YAML.
 *
 * @throws {Error} When required fields are missing or a step has an invalid shape.
 *
 * @example Basic workflow
 * ```yaml
 * name: fetch-and-summarise
 * steps:
 *   - id: fetch
 *     tool: web_fetch
 *   - id: summarise
 *     gmi:
 *       instructions: Summarise the fetched content in 3 sentences.
 * ```
 *
 * @example Voice transport workflow
 * ```yaml
 * name: phone-intake
 * transport:
 *   type: voice
 *   stt: deepgram
 *   tts: elevenlabs
 *   bargeIn: hard-cut
 * steps:
 *   - id: greet
 *     voice:
 *       mode: conversation
 *       maxTurns: 1
 *   - id: collect-info
 *     voice:
 *       mode: conversation
 *       exitOn: keyword
 *       exitKeywords: [confirmed, done]
 * ```
 */
export function compileWorkflowYaml(yamlContent: string): any {
  const doc = parse(yamlContent) as any;

  if (!doc.name) throw new Error('YAML workflow must have a `name` field');
  if (!Array.isArray(doc.steps)) throw new Error('YAML workflow must have a `steps` array');

  // Validate transport block if present.
  const transport: YamlTransportDef | undefined = doc.transport;
  if (transport !== undefined && transport.type !== 'voice') {
    throw new Error(
      `YAML workflow \`transport.type\` must be \`voice\`. Got: ${JSON.stringify(transport.type)}`,
    );
  }

  let builder = workflow(doc.name)
    .input(resolveYamlSchema(doc.input))
    .returns(resolveYamlSchema(doc.returns));

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

  const compiled = builder.compile();

  // Attach transport metadata as a non-enumerable shadow property so that the
  // graph runtime can detect that this workflow was authored for voice transport
  // without polluting the standard CompiledExecutionGraph shape.
  if (transport) {
    (compiled as any)._transport = transport;
  }

  return compiled;
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
    strategy:
      | 'linear'
      | 'tree'
      | 'react'
      | 'plan_and_execute'
      | 'tree_of_thought'
      | 'least_to_most'
      | 'self_consistency'
      | 'reflexion';
    /** Maximum number of steps the planner may emit. */
    maxSteps?: number;
    /** Maximum internal iterations for ReAct-style planners. */
    maxIterations?: number;
  };
  /** Optional policy overrides (e.g. guardrails). */
  policy?: {
    guardrails?: string[];
  };
  input?: Record<string, YamlFieldDef>;
  returns?: Record<string, YamlFieldDef>;
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
    .input(resolveYamlSchema(doc.input))
    .returns(resolveYamlSchema(doc.returns))
    .goal(doc.goal)
    .planner({
      strategy: doc.planner.strategy,
      maxSteps: doc.planner.maxSteps ?? 8,
      maxIterationsPerNode: doc.planner.maxIterations,
    });

  if (doc.policy) {
    builder = builder.policy(doc.policy as any);
  }

  return builder.compile();
}
