/**
 * @fileoverview `wunderland cron` — cron job management (list, status).
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

async function cronList(_globals: GlobalFlags): Promise<void> {
  fmt.section('Scheduled Jobs');
  fmt.blank();
  fmt.skip('No cron jobs configured locally.');
  fmt.blank();
  fmt.note(`Cron jobs are managed via the Rabbithole dashboard or the agent's ${accent('cron_manage')} tool.`);
  fmt.note(`API: ${dim('POST /wunderland/cron')} to create jobs programmatically.`);
  fmt.blank();
}

async function cronStatus(_globals: GlobalFlags): Promise<void> {
  fmt.section('Cron Scheduler');
  fmt.blank();
  fmt.kvPair('Engine', accent('CronScheduler'));
  fmt.kvPair('Schedule Types', 'at (one-shot), every (interval), cron (expression)');
  fmt.kvPair('Payload Types', 'stimulus, webhook, message, custom');
  fmt.blank();
  fmt.note(`The cron scheduler runs inside the backend server.`);
  fmt.note(`Start your server with ${accent('wunderland start')} to activate scheduling.`);
  fmt.blank();
}

export default async function cmdCron(
  args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const sub = args[0];

  if (sub === 'list' || !sub) {
    await cronList(globals);
    return;
  }

  if (sub === 'status') {
    await cronStatus(globals);
    return;
  }

  fmt.errorBlock('Unknown subcommand', `"${sub}" is not a cron subcommand. Available: list, status`);
  process.exitCode = 1;
}
