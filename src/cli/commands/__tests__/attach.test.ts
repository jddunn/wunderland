import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cmdAttach from '../attach.js';

// The command resolves @framers/agentos-ext-browser-automation (>=0.2.0, the
// daemon subpath) at RUNTIME. In the monorepo workspace that resolves; in a
// standalone checkout it exists only once 0.2.0 is published. Skip loudly
// instead of failing on resolution — same pattern as the env-gated e2e.
const packAvailable = await import('@framers/agentos-ext-browser-automation/attach/daemon').then(
  () => true,
  () => false,
);
if (!packAvailable) {
  console.warn('[attach.test] @framers/agentos-ext-browser-automation >=0.2.0 not resolvable — pack-dependent cases skipped');
}

const dirs: string[] = [];
const tdir = () => {
  const d = mkdtempSync(join(tmpdir(), 'attach-cmd-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function captureOutput() {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  return logs;
}

describe('wunderland attach (usage surface, packless)', () => {
  it('unknown subcommand prints usage and exits 2 without touching the pack', async () => {
    const logs = captureOutput();
    await cmdAttach(['bogus'], {} as never);
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('usage: wunderland attach');
  });
});

describe.skipIf(!packAvailable)('wunderland attach', () => {
  it('start refuses without DevToolsActivePort: prints relaunch instructions, exit 2, no daemon appears', async () => {
    const logs = captureOutput();
    const profileRoot = tdir(); // no DevToolsActivePort inside
    const ipcDir = tdir();
    await cmdAttach(['start', '--profile-root', profileRoot, '--identity', 'user@gmail.com', '--ipc-dir', ipcDir], {} as never);
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('--remote-debugging-port=9222');
    // Observable no-spawn proof: nothing ever wrote a daemon status into the ipc dir.
    expect(existsSync(join(ipcDir, 'status.json'))).toBe(false);
  });

  it('start refuses without an identity', async () => {
    const logs = captureOutput();
    await cmdAttach(['start', '--profile-root', tdir(), '--ipc-dir', tdir()], {} as never);
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('--identity');
  });

  it('run errors actionably when no daemon is up, and writes nothing into the queue', async () => {
    const logs = captureOutput();
    const ipcDir = tdir();
    const script = join(tdir(), 'plan.json');
    writeFileSync(script, JSON.stringify({ name: 'x', steps: [{ op: 'read', out: 'p' }] }));
    await cmdAttach(['run', script, '--ipc-dir', ipcDir], {} as never);
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('wunderland attach start');
    expect(readdirSync(ipcDir).filter((n) => n.startsWith('cmd-'))).toEqual([]);
  });

  it('run errors on a missing script file', async () => {
    const logs = captureOutput();
    await cmdAttach(['run', join(tdir(), 'missing.yaml'), '--ipc-dir', tdir()], {} as never);
    expect(process.exitCode).toBe(2);
    expect(logs.join('\n')).toContain('no script file');
  });

  it('status exits nonzero when the daemon is down (scriptable)', async () => {
    captureOutput();
    await cmdAttach(['status', '--ipc-dir', tdir()], {} as never);
    expect(process.exitCode).toBe(1);
  });
});
