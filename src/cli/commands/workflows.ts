// @ts-nocheck
/**
 * @fileoverview `wunderland workflows` — workflow engine management.
 * @module wunderland/cli/commands/workflows
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { shutdownWunderlandOtel, startWunderlandOtel } from '../../platform/observability/otel.js';
import type { WunderlandGraphRunConfig } from '../../runtime-new/execution/graph-runner.js';
import { resolveWunderlandRuntimeConfigFromEnv } from '../../platform/config-new/provider-defaults.js';

/**
 * Resolves LLM runtime config from environment variables.
 * Checks OpenRouter, OpenAI, Anthropic, Gemini, then Ollama.
 */
export function resolveRuntimeConfig(): WunderlandGraphRunConfig {
  const { providerId, apiKey, model, baseUrl } = resolveWunderlandRuntimeConfigFromEnv();

  return {
    llm: { providerId, apiKey, model, baseUrl },
    systemPrompt: 'You are a helpful assistant executing a workflow step.',
    toolMap: new Map(),
    toolContext: {},
    askPermission: async () => true,
  };
}

const LOCAL_WORKFLOW_DIRS = ['workflows', 'missions', 'orchestration'];
const WORKFLOW_FILE_EXTENSIONS = ['.workflow.json', '.mission.json', '.workflow.yaml', '.workflow.yml', '.mission.yaml', '.mission.yml'];
const BUNDLED_EXAMPLES = [
  'examples/workflow-orchestration.mjs',
  'examples/agent-graph-orchestration.mjs',
  'examples/mission-orchestration.mjs',
];

function findWorkflowDefinitions(cwd: string): string[] {
  const found = new Set<string>();

  for (const dir of LOCAL_WORKFLOW_DIRS) {
    const absDir = path.join(cwd, dir);
    if (!existsSync(absDir)) continue;

    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(absDir, entry.name);
      if (WORKFLOW_FILE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        found.add(path.relative(cwd, fullPath));
      }
    }
  }

  return [...found].sort();
}

export default async function cmdWorkflows(
  args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];

  if (!sub || sub === 'help') {
    fmt.section('wunderland workflows');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('list')}                 List local workflow/mission definition files
    ${dim('examples')}             Show bundled orchestration examples
    ${dim('run <file>')}            Execute a workflow YAML file
    ${dim('explain <file>')}       Show the compiled node/edge graph for a workflow
    ${dim('status <id>')}          Check workflow instance status
    ${dim('cancel <id>')}          Cancel a running workflow

  ${accent('Flags:')}
    ${dim('--format json|table')}  Output format
