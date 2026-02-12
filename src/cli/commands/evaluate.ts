/**
 * @fileoverview `wunderland evaluate` — run evaluations on agent responses.
 * @module wunderland/cli/commands/evaluate
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

export default async function cmdEvaluate(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];

  if (!sub || sub === 'help') {
    fmt.section('wunderland evaluate');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('run <dataset>')}          Run evaluation against a dataset
    ${dim('results <id>')}           Show evaluation results

  ${accent('Flags:')}
    ${dim('--judge <model>')}        LLM judge model (default: configured primary)
    ${dim('--format json|table')}    Output format
`);
    return;
  }

  try {
    if (sub === 'run') {
      const dataset = args[1];
      if (!dataset) { fmt.errorBlock('Missing dataset', 'Usage: wunderland evaluate run <dataset>'); process.exitCode = 1; return; }
      fmt.note('Evaluation requires a running backend with the evaluation framework enabled.');
      fmt.note(`Dataset: ${dataset}`);
      const judge = typeof flags['judge'] === 'string' ? flags['judge'] : undefined;
      if (judge) fmt.note(`Judge model: ${judge}`);
    } else if (sub === 'results') {
      const id = args[1];
      if (!id) { fmt.errorBlock('Missing ID', 'Usage: wunderland evaluate results <id>'); process.exitCode = 1; return; }
      fmt.note('Evaluation results lookup requires a running backend.');
    } else {
      fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland evaluate')} for help.`);
      process.exitCode = 1;
    }
  } catch (err) {
    fmt.errorBlock('Evaluate Error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
