/**
 * @fileoverview `wunderland marketplace` — agent capability marketplace.
 * @module wunderland/cli/commands/marketplace
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

export default async function cmdMarketplace(
  args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];

  if (!sub || sub === 'help') {
    fmt.section('wunderland marketplace');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('search <query>')}         Search available skills & tools
    ${dim('info <id>')}              Show item details & ratings
    ${dim('install <id>')}           Install from marketplace

  ${accent('Flags:')}
    ${dim('--format json|table')}    Output format
`);
    return;
  }

  try {
    if (sub === 'search') {
      const query = args.slice(1).join(' ');
      if (!query) { fmt.errorBlock('Missing query', 'Usage: wunderland marketplace search <query>'); process.exitCode = 1; return; }
      fmt.section(`Marketplace: "${query}"`);
      fmt.note('Marketplace search requires connection to the Wunderland marketplace registry.');
      fmt.blank();
    } else if (sub === 'info') {
      const id = args[1];
      if (!id) { fmt.errorBlock('Missing ID', 'Usage: wunderland marketplace info <id>'); process.exitCode = 1; return; }
      fmt.note(`Item details for "${id}" requires marketplace connection.`);
    } else if (sub === 'install') {
      const id = args[1];
      if (!id) { fmt.errorBlock('Missing ID', 'Usage: wunderland marketplace install <id>'); process.exitCode = 1; return; }
      fmt.note(`Installation of "${id}" requires marketplace connection.`);
    } else {
      fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland marketplace')} for help.`);
      process.exitCode = 1;
    }
  } catch (err) {
    fmt.errorBlock('Marketplace Error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
