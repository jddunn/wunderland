import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Detects the project's package manager by checking for lockfiles.
 * Priority: pnpm > yarn > bun > npm (fallback).
 */
export function detectPackageManager(cwd?: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  const dir = cwd ?? process.cwd();
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lockb'))) return 'bun';
  return 'npm';
}

const ADD_CMD: Record<string, string> = {
  pnpm: 'pnpm add',
  yarn: 'yarn add',
  bun: 'bun add',
  npm: 'npm install',
};

const REMOVE_CMD: Record<string, string> = {
  pnpm: 'pnpm remove',
  yarn: 'yarn remove',
  bun: 'bun remove',
  npm: 'npm uninstall',
};

/**
 * Installs an npm package using the detected package manager.
 * Returns true on success, false on failure (logs stderr).
 */
export async function installExtension(
  packageName: string,
  opts?: { cwd?: string; dev?: boolean },
): Promise<boolean> {
  const pm = detectPackageManager(opts?.cwd);
  const devFlag = opts?.dev ? ' -D' : '';
  const cmd = `${ADD_CMD[pm]}${devFlag} ${packageName}`;
  try {
    execSync(cmd, {
      cwd: opts?.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return true;
  } catch (err: any) {
    const stderr = err?.stderr?.toString() ?? err?.message ?? 'Unknown error';
    console.error(`Failed to install ${packageName}: ${stderr}`);
    return false;
  }
}

/**
 * Uninstalls an npm package.
 */
export async function uninstallExtension(
  packageName: string,
  opts?: { cwd?: string },
): Promise<boolean> {
  const pm = detectPackageManager(opts?.cwd);
  const cmd = `${REMOVE_CMD[pm]} ${packageName}`;
  try {
    execSync(cmd, {
      cwd: opts?.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return true;
  } catch (err: any) {
    console.error(`Failed to uninstall ${packageName}: ${err?.message}`);
    return false;
  }
}
