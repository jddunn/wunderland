// @ts-nocheck
/**
 * @file yaml-templates.test.ts
 * @description Smoke-tests that every prebuilt workflow and mission YAML template
 * compiles without errors and produces a non-empty IR graph.
 *
 * Tests intentionally exercise only the compilation path (no runtime required)
 * to give fast, offline feedback when templates are added or edited.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileWorkflowYaml, compileMissionYaml } from '../yaml-compiler.js';

// Find presets directory relative to this test file
const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = join(__dirname, '../../../presets');

describe('Prebuilt YAML templates', () => {
  for (const name of ['research-pipeline', 'content-generation', 'data-extraction', 'evaluation']) {
    it(`compiles ${name}.workflow.yaml`, () => {
      const content = readFileSync(join(PRESETS_DIR, `workflows/${name}.workflow.yaml`), 'utf-8');
      const compiled = compileWorkflowYaml(content);
      const ir = compiled.toIR?.() ?? compiled;
      const nodes: any = ir?.nodes ?? ir?.graph?.nodes ?? {};
      const edges: any = ir?.edges ?? ir?.graph?.edges ?? [];
      const nodeCount =
        nodes instanceof Map ? nodes.size : Array.isArray(nodes) ? nodes.length : Object.keys(nodes).length;
      const edgeCount =
        edges instanceof Map ? edges.size : Array.isArray(edges) ? edges.length : 0;
      expect(nodeCount).toBeGreaterThan(0);
      expect(edgeCount).toBeGreaterThan(0);
    });
  }

  for (const name of ['deep-research', 'report-writer']) {
    it(`compiles ${name}.mission.yaml`, () => {
      const content = readFileSync(join(PRESETS_DIR, `missions/${name}.mission.yaml`), 'utf-8');
      const compiled = compileMissionYaml(content);
      const ir = compiled.toIR?.() ?? compiled;
      const nodes: any = ir?.nodes ?? ir?.graph?.nodes ?? {};
      const nodeCount =
        nodes instanceof Map ? nodes.size : Array.isArray(nodes) ? nodes.length : Object.keys(nodes).length;
      expect(nodeCount).toBeGreaterThan(0);
    });
  }
});
