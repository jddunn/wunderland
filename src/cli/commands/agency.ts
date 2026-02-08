/**
 * @fileoverview `wunderland agency` — multi-agent collective management.
 * @module wunderland/cli/commands/agency
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

async function cmdList(_flags: Record<string, string | boolean>): Promise<void> {
  fmt.section('Agencies');
  fmt.note('No agencies configured. Use ' + accent('wunderland agency create <name>') + ' to create one.');
  fmt.blank();
}

async function cmdCreate(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    fmt.errorBlock('Missing name', 'Usage: wunderland agency create <name>');
    process.exitCode = 1;
    return;
  }
  fmt.note(`Agency creation requires a running backend with ENABLE_SOCIAL_ORCHESTRATION=true.`);
  fmt.note(`To create agency "${name}", configure agents in agent.config.json and restart.`);
  fmt.blank();
}

async function cmdStatus(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    fmt.errorBlock('Missing name', 'Usage: wunderland agency status <name>');
    process.exitCode = 1;
    return;
  }
  fmt.section(`Agency: ${name}`);
  fmt.note('Agency status requires a running backend. Connect with --backend-url.');
  fmt.blank();
}

export default async function cmdAgency(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];

  if (!sub || sub === 'help') {
    fmt.section('wunderland agency');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('list')}                   List configured agencies
    ${dim('create <name>')}          Create a multi-agent agency
    ${dim('status <name>')}          Show agency status
    ${dim('add-seat <agency> <agent>')}  Add agent to agency
    ${dim('handoff <from> <to>')}    Trigger agent handoff

  ${accent('Flags:')}
    ${dim('--format json|table')}    Output format
    ${dim('--context <text>')}       Handoff context message
`);
    return;
  }

  try {
    if (sub === 'list') await cmdList(flags);
    else if (sub === 'create') await cmdCreate(args.slice(1));
    else if (sub === 'status') await cmdStatus(args.slice(1));
    else if (sub === 'add-seat') {
      fmt.note('Agency seat management requires a running backend.');
    } else if (sub === 'handoff') {
      fmt.note('Agent handoff requires a running agency. See ' + accent('wunderland agency create') + '.');
    } else {
      fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland agency')} for help.`);
      process.exitCode = 1;
    }
  } catch (err) {
    fmt.errorBlock('Agency Error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
