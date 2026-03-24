/**
 * @fileoverview `wunderland mission` — compile, explain, and execute mission YAML files.
 *
 * Provides `run` and `explain` subcommands for goal-oriented mission definitions.
 * `run` compiles the YAML and executes through the GraphRuntime.
 * `explain` previews the planner's generated steps without executing.
 *
 * @module wunderland/cli/commands/mission
 */

export default async function missionCommand(args: string[], flags?: Record<string, string | boolean>): Promise<void> {
  const subcommand = args[0] ?? 'help';

  switch (subcommand) {
    case 'run': {
      const target = args[1];
      if (!target) { console.error('Usage: wunderland mission run <file> [--input \'{"key":"val"}\']'); return; }
      const { readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const { compileMissionYaml } = await import('../../orchestration/yaml-compiler.js');
      const { streamWunderlandGraph } = await import('../../runtime/graph-runner.js');

      const yamlPath = resolve(process.cwd(), target);
      const content = await readFile(yamlPath, 'utf-8');
      const compiled = compileMissionYaml(content);
      const ir = compiled.toIR();

      // Parse --input flag
      const inputFlag = flags?.['input'] as string | undefined;
      const input = inputFlag ? JSON.parse(inputFlag) : {};

      // Resolve LLM config from environment
      const openrouterKey = process.env['OPENROUTER_API_KEY'];
      const openaiKey = process.env['OPENAI_API_KEY'];
      const anthropicKey = process.env['ANTHROPIC_API_KEY'];
      let providerId = 'openai';
      let apiKey = openaiKey ?? '';
      let model = 'gpt-4o';
      if (openrouterKey) { providerId = 'openrouter'; apiKey = openrouterKey; model = 'openai/gpt-4o'; }
      else if (anthropicKey) { providerId = 'anthropic'; apiKey = anthropicKey; model = 'claude-sonnet-4-20250514'; }

      if (!apiKey) {
        console.error('No LLM API key found. Set OPENAI_API_KEY, OPENROUTER_API_KEY, or ANTHROPIC_API_KEY.');
        process.exitCode = 1;
        return;
      }

      const runtimeConfig = {
        llm: { providerId, apiKey, model },
        systemPrompt: 'You are executing a mission step.',
        toolMap: new Map(),
        toolContext: {},
        askPermission: async () => true as const,
      };

      console.log(`\n  ● Mission: ${ir.name}`);
      const startTime = Date.now();

      for await (const event of streamWunderlandGraph(compiled, input, runtimeConfig)) {
        if (event.type === 'node_start') process.stdout.write(`  ├── running ${event.nodeId}...`);
        if (event.type === 'node_end') process.stdout.write(` [${event.durationMs}ms]\n`);
        if (event.type === 'error') console.error(`  ├── error: ${event.error.message}`);
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
