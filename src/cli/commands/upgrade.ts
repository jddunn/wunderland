// @ts-nocheck
/**
 * @fileoverview `wunderland upgrade` — check for updates and self-update.
 *
 * Queries the npm registry for the latest published version, compares with
 * the running version, and optionally runs the update command.
 *
 * @module wunderland/cli/commands/upgrade
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GlobalFlags } from '../types.js';
import { VERSION } from '../constants.js';
import { accent, success as sColor, warn as wColor, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

const execFileAsync = promisify(execFile);

const NPM_PACKAGE_NAME = 'wunderland';
const REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`;
const FETCH_TIMEOUT_MS = 10_000;

export default async function cmdUpgrade(
  _args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const checkOnly = flags['check'] === true;

  // ── Fetch latest version from npm ──────────────────────────────────────
  fmt.note('Checking for updates...');

  let latestVersion: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);

    if (!res.ok) {
      fmt.errorBlock('Registry error', `npm registry returned ${res.status}. Try again later.`);
      process.exitCode = 1;
      return;
    }

    const data = (await res.json()) as { version?: string };
    latestVersion = data.version ?? '';
    if (!latestVersion) {
      fmt.errorBlock('Parse error', 'Could not determine latest version from npm registry.');
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    fmt.errorBlock(
      'Network error',
      `Failed to reach npm registry: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  // ── Compare versions ───────────────────────────────────────────────────
  const current = VERSION;
  const isUpToDate = current === latestVersion || compareVersions(current, latestVersion) >= 0;

  fmt.blank();
  fmt.kvPair('Current', accent(current));
  fmt.kvPair('Latest', isUpToDate ? sColor(latestVersion) : wColor(latestVersion));

  if (isUpToDate) {
    fmt.blank();
    fmt.ok('Already up to date.');
    return;
  }

  fmt.blank();
  fmt.note(`Update available: ${accent(current)} → ${sColor(latestVersion)}`);

  if (checkOnly) {
    fmt.blank();
    fmt.note(`Run ${accent('wunderland upgrade')} to update.`);
    return;
  }

  // ── Detect package manager ─────────────────────────────────────────────
  const pm = await detectPackageManager();

  if (!pm) {
    fmt.blank();
    fmt.note('Could not detect package manager. Update manually:');
    fmt.note(`  ${accent(`npm install -g ${NPM_PACKAGE_NAME}@latest`)}`);
    return;
  }

  // ── Confirm (unless --yes) ─────────────────────────────────────────────
  if (!globals.yes && !globals.quiet && process.stdin.isTTY && process.stdout.isTTY) {
    const p = await import('@clack/prompts');
    const confirm = await p.confirm({
      message: `Update ${NPM_PACKAGE_NAME} to ${latestVersion} via ${pm.name}?`,
      initialValue: true,
    });
    if (p.isCancel(confirm) || !confirm) {
      fmt.note('Cancelled.');
      return;
    }
  }

  // ── Run update ─────────────────────────────────────────────────────────
  fmt.blank();
  fmt.note(`Updating via ${accent(pm.name)}...`);

  try {
    const { stdout, stderr } = await execFileAsync(pm.bin, pm.args, {
      timeout: 120_000,
      env: { ...process.env },
    });
    if (stdout.trim()) console.log(dim(stdout.trim()));
    if (stderr.trim() && !stderr.includes('WARN')) {
      console.error(dim(stderr.trim()));
    }
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    fmt.errorBlock('Update failed', msg);
    fmt.note(`Try manually: ${accent(pm.manualCmd)}`);
    process.exitCode = 1;
    return;
  }

  fmt.blank();
  fmt.ok(`Updated to ${sColor(latestVersion)}`);
  fmt.note('Restart any running daemons to use the new version.');
  fmt.blank();
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Simple semver comparison. Returns positive if a > b, negative if a < b, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

interface PmInfo {
  name: string;
  bin: string;
  args: string[];
  manualCmd: string;
}

async function detectPackageManager(): Promise<PmInfo | null> {
  // Check if installed via pnpm global.
  if (await binExists('pnpm')) {
    return {
      name: 'pnpm',
      bin: 'pnpm',
      args: ['add', '-g', `${NPM_PACKAGE_NAME}@latest`],
      manualCmd: `pnpm add -g ${NPM_PACKAGE_NAME}@latest`,
    };
  }

  // Check npm.
  if (await binExists('npm')) {
    return {
      name: 'npm',
      bin: 'npm',
      args: ['install', '-g', `${NPM_PACKAGE_NAME}@latest`],
      manualCmd: `npm install -g ${NPM_PACKAGE_NAME}@latest`,
    };
  }

  return null;
}

async function binExists(bin: string): Promise<boolean> {
  try {
    await execFileAsync('which', [bin]);
    return true;
  } catch {
    return false;
  }
}
