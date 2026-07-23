// @ts-nocheck
/**
 * @fileoverview `wunderland attach` — persistent browser-attach daemon controls.
 *
 * start   spawn + hold the raw-CDP daemon (one macOS Local Network prompt per
 *         daemon lifetime; the daemon is the ONLY process that touches the
 *         network — every other participant talks to it through files)
 * status  status.json + live ping (exit 0 iff a daemon is alive)
 * stop    graceful quit (parks the agent tab, releases the lease; Chrome untouched)
 * run     drive the held session: .mjs/.js (JS lane, client injected) or
 *         .yaml/.yml/.json (declarative lane)
 *
 * HARD CONTRACTS: never launches/quits/restarts Chrome; never retries or
 * respawns the daemon (a respawn loop is a macOS prompt storm); localhost CDP;
 * no eval on the agent tool surface (the JS lane's `client.evaluate` is the
 * user lane).
 *
 * @module wunderland/cli/commands/attach
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { GlobalFlags } from '../types.js';
import { bright, dim, success as sColor, warn as wColor } from '../ui/theme.js';
import { attachOptionsFromEnv } from '../../runtime/tools/attach-env.js';

const DEFAULT_PROFILE_ROOT = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const DAEMON_PKG = '@framers/agentos-ext-browser-automation/attach/daemon';

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until status.json reaches a terminal boot state ('connected' | 'failed' | timeout). */
async function awaitConnected(client, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(400);
    const s = client.statusFile();
    if (s?.state === 'connected') return s;
    if (s?.state === 'failed') return s;
  }
  return client.statusFile();
}

async function cmdStart(args, client, daemonMod) {
  const profileRoot =
    flagValue(args, '--profile-root') ?? process.env.WUNDERLAND_ATTACH_PROFILE_ROOT ?? DEFAULT_PROFILE_ROOT;
  const identity = flagValue(args, '--identity') ?? attachOptionsFromEnv(process.env).attach?.expectedIdentity;
  const ipcDir = flagValue(args, '--ipc-dir');

  if (!identity) {
    console.error(wColor('attach start needs an identity: --identity you@example.com or WUNDERLAND_ATTACH_IDENTITY'));
    process.exitCode = 2;
    return;
  }
  if (!existsSync(join(profileRoot, 'DevToolsActivePort'))) {
    console.error(wColor('Chrome is not exposing DevTools on this profile.'));
    console.error('Quit nothing — just relaunch YOUR Chrome once with remote debugging enabled:');
    console.error(dim('  open -a "Google Chrome" --args --remote-debugging-port=9222'));
    console.error('then run `wunderland attach start` again.');
    process.exitCode = 2;
    return;
  }
  if (client.daemonLooksAlive()) {
    console.log(sColor(`attach daemon already running (pid ${client.statusFile()?.pid}) — nothing to do`));
    return;
  }

  console.log(bright('Starting the attach daemon.'));
  console.log('First run on this build: expect ONE macOS "Local Network" prompt — click Allow.');
  const entryPath = fileURLToPath(import.meta.resolve(`${DAEMON_PKG}/daemon-main`));
  const foreground = args.includes('--foreground');
  const child = spawn(process.execPath, [entryPath], {
    detached: !foreground,
    stdio: foreground ? 'inherit' : 'ignore',
    env: {
      ...process.env,
      WUNDERLAND_ATTACH_IDENTITY: identity,
      WUNDERLAND_ATTACH_PROFILE_ROOT: profileRoot,
      ...(ipcDir ? { WUNDERLAND_ATTACH_IPC_DIR: ipcDir } : {}),
    },
  });
  if (!foreground) child.unref();

  const status = await awaitConnected(client);
  if (status?.state === 'failed') {
    console.error(wColor(`daemon failed: ${status.lastError ?? 'unknown'}`));
    process.exitCode = 2;
    return;
  }
  if (status?.state !== 'connected') {
    console.error(wColor('daemon did not reach connected within 20s; see `wunderland attach status`'));
    process.exitCode = 2;
    return;
  }

  // First claim NOW, operator-present: verifies the profile identity and
  // creates the agent tab while you can see it. PROFILE_MISMATCH fails start
  // loudly instead of surfacing mid-mission.
  try {
    const claimed = await client.claim();
    await client.release();
    console.log(sColor('attach daemon connected.'));
    console.log(`identity: ${bright(String(claimed.identity ?? 'verified'))}`);
  } catch (err) {
    console.error(wColor(`identity/claim failed: [${err.code ?? '?'}] ${err.message}`));
    console.error('The daemon is up but unverified — fix the profile and rerun, or `wunderland attach stop`.');
    process.exitCode = 2;
  }
}

