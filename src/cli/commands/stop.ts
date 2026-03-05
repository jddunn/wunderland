/**
 * @fileoverview `wunderland stop [seedId]` — gracefully stop a running daemon.
 * @module wunderland/cli/commands/stop
 */

import type { GlobalFlags } from '../types.js';
import { accent } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import {
  cleanStaleDaemons,
  readAllDaemons,
  removeDaemonInfo,
  isDaemonAlive,
  resolveDaemon,
  type DaemonInfo,
} from '../daemon/daemon-state.js';

const GRACEFUL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

export default async function cmdStop(
  args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const stopAll = flags['all'] === true;
  const forceKill = flags['force'] === true;

  let targets: DaemonInfo[];

  if (stopAll) {
    await cleanStaleDaemons();
    const all = await readAllDaemons();
    targets = all.filter((d) => isDaemonAlive(d.pid));
    if (targets.length === 0) {
      fmt.note('No running daemons to stop.');
      return;
    }
  } else {
    const seedIdArg = args[0];
    const { info, error } = await resolveDaemon(seedIdArg);
    if (!info) {
      fmt.errorBlock('No daemon', error || 'No daemon found.');
      process.exitCode = 1;
      return;
    }
    targets = [info];
  }

  for (const daemon of targets) {
    await stopDaemon(daemon, forceKill);
  }

  if (targets.length > 1) {
    fmt.blank();
    fmt.note(`Stopped ${targets.length} daemon${targets.length !== 1 ? 's' : ''}.`);
  }
  fmt.blank();
}

async function stopDaemon(daemon: DaemonInfo, forceKill: boolean): Promise<void> {
  const { pid, seedId, displayName, port } = daemon;

  if (!isDaemonAlive(pid)) {
    fmt.note(`${displayName} (PID: ${pid}) is already stopped.`);
    await removeDaemonInfo(seedId);
    return;
  }

  // Send signal.
  const signal = forceKill ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(pid, signal);
  } catch (err: any) {
    if (err?.code === 'ESRCH') {
      fmt.note(`${displayName} (PID: ${pid}) is already stopped.`);
      await removeDaemonInfo(seedId);
      return;
    }
    throw err;
  }

  if (forceKill) {
    // SIGKILL is immediate — just clean up.
    await removeDaemonInfo(seedId);
    fmt.ok(`Force-stopped ${accent(displayName)} (PID: ${pid}, port ${port})`);
    return;
  }

  // Poll until process exits or timeout.
  const deadline = Date.now() + GRACEFUL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isDaemonAlive(pid)) {
      await removeDaemonInfo(seedId);
      fmt.ok(`Stopped ${accent(displayName)} (PID: ${pid}, port ${port})`);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Graceful timeout exceeded — escalate to SIGKILL.
  fmt.warning(
    `${displayName} (PID: ${pid}) did not exit within ${GRACEFUL_TIMEOUT_MS / 1000}s. Sending SIGKILL...`,
  );
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process may have just exited.
  }

  // Brief wait for SIGKILL to take effect.
  await new Promise((r) => setTimeout(r, 500));
  await removeDaemonInfo(seedId);
  fmt.ok(`Force-stopped ${accent(displayName)} (PID: ${pid}, port ${port})`);
}