`);
    fmt.note(`Author graphs with ${accent(`import { workflow, mission, AgentGraph } from 'wunderland/workflows'`)}.`);
    fmt.note(`Execute compiled graphs in-process with ${accent('createWunderland().runGraph(...)')}.`);
    return;
  }

  try {
    if (sub === 'list') {
      fmt.section('Workflows');
      const definitions = findWorkflowDefinitions(process.cwd());
      if (definitions.length === 0) {
        fmt.note('No local workflow definition files found.');
        fmt.note(`Create ${accent('workflows/')} or ${accent('missions/')} and see ${accent('wunderland help workflows')}.`);
      } else {
        for (const definition of definitions) {
          console.log(`  ${accent('•')} ${definition}`);
        }
      }
      fmt.blank();
    } else if (sub === 'examples') {
      fmt.section('Bundled Orchestration Examples');
      for (const example of BUNDLED_EXAMPLES) {
        console.log(`  ${accent('•')} ${example}`);
      }
      fmt.blank();
      fmt.note(`Use ${accent('wunderland help workflows')} for authoring guidance.`);
    } else if (sub === 'run') {
      const target = args[1];
      if (!target) { fmt.errorBlock('Missing file', 'Usage: wunderland workflows run <file>'); process.exitCode = 1; return; }
      if (/\.(mjs|js|ts)$/i.test(target)) {
        fmt.errorBlock(
          'Unsupported file type',
          'wunderland workflows run currently executes YAML/JSON workflow definitions. Run code-authored graphs with node/tsx and createWunderland().runGraph(...).',
        );
        process.exitCode = 1;
        return;
      }
      const { readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const { compileWorkflowYaml } = await import('../../orchestration/yaml-compiler.js');
      const { createWunderland } = await import('../../public/index.js');

      const yamlPath = resolve(process.cwd(), target);
      const content = await readFile(yamlPath, 'utf-8');
      const compiled = compileWorkflowYaml(content);
      const ir = compiled.toIR();

      // Parse --input flag as JSON
      const inputFlag = _flags['input'] as string | undefined;
      let input: Record<string, unknown> = {};
      if (inputFlag) {
        try {
          input = JSON.parse(inputFlag);
        } catch (e: any) {
          console.error('Invalid JSON input: ' + e.message);
          process.exitCode = 1;
          return;
        }
      }

      // Resolve LLM config from environment
	      const runtimeConfig = resolveRuntimeConfig();
	      await startWunderlandOtel({ serviceName: 'wunderland-workflows' });
	      const app = await createWunderland({
          configDirOverride: globals.config,
	        llm: {
	          providerId: runtimeConfig.llm.providerId as any,
          apiKey: runtimeConfig.llm.apiKey as any,
          model: runtimeConfig.llm.model,
          baseUrl: runtimeConfig.llm.baseUrl,
        },
        tools: 'curated',
        approvals: { mode: 'auto-all' },
      });

      console.log(`\n  ${accent('●')} ${ir.name}`);

      // Execute through GraphRuntime with streaming events
      const startTime = Date.now();
      try {
        for await (const event of app.streamGraph(compiled, input)) {
          switch (event.type) {
            case 'node_start':
              process.stdout.write(`  ├── ${dim('running')} ${accent(event.nodeId)}...`);
              break;
            case 'node_end':
              process.stdout.write(` ${dim(`[${event.durationMs}ms]`)}\n`);
              break;
            case 'text_delta':
              // Accumulate text output silently during execution
              break;
            case 'error':
              console.error(`  ├── ${dim('error')} ${event.error.message}`);
              break;
          }
        }
	      } finally {
	        await app.close();
	        await shutdownWunderlandOtel();
	      }
      console.log(`  └── ${accent('✓')} complete ${dim(`[${Date.now() - startTime}ms]`)}\n`);
    } else if (sub === 'explain') {
      const target = args[1];
      if (!target) { fmt.errorBlock('Missing file', 'Usage: wunderland workflows explain <file>'); process.exitCode = 1; return; }
      const { readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const { compileWorkflowYaml } = await import('../../orchestration/yaml-compiler.js');

      const yamlPath = resolve(process.cwd(), target);
      const content = await readFile(yamlPath, 'utf-8');
      const compiled = compileWorkflowYaml(content);
      const ir = compiled.toIR();
      console.log(`\n  Workflow: ${ir.name}\n`);
      for (const node of ir.nodes) {
        console.log(`  ├── ${node.id} (${node.type})`);
      }
      console.log(`\n  Edges:`);
      for (const edge of ir.edges) {
        console.log(`  ${edge.source} → ${edge.target} [${edge.type}]`);
      }
      console.log();
    } else if (sub === 'status') {
      const id = args[1];
      if (!id) { fmt.errorBlock('Missing ID', 'Usage: wunderland workflows status <id>'); process.exitCode = 1; return; }
      fmt.note(`Workflow status lookup requires a running backend.`);
    } else if (sub === 'cancel') {
      const id = args[1];
      if (!id) { fmt.errorBlock('Missing ID', 'Usage: wunderland workflows cancel <id>'); process.exitCode = 1; return; }
      fmt.note(`Workflow cancellation requires a running backend.`);
    } else {
      fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland workflows')} for help.`);
      process.exitCode = 1;
    }
  } catch (err) {
    fmt.errorBlock('Workflow Error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