async function cmdStatus(client) {
  const s = client.statusFile();
  if (!s || !client.daemonLooksAlive()) {
    console.error(wColor('attach daemon: not running'));
    process.exitCode = 1;
    return;
  }
  try {
    await client.ping();
  } catch {
    console.error(wColor(`stale daemon (pid ${s.pid}) — not answering`));
    process.exitCode = 1;
    return;
  }
  console.log(
    `${sColor('running')} pid=${s.pid} state=${s.state} claimant=${s.claimant ?? '-'} identity=${s.identity ?? '-'}`,
  );
}

async function cmdStop(client) {
  if (!client.daemonLooksAlive()) {
    console.log('attach daemon: not running');
    return;
  }
  await client.quit();
  console.log(sColor('attach daemon stopped (Chrome untouched).'));
}

async function cmdRun(args, client, daemonMod) {
  const file = args[1];
  if (!file || !existsSync(resolve(file))) {
    console.error(wColor(`no script file: ${file ?? '(missing argument)'}`));
    process.exitCode = 2;
    return;
  }
  if (!client.daemonLooksAlive()) {
    console.error(wColor('no live attach daemon; run `wunderland attach start` first (this command never respawns it)'));
    process.exitCode = 2;
    return;
  }
  const outPath = flagValue(args, '--output');
  const ext = extname(file).toLowerCase();
  try {
    let result;
    if (ext === '.mjs' || ext === '.js') {
      const mod = await import(pathToFileURL(resolve(file)).href);
      if (typeof mod.default !== 'function') {
        throw new Error(`${file} must default-export: async (client, args) => ...`);
      }
      const argsJson = flagValue(args, '--args');
      try {
        result = await mod.default(client, argsJson ? JSON.parse(argsJson) : undefined);
      } finally {
        // A crashed script must not strand the claim until the ttl.
        await client.release().catch(() => {});
      }
    } else if (ext === '.yaml' || ext === '.yml' || ext === '.json') {
      const raw = readFileSync(resolve(file), 'utf8');
      const plan = ext === '.json' ? JSON.parse(raw) : (await import('yaml')).parse(raw);
      result = await daemonMod.runAttachScript(plan, client);
      if (result.ok === false) process.exitCode = 1;
    } else {
      throw new Error(`unsupported script type ${ext}: use .mjs/.js or .yaml/.yml/.json`);
    }
    const declarative = ext === '.json' || ext === '.yaml' || ext === '.yml';
    const dest = outPath ?? (declarative ? `./attach-run-${result?.name ?? 'out'}.json` : undefined);
    if (dest && result !== undefined) {
      writeFileSync(dest, JSON.stringify(result, null, 2));
      console.log(dim(`wrote ${dest}`));
    } else if (result !== undefined) {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    console.error(wColor(`attach run failed: [${err.code ?? 'ERR'}] ${err.message}`));
    process.exitCode = 1;
  }
}

export default async function cmdAttach(args: string[], _flags: GlobalFlags): Promise<void> {
  const sub = args[0];
  if (!['start', 'status', 'stop', 'run'].includes(sub)) {
    console.error(`usage: wunderland attach <start|status|stop|run> [...]
  start  [--identity <email>] [--profile-root <dir>] [--ipc-dir <dir>] [--foreground]
  status [--ipc-dir <dir>]
  stop   [--ipc-dir <dir>]
  run <file.mjs|file.yaml|file.json> [--args <json>] [--output <path>] [--ipc-dir <dir>]`);
    process.exitCode = 2;
    return;
  }

  // Dynamic import per CLI convention; resolution is proven by the
  // command-loaders test so a src reorg cannot ship a broken path silently.
  const daemonMod = await import(DAEMON_PKG);
  const client = new daemonMod.AttachDaemonClient({ ipcDir: flagValue(args, '--ipc-dir'), client: 'cli' });

  if (sub === 'start') return cmdStart(args, client, daemonMod);
  if (sub === 'status') return cmdStatus(client);
  if (sub === 'stop') return cmdStop(client);
  if (sub === 'run') return cmdRun(args, client, daemonMod);
}
