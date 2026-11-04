// @ts-nocheck
/**
 * @fileoverview Integration tests for daemon state cleanup, under a temp home folder.
 * @module wunderland/cli/daemon/__tests__/daemon-state.integration.test
 *
 * `wunderland ps`, `monitor`, `stop` and the TUI agents view clean stale daemon
 * state first. Each stale entry is removed by the folder it was read from,
 * whatever seed id its daemon.json records, and a seed id that names no
 * folder of its own never removes anything.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const home = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => home.dir;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { tmpdir } from 'node:os';
import { cleanStaleDaemons, readAllDaemons, removeDaemonInfo } from '../daemon-state.js';

/** A PID no process has: the largest a PID can be, far above any system's limit. */
const DEAD_PID = 2147483646;

let wunderlandDir: string;
let daemonsDir: string;

/** A daemon state folder under the daemons folder, holding a daemon.json for `seedId`. */
function writeDaemon(folder: string, seedId: string): string {
  const dir = path.join(daemonsDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'daemon.json'),
    JSON.stringify({ seedId, displayName: seedId, port: 3777, pid: DEAD_PID, configPath: '', startedAt: '', restartCount: 0, restartPolicy: 'never' }),
  );
  writeFileSync(path.join(dir, 'stdout.log'), 'log\n');
  return dir;
}

beforeEach(() => {
  home.dir = mkdtempSync(path.join(tmpdir(), 'wunderland-daemon-state-'));
  wunderlandDir = path.join(home.dir, '.wunderland');
  daemonsDir = path.join(wunderlandDir, 'daemons');
  mkdirSync(daemonsDir, { recursive: true });
  // Files beside the daemons folder that no cleanup may touch.
  writeFileSync(path.join(wunderlandDir, 'config.json'), '{}\n');
  writeFileSync(path.join(home.dir, 'notes.txt'), 'keep\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home.dir, { recursive: true, force: true });
});

describe('daemon state cleanup', () => {
  it('removes each stale entry by its own folder, whatever seed id it records', async () => {
    writeDaemon('seed_ok', 'seed_ok');
    // Written by an older release, which cleaned 'agent.' to that folder name.
    writeDaemon('agent.', 'agent.');
    // A daemon.json whose seed id would name the folder above the daemons folder.
    writeDaemon('other', '..');

    const stale = await cleanStaleDaemons();

    expect(stale.map((info) => info.seedId).sort()).toEqual(['..', 'agent.', 'seed_ok']);
    expect(readdirSync(daemonsDir)).toEqual([]);
    expect(readdirSync(wunderlandDir).sort()).toEqual(['config.json', 'daemons']);
    expect(existsSync(path.join(home.dir, 'notes.txt'))).toBe(true);
    expect(await readAllDaemons()).toEqual([]);
  });

  it('removes nothing for a seed id that names no folder of its own, and says why', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)));
    const legacy = writeDaemon('agent.', 'agent.');

    await removeDaemonInfo('..');
    await removeDaemonInfo('.');
    await removeDaemonInfo('agent.');

    expect(existsSync(legacy)).toBe(true);
    expect(readdirSync(wunderlandDir).sort()).toEqual(['config.json', 'daemons']);
    expect(lines.filter((line) => line.includes('left in place'))).toHaveLength(3);

    const kept = writeDaemon('seed_ok', 'seed_ok');
    await removeDaemonInfo('seed_ok');
    expect(existsSync(kept)).toBe(false);
  });
});
