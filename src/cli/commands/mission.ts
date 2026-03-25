/**
 * @fileoverview `wunderland mission` — compile, explain, and execute mission YAML files.
 *
 * Provides `run` and `explain` subcommands for goal-oriented mission definitions.
 * `run` compiles the YAML and executes through the GraphRuntime.
 * `explain` previews the planner's generated steps without executing.
 *
 * @module wunderland/cli/commands/mission
 */

import { resolveRuntimeConfig } from './workflows.js';
import { shutdownWunderlandOtel, startWunderlandOtel } from '../../observability/otel.js';
import type { GlobalFlags } from '../types.js';

export default async function missionCommand(
  args: string[],
  flags?: Record<string, string | boolean>,
  globals?: GlobalFlags,
): Promise<void> {
  const subcommand = args[0] ?? 'help';

  switch (subcommand) {
    case 'run': {
      const target = args[1];
      if (!target) { console.error('Usage: wunderland mission run <file> [--input \'{"key":"val"}\']'); return; }
      if (/\.(mjs|js|ts)$/i.test(target)) {
        console.error('wunderland mission run executes YAML/JSON mission definitions. Run code-authored graphs with node/tsx and createWunderland().runGraph(...).');
        process.exitCode = 1;
        return;
      }
      const { readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const { compileMissionYaml } = await import('../../orchestration/yaml-compiler.js');
      const { createWunderland } = await import('../../public/index.js');

      const yamlPath = resolve(process.cwd(), target);
      const content = await readFile(yamlPath, 'utf-8');
      const compiled = compileMissionYaml(content);
      const ir = compiled.toIR();

      // Parse --input flag
      const inputFlag = flags?.['input'] as string | undefined;
      const input = inputFlag ? JSON.parse(inputFlag) : {};

	      const baseRuntime = resolveRuntimeConfig();
	      await startWunderlandOtel({ serviceName: 'wunderland-mission' });
	      const app = await createWunderland({
          configDirOverride: globals?.config,
	        llm: {
          providerId: baseRuntime.llm.providerId as any,
          apiKey: baseRuntime.llm.apiKey as any,
          model: baseRuntime.llm.model,
          baseUrl: baseRuntime.llm.baseUrl,
        },
        tools: 'curated',
        approvals: { mode: 'auto-all' },
      });

      console.log(`\n  ● Mission: ${ir.name}`);
      const startTime = Date.now();

      try {
        for await (const event of app.streamGraph(compiled, input)) {
          if (event.type === 'node_start') process.stdout.write(`  ├── running ${event.nodeId}...`);
          if (event.type === 'node_end') process.stdout.write(` [${event.durationMs}ms]\n`);
          if (event.type === 'error') console.error(`  ├── error: ${event.error.message}`);
        }
	      } finally {
	        await app.close();
	        await shutdownWunderlandOtel();
	      }

      console.log(`  └── ✓ complete [${Date.now() - startTime}ms]\n`);
      break;
    }
    case 'explain': {
      const target = args[1];
      if (!target) { console.error('Usage: wunderland mission explain <file>'); return; }
      const { readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const { compileMissionYaml } = await import('../../orchestration/yaml-compiler.js');
      const yamlPath = resolve(process.cwd(), target);
      const content = await readFile(yamlPath, 'utf-8');
      const compiled = compileMissionYaml(content);
      const plan = await compiled.explain({});
      console.log(`\n  Mission Plan:`);
      for (const step of plan.steps) {
        console.log(`  ├── ${step.id} (${step.type})`);
      }
      console.log();
      break;
    }
    default:
      console.log('Usage: wunderland mission <run|explain> <file>');
  }
}
