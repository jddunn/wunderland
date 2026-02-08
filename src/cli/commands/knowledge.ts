/**
 * @fileoverview `wunderland knowledge` — knowledge graph operations.
 * @module wunderland/cli/commands/knowledge
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

export default async function cmdKnowledge(
  args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];

  if (!sub || sub === 'help') {
    fmt.section('wunderland knowledge');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('query <text>')}           Search the knowledge graph
    ${dim('stats')}                  Show graph statistics

  ${accent('Flags:')}
    ${dim('--format json|table')}    Output format
`);
    return;
  }

  try {
    if (sub === 'query') {
      const query = args.slice(1).join(' ');
      if (!query) { fmt.errorBlock('Missing query', 'Usage: wunderland knowledge query <text>'); process.exitCode = 1; return; }
      fmt.note('Knowledge graph query requires a running backend with the knowledge graph enabled.');
    } else if (sub === 'stats') {
      fmt.section('Knowledge Graph Statistics');
      fmt.note('Knowledge graph stats requires a running backend.');
      fmt.blank();
    } else {
      fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland knowledge')} for help.`);
      process.exitCode = 1;
    }
  } catch (err) {
    fmt.errorBlock('Knowledge Error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
