// @ts-nocheck
/**
 * @fileoverview `wunderland monitor` — live dashboard of running agent daemons.
 * Refreshes every 5s with health status, memory, restarts.
 * @module wunderland/cli/commands/monitor
 */

import type { GlobalFlags } from '../../types.js';
import { accent, dim, success as sColor, warn as wColor, info as iColor } from '../../ui/theme.js';
import * as fmt from '../../ui/format.js';
import {
  cleanStaleDaemons,
  readAllDaemons,
  isDaemonAlive,
  formatUptime,
  fetchDaemonHealth,
  type HealthResponse,
} from '../../daemon/daemon-state.js';

const REFRESH_INTERVAL_MS = 5_000;

export default async function cmdMonitor(
  _args: string[],
  _flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  let stopping = false;

  const cleanup = () => {
    stopping = true;
    // Show cursor again and move to a clean line.
    process.stdout.write('\x1B[?25h\n');
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Hide cursor for cleaner refresh.
  if (process.stdout.isTTY) {
    process.stdout.write('\x1B[?25l');
  }

  while (!stopping) {
    await renderDashboard();
    await new Promise((r) => setTimeout(r, REFRESH_INTERVAL_MS));
  }
}

async function renderDashboard(): Promise<void> {
  await cleanStaleDaemons();
  const all = await readAllDaemons();
  const alive = all.filter((d) => isDaemonAlive(d.pid));

  // Fetch health for all daemons in parallel.
  const healthMap = new Map<string, { status: 'ok' | 'slow' | 'down'; data?: HealthResponse }>();
  await Promise.all(
    alive.map(async (d) => {
      const h = await fetchDaemonHealth(d.port);
      healthMap.set(d.seedId, { status: h.status, data: h.data });
    }),
  );

  // Clear screen.
  if (process.stdout.isTTY) {
    process.stdout.write('\x1B[2J\x1B[H');
  }

  const now = new Date().toLocaleTimeString();

  fmt.section(`Agent Monitor ${dim(`(refreshing every ${REFRESH_INTERVAL_MS / 1000}s — Ctrl+C to exit)`)}`);
  fmt.blank();

  if (alive.length === 0) {
    fmt.note(`No running agents. Start one with ${accent('wunderland serve')}`);
    fmt.blank();
    fmt.kvPair('Last checked', dim(now));
    return;
  }

  // Header.
  const header = padRow('NAME', 'SEED ID', 'PORT', 'PID', 'HEALTH', 'RESTARTS', 'UPTIME', 'MEM');
  console.log(`  ${dim(header)}`);

  for (const d of alive) {
    const uptime = formatUptime(Date.now() - new Date(d.startedAt).getTime());
    const h = healthMap.get(d.seedId);
    const healthStr = !h
      ? dim('--')
      : h.status === 'ok'
        ? sColor('ok')
        : h.status === 'slow'
          ? wColor('slow')
          : iColor('down');
    const memStr = h?.data?.memory?.rss ? `${h.data.memory.rss}MB` : dim('--');
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
  fmt.kvPair('Agents', `${alive.length} running`);
  fmt.kvPair('Last checked', dim(now));
  fmt.blank();
}

function padRow(
  name: string, seedId: string, port: string, pid: string,
  health: string, restarts: string, uptime: string, mem: string,
): string {
  return `${name.padEnd(18)} ${seedId.padEnd(20)} ${port.padEnd(6)} ${pid.padEnd(8)} ${health.padEnd(8)} ${restarts.padEnd(4)} ${uptime.padEnd(10)} ${mem}`;
}
