/**
 * @fileoverview `wunderland mission` — compile and inspect mission YAML files.
 *
 * Provides `run` and `explain` subcommands for goal-oriented mission definitions
 * authored as YAML. The `run` subcommand compiles and reports success; `explain`
 * pretty-prints the planner steps derived from the compiled mission.
 *
 * @module wunderland/cli/commands/mission
 */

export default async function missionCommand(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'help';

  switch (subcommand) {
    case 'run': {
      const target = args[1];
      if (!target) { console.error('Usage: wunderland mission run <file>'); return; }
      const { readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const { compileMissionYaml } = await import('../../orchestration/yaml-compiler.js');
      const yamlPath = resolve(process.cwd(), target);
      const content = await readFile(yamlPath, 'utf-8');
      const compiled = compileMissionYaml(content);
      // Trigger IR materialisation to validate the compiled mission is well-formed.
      compiled.toIR();
      console.log(`\n  Mission: compiled successfully`);
      console.log(`  Use 'wunderland mission explain <file>' to preview the plan\n`);
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
