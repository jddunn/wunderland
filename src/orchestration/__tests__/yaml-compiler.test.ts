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

  it('forwards planner.style="qa" through to the agentos compiler so a QA template is produced', () => {
    const yaml = `
name: ask-something
goal: "What is the capital of France?"
planner:
  strategy: linear
  style: qa
`;
    const compiled = compileMissionYaml(yaml);
    const ir = compiled.toIR();
    const ids = ir.nodes.map((n: { id: string }) => n.id);
    expect(ids).toContain('research-quick');
    expect(ids).toContain('answer');
    expect(ids).not.toContain('gather-info');
  });

  it('forwards planner.style="creative" through to the agentos compiler so a creative template is produced', () => {
    const yaml = `
name: write-tagline
goal: "Write a tagline for a coffee shop"
planner:
  strategy: linear
  style: creative
`;
    const compiled = compileMissionYaml(yaml);
    const ir = compiled.toIR();
    const ids = ir.nodes.map((n: { id: string }) => n.id);
    expect(ids).toContain('brainstorm');
    expect(ids).toContain('produce-artifact');
  });

  it('rejects an unknown planner.style with an error mentioning the style field', () => {
    const yaml = `
name: bad-style
goal: "Anything"
planner:
  strategy: linear
  style: not-a-real-style
`;
    expect(() => compileMissionYaml(yaml)).toThrow(/style/i);
  });

  it('auto-classifies a question goal to the QA template when planner.style is not set', () => {
    const yaml = `
name: ambient-question
goal: "What is the difference between TCP and UDP?"
planner:
  strategy: linear
`;
    const compiled = compileMissionYaml(yaml);
    const ir = compiled.toIR();
    const ids = ir.nodes.map((n: { id: string }) => n.id);
    expect(ids).toContain('research-quick');
    expect(ids).toContain('answer');
  });

  it('forwards planner.parallelTools=true to gmi node executorConfig so multi-tool turns can fan out', () => {
    const yaml = `
name: parallel-test
goal: "Research current vector DB benchmarks"
planner:
  strategy: linear
  parallelTools: true
`;
    const compiled = compileMissionYaml(yaml);
    const ir = compiled.toIR();
    const gmiNodes = ir.nodes.filter((n: { executorConfig?: { type?: string } }) =>
      n.executorConfig?.type === 'gmi'
    );
    expect(gmiNodes.length).toBeGreaterThan(0);
    for (const n of gmiNodes) {
      expect((n.executorConfig as { parallelTools?: boolean }).parallelTools).toBe(true);
    }
  });

  it('does not enable parallelTools when the YAML omits the flag (default false)', () => {
    const yaml = `
name: serial-test
goal: "Research current vector DB benchmarks"
planner:
  strategy: linear
`;
    const compiled = compileMissionYaml(yaml);
    const ir = compiled.toIR();
    const gmiNodes = ir.nodes.filter((n: { executorConfig?: { type?: string } }) =>
      n.executorConfig?.type === 'gmi'
    );
    for (const n of gmiNodes) {
      // Either undefined or false — never true when not requested.
      expect((n.executorConfig as { parallelTools?: boolean }).parallelTools).not.toBe(true);
    }
  });

  it('auto-classifies a "Write a..." goal to the creative template when planner.style is not set', () => {
    const yaml = `
name: ambient-creative
goal: "Write a haiku about morning fog"
planner:
  strategy: linear
`;
    const compiled = compileMissionYaml(yaml);
    const ir = compiled.toIR();
    const ids = ir.nodes.map((n: { id: string }) => n.id);
    expect(ids).toContain('brainstorm');
    expect(ids).toContain('polish');
  });
});
