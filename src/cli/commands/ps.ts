/**
 * @fileoverview `wunderland ps` — list running agent daemon processes.
 * @module wunderland/cli/commands/ps
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim, success as sColor, warn as wColor, info as iColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import {
  cleanStaleDaemons,
  readAllDaemons,
  isDaemonAlive,
  formatUptime,
  fetchDaemonHealth,
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

  const skipHealth = flags['no-health'] === true;

  // Fetch health status for each daemon (in parallel).
  const healthResults = skipHealth
    ? new Map<string, { status: 'ok' | 'slow' | 'down'; mem?: number }>()
    : new Map(
        await Promise.all(
          alive.map(async (d) => {
            const h = await fetchDaemonHealth(d.port);
            return [d.seedId, { status: h.status, mem: h.data?.memory?.rss }] as const;
          }),
        ),
      );

  // JSON output.
  if (flags['format'] === 'json') {
    const output = alive.map((d) => {
      const h = healthResults.get(d.seedId);
      return {
        ...d,
        uptime: formatUptime(Date.now() - new Date(d.startedAt).getTime()),
        alive: true,
        health: h?.status ?? null,
        memoryMB: h?.mem ?? null,
      };
    });
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Table output.
  fmt.section('Agent Processes');

  const header = padRow('NAME', 'SEED ID', 'PORT', 'PID', 'HEALTH', 'RESTARTS', 'UPTIME', 'MEM');
  console.log(`  ${dim(header)}`);

  for (const d of alive) {
    const uptime = formatUptime(Date.now() - new Date(d.startedAt).getTime());
    const h = healthResults.get(d.seedId);
    const healthStr = !h
      ? dim('--')
      : h.status === 'ok'
        ? sColor('ok')
        : h.status === 'slow'
          ? wColor('slow')
          : iColor('down');
    const memStr = h?.mem ? `${h.mem}MB` : dim('--');
    const restarts = String(d.restartCount ?? 0);

    console.log(`  ${padRow(
      d.displayName,
      d.seedId,
      String(d.port),
      String(d.pid),
      healthStr,
      restarts,
      sColor(uptime),
      memStr,
    )}`);
  }

  fmt.blank();
  fmt.note(`${alive.length} running agent${alive.length !== 1 ? 's' : ''}`);
  fmt.blank();
}

function padRow(
  name: string, seedId: string, port: string, pid: string,
  health: string, restarts: string, uptime: string, mem: string,
): string {
  return `${name.padEnd(18)} ${seedId.padEnd(20)} ${port.padEnd(6)} ${pid.padEnd(8)} ${health.padEnd(8)} ${restarts.padEnd(4)} ${uptime.padEnd(10)} ${mem}`;
}
