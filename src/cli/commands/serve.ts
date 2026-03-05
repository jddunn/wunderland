/**
 * @fileoverview `wunderland serve` — start agent server as a background daemon.
 *
 * Wraps `wunderland start` in a detached child process with stdout/stderr
 * redirected to log files. Writes PID + metadata to ~/.wunderland/daemons/.
 *
 * @module wunderland/cli/commands/serve
 */

import { existsSync } from 'node:fs';
import { readFile, mkdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, info as iColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import {
  getDaemonDir,
  readDaemonInfo,
  writeDaemonInfo,
  isDaemonAlive,
  pollHealth,
} from '../daemon/daemon-state.js';

const DEFAULT_PORT = 3777;
const HEALTH_POLL_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 500;

export default async function cmdServe(
  _args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  // ── Resolve agent.config.json ──────────────────────────────────────────
  const configPath =
    typeof flags['config'] === 'string'
      ? path.resolve(process.cwd(), flags['config'])
      : path.resolve(process.cwd(), 'agent.config.json');

  if (!existsSync(configPath)) {
    fmt.errorBlock(
      'Missing config file',
      `${configPath}\nRun: ${accent('wunderland init my-agent')}`,
    );
    process.exitCode = 1;
    return;
  }

  let cfg: any;
  try {
    const raw = await readFile(configPath, 'utf-8');
    cfg = JSON.parse(raw);
  } catch (err) {
    fmt.errorBlock(
      'Invalid config file',
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1;
    return;
  }

  const seedId = String(cfg.seedId || 'seed_local_agent');
  const displayName = String(cfg.displayName || 'My Agent');

  // ── Resolve port ───────────────────────────────────────────────────────
  let port = DEFAULT_PORT;
  if (typeof flags['port'] === 'string') {
    const parsed = parseInt(flags['port'], 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) port = parsed;
  } else if (process.env['PORT']) {
    const envPort = parseInt(process.env['PORT'], 10);
    if (!isNaN(envPort) && envPort >= 1 && envPort <= 65535) port = envPort;
  }

  // ── Check if already running ───────────────────────────────────────────
  const existing = await readDaemonInfo(seedId);
  if (existing && isDaemonAlive(existing.pid)) {
    fmt.errorBlock(
      'Already running',
      `Agent "${displayName}" (${seedId}) is already running on port ${existing.port} (PID: ${existing.pid}).\n` +
        `Use ${accent(`wunderland stop ${seedId}`)} to stop it first.`,
    );
    process.exitCode = 1;
    return;
  }

  // ── Resolve wunderland binary path ─────────────────────────────────────
  // process.argv[1] is the bin/wunderland.js entry point when run via npm/pnpm.
  const wunderlandBin = process.argv[1];
  if (!wunderlandBin || !existsSync(wunderlandBin)) {
    fmt.errorBlock(
      'Binary not found',
      'Could not resolve the wunderland binary path. Ensure wunderland is installed globally or via npx.',
    );
    process.exitCode = 1;
    return;
  }

  // ── Prepare daemon directory ───────────────────────────────────────────
  const daemonDir = getDaemonDir(seedId);
  await mkdir(daemonDir, { recursive: true });

  const stdoutPath = path.join(daemonDir, 'stdout.log');
  const stderrPath = path.join(daemonDir, 'stderr.log');

  const stdoutFd = await open(stdoutPath, 'a');
  const stderrFd = await open(stderrPath, 'a');

  // ── Build child args ───────────────────────────────────────────────────
  const childArgs = [wunderlandBin, 'start', '--config', configPath, '--port', String(port), '--quiet'];

  // Forward relevant flags
  if (typeof flags['model'] === 'string') {
    childArgs.push('--model', flags['model']);
  }
  if (typeof flags['provider'] === 'string') {
    childArgs.push('--provider', flags['provider']);
  }
  if (flags['ollama'] === true) {
    childArgs.push('--ollama');
  }
  if (typeof flags['security-tier'] === 'string') {
    childArgs.push('--security-tier', flags['security-tier']);
  }
  if (flags['lazy-tools'] === true) {
    childArgs.push('--lazy-tools');
  }
  if (flags['auto-approve-tools'] === true || globals.autoApproveTools) {
    childArgs.push('--auto-approve-tools');
  }
  if (typeof flags['skills-dir'] === 'string') {
    childArgs.push('--skills-dir', flags['skills-dir']);
  }
  if (flags['no-skills'] === true) {
    childArgs.push('--no-skills');
  }

  // ── Spawn detached child ───────────────────────────────────────────────
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', stdoutFd.fd, stderrFd.fd],
    cwd: path.dirname(configPath),
    env: { ...process.env },
  });

  child.unref();
  const pid = child.pid;

  // Close file handles in parent (child has inherited the fds).
  await stdoutFd.close();
  await stderrFd.close();

  if (!pid) {
    fmt.errorBlock('Spawn failed', 'Failed to start daemon process.');
    process.exitCode = 1;
    return;
  }

  // ── Write daemon info ──────────────────────────────────────────────────
  await writeDaemonInfo({
    seedId,
    displayName,
    port,
    pid,
    configPath,
    startedAt: new Date().toISOString(),
  });

  // ── Poll health ────────────────────────────────────────────────────────
  if (!globals.quiet) {
    fmt.note('Starting daemon...');
  }

  const healthy = await pollHealth(
    `http://localhost:${port}/health`,
    HEALTH_POLL_TIMEOUT_MS,
    HEALTH_POLL_INTERVAL_MS,
  );

  if (!healthy) {
    // Check if process is still alive — it might have crashed on startup.
    if (!isDaemonAlive(pid)) {
      fmt.errorBlock(
        'Daemon crashed',
        `The daemon process exited before becoming healthy.\nCheck logs: ${accent(`wunderland logs ${seedId}`)}`,
      );
      process.exitCode = 1;
      return;
    }
    fmt.warning(
      `Health check timed out after ${HEALTH_POLL_TIMEOUT_MS / 1000}s. ` +
        `The daemon may still be starting. Check: ${accent(`wunderland logs ${seedId}`)}`,
    );
  }

  // ── Print summary ──────────────────────────────────────────────────────
  fmt.section('Daemon Started');
  fmt.kvPair('Agent', accent(displayName));
  fmt.kvPair('Seed ID', seedId);
  fmt.kvPair('Port', String(port));
  fmt.kvPair('PID', String(pid));
  fmt.kvPair('Health', healthy ? sColor('ok') : iColor('pending'));
  fmt.kvPair('Logs', accent(path.join(getDaemonDir(seedId), 'stdout.log')));
  fmt.blank();
  fmt.note(`Status:  ${accent('wunderland ps')}`);
  fmt.note(`Logs:    ${accent(`wunderland logs ${seedId}`)}`);
  fmt.note(`Stop:    ${accent(`wunderland stop ${seedId}`)}`);
  fmt.blank();
}
