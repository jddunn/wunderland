// @ts-nocheck
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
  fmt.note(`The cron engine (${accent('CronScheduler')} + ${accent('cron_manage')} tool) ships in this build but is not yet wired to the agent runtime.`);
  fmt.note(`Wiring lands next: registered tool, persisted jobs, and server routes. ${dim('No jobs run today.')}`);
  fmt.blank();
}

async function cronStatus(_globals: GlobalFlags): Promise<void> {
  fmt.section('Cron Scheduler');
  fmt.blank();
  fmt.kvPair('Engine', accent('CronScheduler'));
  fmt.kvPair('Schedule Types', 'at (one-shot), every (interval), cron (expression)');
  fmt.kvPair('Payload Types', 'stimulus, webhook, message, custom');
  fmt.kvPair('Status', 'engine present, not yet activated by `wunderland start`');
  fmt.blank();
  fmt.note(`Scheduling is inert until the engine is registered with the runtime.`);
  fmt.note(`Until then, use ${accent('wunderland start')} with an external scheduler (cron, systemd timer) to trigger work.`);
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
