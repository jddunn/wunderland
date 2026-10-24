// @ts-nocheck
/**
 * @fileoverview Integration tests for `wunderland serve --host`, under a temp home folder.
 * @module wunderland/cli/commands/agent/__tests__/serve-host.integration.test
 *
 * serve runs `wunderland start` as a detached child. It passes `--host` on to
 * the child and polls the child's /health at the address the child listens on.
 * The child process and the health poll are recorded, not run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const state = vi.hoisted(() => ({ home: '', spawned: [] as string[][], polled: [] as string[] }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => state.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const spawn = (_command: string, args: string[]) => {
    state.spawned.push(args);
    return { pid: 4242, unref() {} };
  };
  return { ...actual, spawn, default: { ...actual, spawn } };
});

vi.mock('../../../daemon/daemon-state.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    pollHealth: async (url: string) => {
      state.polled.push(url);
      return true;
    },
  };
});

import { tmpdir } from 'node:os';
import cmdServe from '../serve.js';

let configPath: string;
let argv1: string | undefined;

beforeEach(() => {
  state.home = mkdtempSync(path.join(tmpdir(), 'wunderland-serve-host-'));
  state.spawned = [];
  state.polled = [];
  const agentDir = path.join(state.home, 'agent');
  mkdirSync(agentDir);
  configPath = path.join(agentDir, 'agent.config.json');
  writeFileSync(configPath, JSON.stringify({ seedId: 'seed_serve_host', displayName: 'Serve Host' }));
  // serve spawns process.argv[1] as the wunderland binary and checks that the file exists.
  argv1 = process.argv[1];
  process.argv[1] = configPath;
});

afterEach(() => {
  process.argv[1] = argv1;
  rmSync(state.home, { recursive: true, force: true });
});

/** The value the child's argument list gives `flag`, or undefined. */
function childFlag(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe('wunderland serve', () => {
  it('passes --host 0.0.0.0 to wunderland start and polls health on localhost', async () => {
    await cmdServe([], { config: configPath, port: '4567', host: '0.0.0.0' }, { quiet: true });
    expect(state.spawned).toHaveLength(1);
    expect(childFlag(state.spawned[0], '--host')).toBe('0.0.0.0');
    expect(state.polled).toEqual(['http://localhost:4567/health']);
  });

  it('polls a named address at that address', async () => {
    await cmdServe([], { config: configPath, port: '4568', host: '127.0.0.2' }, { quiet: true });
    expect(childFlag(state.spawned[0], '--host')).toBe('127.0.0.2');
    expect(state.polled).toEqual(['http://127.0.0.2:4568/health']);
  });

  it('leaves the child on its 127.0.0.1 default when --host is not given', async () => {
    await cmdServe([], { config: configPath, port: '4569' }, { quiet: true });
    expect(state.spawned[0]).not.toContain('--host');
    expect(state.polled).toEqual(['http://127.0.0.1:4569/health']);
  });

  it('refuses --host without an address and starts nothing', async () => {
    const exitCode = process.exitCode;
    try {
      await cmdServe([], { config: configPath, port: '4570', host: true }, { quiet: true });
      expect(process.exitCode).toBe(1);
      expect(state.spawned).toEqual([]);
    } finally {
      process.exitCode = exitCode;
    }
  });
});
