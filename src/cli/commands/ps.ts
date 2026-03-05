/**
 * @fileoverview `wunderland ps` — list running agent daemon processes.
 * @module wunderland/cli/commands/ps
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import {
  cleanStaleDaemons,
  readAllDaemons,
  isDaemonAlive,
  formatUptime,
} from '../daemon/daemon-state.js';

export default async function cmdPs(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  // Clean stale entries first.
  await cleanStaleDaemons();

  const all = await readAllDaemons();
  const alive = all.filter((d) => isDaemonAlive(d.pid));

  if (alive.length === 0) {
    fmt.note(`No running agents. Start one with ${accent('wunderland serve')}`);
    return;
  }

  // JSON output.
  if (flags['format'] === 'json') {
    const output = alive.map((d) => ({
      ...d,
      uptime: formatUptime(Date.now() - new Date(d.startedAt).getTime()),
      alive: true,
    }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Table output.
  fmt.section('Agent Processes');

  const header = padRow('NAME', 'SEED ID', 'PORT', 'PID', 'UPTIME');
  console.log(`  ${dim(header)}`);

  for (const d of alive) {
    const uptime = formatUptime(Date.now() - new Date(d.startedAt).getTime());
    console.log(`  ${padRow(
      d.displayName,
      d.seedId,
      String(d.port),
      String(d.pid),
      sColor(uptime),
    )}`);
  }

  fmt.blank();
  fmt.note(`${alive.length} running agent${alive.length !== 1 ? 's' : ''}`);
  fmt.blank();
}

function padRow(name: string, seedId: string, port: string, pid: string, uptime: string): string {
  return `${name.padEnd(20)} ${seedId.padEnd(22)} ${port.padEnd(7)} ${pid.padEnd(8)} ${uptime}`;
}
