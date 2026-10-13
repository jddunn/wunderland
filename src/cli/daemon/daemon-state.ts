// @ts-nocheck
/**
 * @fileoverview Daemon state management — PID files, daemon info, lifecycle helpers.
 * Shared by `serve`, `ps`, `logs`, and `stop` commands.
 * @module wunderland/cli/daemon/daemon-state
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { CONFIG_DIR_NAME } from '../constants.js';
import * as fmt from '../ui/format.js';
import { InvalidAgentWorkspaceIdError, sanitizeAgentWorkspaceId } from '../../runtime/tools/workspace.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface DaemonInfo {
  /** Agent seed ID from agent.config.json. */
  seedId: string;
  /** Human-readable agent name. */
  displayName: string;
  /** Server port. */
  port: number;
  /** OS process ID of the detached node process. */
  pid: number;
  /** Absolute path to agent.config.json used to start the daemon. */
  configPath: string;
  /** ISO 8601 timestamp of when the daemon was started. */
  startedAt: string;
  /** Number of times the watchdog has restarted this daemon. */
  restartCount: number;
  /** Restart policy: 'never' (default) or 'on-crash' (watchdog active). */
  restartPolicy: 'never' | 'on-crash';
  /** PID of the watchdog process (present when restartPolicy is 'on-crash'). */
  watchdogPid?: number;
}

/** Health check response from the /health endpoint. */
export interface HealthResponse {
  ok: boolean;
  seedId: string;
  name: string;
  persona?: { id?: string; name?: string };
  personasAvailable?: number;
  uptime?: number;
  version?: string;
  port?: number;
  memory?: { rss: number; heap: number };
  tools?: number;
  channels?: number;
}

// ── Path helpers ───────────────────────────────────────────────────────────

/** Root directory for all daemon state: ~/.wunderland/daemons/ */
export function getDaemonsDir(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, 'daemons');
}

/**
 * Per-daemon directory: ~/.wunderland/daemons/{sanitized-seedId}/
 *
 * @throws InvalidAgentWorkspaceIdError when the seed id's cleaned name starts
 *   or ends with a dot, so it names no folder of its own in the daemons folder.
 */
export function getDaemonDir(seedId: string): string {
  return path.join(getDaemonsDir(), sanitizeAgentWorkspaceId(seedId));
}

// ── Read / Write ───────────────────────────────────────────────────────────

/** Write daemon metadata + PID file after spawning. */
export async function writeDaemonInfo(info: DaemonInfo): Promise<void> {
  const dir = getDaemonDir(info.seedId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'daemon.json'), JSON.stringify(info, null, 2) + '\n', 'utf-8');
  await writeFile(path.join(dir, 'daemon.pid'), String(info.pid), 'utf-8');
}

/** Read daemon info for a specific seedId. Returns null if not found. */
export async function readDaemonInfo(seedId: string): Promise<DaemonInfo | null> {
  const jsonPath = path.join(getDaemonDir(seedId), 'daemon.json');
  if (!existsSync(jsonPath)) return null;
  try {
    const raw = await readFile(jsonPath, 'utf-8');
    return JSON.parse(raw) as DaemonInfo;
  } catch {
    return null;
  }
}

/** Each daemon directory that holds a readable daemon.json, with its info. */
async function readDaemonEntries(): Promise<Array<{ dir: string; info: DaemonInfo }>> {
  const daemonsDir = getDaemonsDir();
  if (!existsSync(daemonsDir)) return [];

  const entries = await readdir(daemonsDir, { withFileTypes: true });
  const results: Array<{ dir: string; info: DaemonInfo }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(daemonsDir, entry.name);
    const jsonPath = path.join(dir, 'daemon.json');
    if (!existsSync(jsonPath)) continue;
    try {
      const raw = await readFile(jsonPath, 'utf-8');
      results.push({ dir, info: JSON.parse(raw) as DaemonInfo });
    } catch {
      // A corrupt entry is skipped.
    }
  }

  return results;
}

/** Scan all daemon directories and return their info. */
export async function readAllDaemons(): Promise<DaemonInfo[]> {
  return (await readDaemonEntries()).map((entry) => entry.info);
}

