// @ts-nocheck
/**
 * @file yaml-compiler.test.ts
 * @description Unit tests for the YAML workflow and mission compiler.
 *
 * Tests verify that YAML strings are correctly parsed, validated, and compiled
 * into AgentOS execution graphs with the expected structure.
 */

import { describe, it, expect } from 'vitest';
import { compileWorkflowYaml, compileMissionYaml } from '../yaml-compiler.js';

// ---------------------------------------------------------------------------
// Workflow tests
// ---------------------------------------------------------------------------

describe('compileWorkflowYaml', () => {
  it('compiles a simple linear workflow with two steps', () => {
    const yaml = `
name: fetch-and-summarise
steps:
  - id: search
    tool: web_search
  - id: summarise
    gmi:
      instructions: Summarise the search results in three sentences.
`;
    const compiled = compileWorkflowYaml(yaml);
    expect(compiled).toBeDefined();
  });

  it('compiles a workflow with a branch step', () => {
    const yaml = `
name: decision-workflow
steps:
  - id: decide
    gmi:
      instructions: Decide yes or no and write your answer to scratch.decision.
  - id: route
    condition: scratch.decision
    routes:
      yes:
        tool: send_email
      no:
        gmi:
          instructions: Log that the decision was no.
`;
    const compiled = compileWorkflowYaml(yaml);
    expect(compiled).toBeDefined();
  });

  it('compiled workflow graph has correct node count for a two-step linear workflow', () => {
    const yaml = `
name: two-step
steps:
  - id: step-a
    tool: tool_a
  - id: step-b
    tool: tool_b
`;
    const compiled = compileWorkflowYaml(yaml);
    // Compiled graph IR should expose the node map; 2 declared steps + START/END
    const graph: any = compiled.toIR?.() ?? compiled;
    const nodes: Map<string, any> | Record<string, any> = graph?.nodes ?? graph?.graph?.nodes ?? {};
    const nodeCount =
      nodes instanceof Map ? nodes.size : Object.keys(nodes).length;
    // Expect at least 2 nodes (one per step); START and END may be included too.
    expect(nodeCount).toBeGreaterThanOrEqual(2);
  });

  it('compiled workflow graph has edges', () => {
    const yaml = `
name: edge-test
steps:
  - id: step-one
    tool: tool_one
  - id: step-two
    gmi:
      instructions: Process the result of step-one.
`;
    const compiled = compileWorkflowYaml(yaml);
    const graph: any = compiled.toIR?.() ?? compiled;
    const edges: any[] | Map<string, any> = graph?.edges ?? graph?.graph?.edges ?? [];
    const edgeCount =
      edges instanceof Map ? edges.size : Array.isArray(edges) ? edges.length : 0;
    // At minimum: START→step-one and step-one→step-two edges must exist.
    expect(edgeCount).toBeGreaterThanOrEqual(2);
  });

  it('lowers YAML input and return schemas through schemaFromYaml()', () => {
    const yaml = `
name: schema-test
input:
  topic: { type: string, required: true }
returns:
  summary: { type: string }
steps:
  - id: summarise
    gmi:
      instructions: Summarise the topic.
`;
    const compiled = compileWorkflowYaml(yaml);
    const graph: any = compiled.toIR();
    expect(graph.stateSchema.input?.properties?.topic?.type).toBe('string');
    expect(graph.stateSchema.input?.required).toContain('topic');
    expect(graph.stateSchema.artifacts?.properties?.summary?.type).toBe('string');
  });

  it('throws when steps array is missing', () => {
    const yaml = `name: no-steps`;
    expect(() => compileWorkflowYaml(yaml)).toThrow();
  });

  it('throws when a step has neither tool nor gmi nor human', () => {
    const yaml = `
name: bad-step
steps:
  - id: empty-step
`;
    expect(() => compileWorkflowYaml(yaml)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mission tests
// ---------------------------------------------------------------------------

describe('compileMissionYaml', () => {
  it('compiles a simple mission with goal and linear planner', () => {
    const yaml = `
name: research
goal: Research {{topic}} and produce a concise summary
planner:
  strategy: linear
  maxSteps: 6
`;
    const compiled = compileMissionYaml(yaml);
    expect(compiled).toBeDefined();
  });

  it('compiled mission exposes an explain() method', () => {
    const yaml = `
name: explain-test
goal: Explain {{concept}} in simple terms
planner:
  strategy: linear
  maxSteps: 4
`;
    const compiled = compileMissionYaml(yaml);
    expect(typeof compiled.explain).toBe('function');
  });

  it('accepts richer planner strategies such as plan_and_execute', () => {
    const yaml = `
name: strategy-test
goal: Research {{topic}} thoroughly
planner:
  strategy: plan_and_execute
  maxSteps: 6
`;
    const compiled = compileMissionYaml(yaml);
    expect(compiled).toBeDefined();
  });

  it('throws when goal is missing', () => {
    const yaml = `
name: no-goal
planner:
  strategy: linear
`;
    expect(() => compileMissionYaml(yaml)).toThrow();
  });

  it('throws when planner is missing', () => {
    const yaml = `
name: no-planner
goal: Do something
`;
    expect(() => compileMissionYaml(yaml)).toThrow();
  });
});
