/**
 * @fileoverview `wunderland provenance` — audit trail and event verification.
 * @module wunderland/cli/commands/provenance
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

export default async function cmdProvenance(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];

  if (!sub || sub === 'help') {
    fmt.section('wunderland provenance');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('audit')}                  Show audit trail
    ${dim('verify <event-id>')}      Verify event signature

  ${accent('Flags:')}
    ${dim('--agent <id>')}           Filter by agent
    ${dim('--format json|table')}    Output format
`);
    return;
  }

  try {
    if (sub === 'audit') {
      const agentId = typeof flags['agent'] === 'string' ? flags['agent'] : undefined;
      fmt.section('Provenance Audit Trail');
      fmt.note('Audit trail requires provenance to be enabled in agent configuration.');
      if (agentId) fmt.note(`Agent filter: ${agentId}`);
      fmt.blank();
    } else if (sub === 'verify') {
      const eventId = args[1];
      if (!eventId) { fmt.errorBlock('Missing event ID', 'Usage: wunderland provenance verify <event-id>'); process.exitCode = 1; return; }
      fmt.note(`Verification of event ${eventId} requires access to the signed event ledger.`);
    } else {
      fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland provenance')} for help.`);
      process.exitCode = 1;
    }
  } catch (err) {
    fmt.errorBlock('Provenance Error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