/** Merge-update daemon.json fields without overwriting the entire file. */
export async function updateDaemonInfo(
  seedId: string,
  partial: Partial<DaemonInfo>,
): Promise<DaemonInfo | null> {
  const existing = await readDaemonInfo(seedId);
  if (!existing) return null;
  const updated = { ...existing, ...partial };
  const dir = getDaemonDir(seedId);
  await writeFile(path.join(dir, 'daemon.json'), JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  if (partial.pid !== undefined) {
    await writeFile(path.join(dir, 'daemon.pid'), String(partial.pid), 'utf-8');
  }
  return updated;
}

/**
 * Remove daemon state directory (PID file, logs, metadata). A seed id whose
 * cleaned name starts or ends with a dot names no state folder, so nothing is
 * removed for it and one warning line says why; state an older release left
 * under such a name is removed by {@link cleanStaleDaemons} once its process
 * has exited.
 */
export async function removeDaemonInfo(seedId: string): Promise<void> {
  let dir: string;
  try {
    dir = getDaemonDir(seedId);
  } catch (error) {
    if (!(error instanceof InvalidAgentWorkspaceIdError)) throw error;
    fmt.warning(`Daemon state for ${JSON.stringify(seedId)} left in place: ${error.message}.`);
    return;
  }
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Process helpers ────────────────────────────────────────────────────────

/** Check if a process with the given PID is still alive (signal 0 = existence check). */
export function isDaemonAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove daemon entries whose PID is no longer alive. Returns removed entries.
 * Each is removed by the directory it was read from, which lies directly in
 * the daemons folder, so the seed id its daemon.json records never decides
 * what is removed, and an entry an older release wrote under a seed id that is
 * now refused is removed too.
 */
export async function cleanStaleDaemons(): Promise<DaemonInfo[]> {
  const stale: DaemonInfo[] = [];

  for (const { dir, info } of await readDaemonEntries()) {
    if (!isDaemonAlive(info.pid)) {
      stale.push(info);
      await rm(dir, { recursive: true, force: true });
    }
  }

  return stale;
}

/** Format a duration in ms to a human-readable uptime string. */
export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Resolve a single daemon — by explicit seedId, or auto-resolve if only one is running. */
export async function resolveDaemon(
  seedIdArg: string | undefined,
): Promise<{ info: DaemonInfo | null; error?: string }> {
  if (seedIdArg) {
    const info = await readDaemonInfo(seedIdArg);
    if (!info) return { info: null, error: `No daemon found for "${seedIdArg}".` };
    if (!isDaemonAlive(info.pid)) {
      await removeDaemonInfo(info.seedId);
      return { info: null, error: `Daemon "${seedIdArg}" is no longer running (stale PID).` };
    }
    return { info };
  }

  // Auto-resolve: clean stale, then check count.
  await cleanStaleDaemons();
  const all = await readAllDaemons();
  const alive = all.filter((d) => isDaemonAlive(d.pid));

  if (alive.length === 0) {
    return { info: null, error: 'No running daemons. Start one with `wunderland serve`.' };
  }
  if (alive.length === 1) {
    return { info: alive[0] };
  }
  const list = alive.map((d) => `  ${d.displayName} (${d.seedId}) — port ${d.port}`).join('\n');
  return {
    info: null,
    error: `Multiple daemons running. Specify a seedId:\n${list}`,
  };
}

/** Poll a URL until it responds 2xx, or timeout. */
export async function pollHealth(
  url: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Fetch health status from a daemon's /health endpoint. */
export async function fetchDaemonHealth(
  port: number,
  timeoutMs = 2000,
): Promise<{ status: 'ok' | 'slow' | 'down'; latencyMs: number; data?: HealthResponse }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    if (!res.ok) return { status: 'down', latencyMs };
    const data = (await res.json()) as HealthResponse;
    return { status: latencyMs > 1000 ? 'slow' : 'ok', latencyMs, data };
  } catch {
    return { status: 'down', latencyMs: Date.now() - start };
  }
}
