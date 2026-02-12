/**
 * @fileoverview `wunderland workflows` — workflow engine management.
 * @module wunderland/cli/commands/workflows
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

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
    ${dim('list')}                List workflow definitions
    ${dim('run <name>')}          Execute a workflow
    ${dim('status <id>')}         Check workflow instance status
    ${dim('cancel <id>')}         Cancel a running workflow

  ${accent('Flags:')}
    ${dim('--format json|table')}  Output format
`);
    return;
  }

  try {
    if (sub === 'list') {
      fmt.section('Workflows');
      fmt.note('No workflow definitions found. Define workflows in your agent configuration.');
      fmt.blank();
    } else if (sub === 'run') {
      const name = args[1];
      if (!name) { fmt.errorBlock('Missing name', 'Usage: wunderland workflows run <name>'); process.exitCode = 1; return; }
      fmt.note(`Workflow execution requires a running backend with workflow engine enabled.`);
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
