/**
 * @fileoverview Watchdog process — monitors a daemon and restarts on crash.
 *
 * Spawned as a detached background process by `wunderland serve --restart`.
 * Polls the agent's /health endpoint and respawns if the process dies.
 *
 * @module wunderland/cli/daemon/watchdog
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, appendFile, open } from 'node:fs/promises';
import * as path from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface WatchdogConfig {
  seedId: string;
  port: number;
  /** Full args for process.execPath to respawn the agent (e.g. ['/path/to/wunderland.js', 'start', ...]). */
  spawnArgs: string[];
  /** Working directory for the spawned agent. */
  spawnCwd: string;
  /** Daemon state directory (~/.wunderland/daemons/{seedId}/). */
  daemonDir: string;
  /** Max restart attempts before giving up (default: 10). */
  maxRestarts: number;
  /** Health poll interval in ms (default: 10_000). */
  healthInterval: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const CONSECUTIVE_FAILURES_THRESHOLD = 3;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

// ── Helpers ────────────────────────────────────────────────────────────────

function isDaemonAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function checkHealth(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function readDaemonPid(daemonDir: string): Promise<number | null> {
  try {
    const raw = await readFile(path.join(daemonDir, 'daemon.pid'), 'utf-8');
    const pid = parseInt(raw.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

async function updateDaemonJson(
  daemonDir: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const jsonPath = path.join(daemonDir, 'daemon.json');
  try {
    const raw = await readFile(jsonPath, 'utf-8');
    const info = JSON.parse(raw);
    Object.assign(info, updates);
    await writeFile(jsonPath, JSON.stringify(info, null, 2) + '\n', 'utf-8');
  } catch {
    // Best-effort
  }
}

async function logRestart(daemonDir: string, msg: string): Promise<void> {
  const ts = new Date().toISOString();
  const line = `[${ts}] [watchdog] ${msg}\n`;
  try {
    await appendFile(path.join(daemonDir, 'stderr.log'), line, 'utf-8');
  } catch {
    // Best-effort
  }
}

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS);
}

// ── Main watchdog loop ─────────────────────────────────────────────────────

export async function runWatchdog(config: WatchdogConfig): Promise<void> {
  const { seedId, port, spawnArgs, spawnCwd, daemonDir, maxRestarts, healthInterval } = config;

  let restartCount = 0;
  let consecutiveFailures = 0;
  let stopping = false;

  // Graceful exit on SIGTERM (from `wunderland stop`).
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });

  await logRestart(daemonDir, `Watchdog started for "${seedId}" on port ${port}`);

  while (!stopping) {
    await new Promise((r) => setTimeout(r, healthInterval));
    if (stopping) break;

    const pid = await readDaemonPid(daemonDir);

    // Check if process is alive.
    if (pid && isDaemonAlive(pid)) {
      // Process alive — check health.
      const healthy = await checkHealth(port);
      if (healthy) {
        consecutiveFailures = 0;
        continue;
      }
      consecutiveFailures++;
      if (consecutiveFailures < CONSECUTIVE_FAILURES_THRESHOLD) {
        continue; // Give it more chances.
      }
      // Too many consecutive health failures while process alive — force kill and restart.
      await logRestart(daemonDir, `Health check failed ${consecutiveFailures} times, killing PID ${pid}`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // May have already died.
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Process is dead — restart if within limits.
    if (restartCount >= maxRestarts) {
      await logRestart(daemonDir, `Max restarts (${maxRestarts}) exceeded. Watchdog exiting.`);
      break;
    }

    const delay = backoffMs(restartCount);
    await logRestart(
      daemonDir,
      `Agent died. Restarting (attempt ${restartCount + 1}/${maxRestarts}) after ${delay / 1000}s backoff...`,
    );

    await new Promise((r) => setTimeout(r, delay));
    if (stopping) break;

    // Respawn.
    try {
      const stdoutFd = await open(path.join(daemonDir, 'stdout.log'), 'a');
      const stderrFd = await open(path.join(daemonDir, 'stderr.log'), 'a');

      const child = spawn(process.execPath, spawnArgs, {
        detached: true,
        stdio: ['ignore', stdoutFd.fd, stderrFd.fd],
        cwd: spawnCwd,
        env: { ...process.env },
      });

      child.unref();
      const newPid = child.pid;

      await stdoutFd.close();
      await stderrFd.close();

      if (!newPid) {
        await logRestart(daemonDir, 'Spawn returned no PID — retry on next cycle.');
        restartCount++;
        continue;
      }

      restartCount++;
      consecutiveFailures = 0;

      // Update daemon state.
      await writeFile(path.join(daemonDir, 'daemon.pid'), String(newPid), 'utf-8');
      await updateDaemonJson(daemonDir, { pid: newPid, restartCount });

      await logRestart(daemonDir, `Restarted as PID ${newPid} (restart #${restartCount})`);
    } catch (err) {
      await logRestart(daemonDir, `Restart failed: ${err instanceof Error ? err.message : String(err)}`);
      restartCount++;
    }
  }

  await logRestart(daemonDir, 'Watchdog exiting.');
}

// ── CLI entry ──────────────────────────────────────────────────────────────

/** When this file is run directly via `node -e`, parse config from argv and start. */
if (process.argv[2] === '__watchdog__') {
  const configJson = process.argv[3];
  if (configJson) {
    try {
      const config = JSON.parse(configJson) as WatchdogConfig;
      void runWatchdog(config);
    } catch (err) {
      process.stderr.write(`[watchdog] Failed to parse config: ${err}\n`);
      process.exit(1);
    }
  }
}
