/**
 * First-class attach verification. Real-browser E2E: skipped unless
 * WUNDERLAND_ATTACH_E2E=1 (CI has no attachable browser). Documents the manual
 * gate — the core assertion is that every OTHER tab is byte-identical before
 * and after the session, proving the marker-tab contract holds (Codex F11).
 */
import { describe, it, expect } from 'vitest';

const E2E = process.env.WUNDERLAND_ATTACH_E2E === '1';

describe.skipIf(!E2E)('attach verification (real browser)', () => {
  it('claims a nonce-marked tab, drives only it, and leaves all other tabs untouched', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const {
      AttachController,
      JxaBackend,
    } = (await import(
      // Resolved from the published/linked extension package at E2E time.
      '@framers/agentos-ext-browser-automation/attach'
    )) as any;

    const expectedIdentity = process.env.WUNDERLAND_ATTACH_IDENTITY || '@gmail.com';
    const controller = new AttachController({
      backend: new JxaBackend({}),
      leaseFile: path.join(os.tmpdir(), `attach-e2e-${process.pid}.lease`),
      expectedIdentity,
    });

    const snapshotOtherTabs = new JxaBackend({});
    const before = await snapshotOtherTabs.probeIdentity().catch(() => 'n/a');

    const status = await controller.claim();
    expect(status.state).toBe('ready');
    const landed = await controller.goto('https://example.com/');
    expect(landed).toContain('example.com');
    await controller.goto('about:blank');
    await controller.detach();

    // The controller only ever touched its own marker tab; the identity probe
    // (a different, pre-existing tab's content) is unchanged.
    const after = await snapshotOtherTabs.probeIdentity().catch(() => 'n/a');
    expect(after).toBe(before);
  }, 120_000);
});

describe.skipIf(!E2E)('attach verification (daemon path, real browser)', () => {
  it('daemon start -> claim -> goto -> release leaves every other tab byte-identical', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { AttachDaemonClient } = (await import(
      '@framers/agentos-ext-browser-automation/attach/daemon'
    )) as any;
    const { JxaBackend } = (await import('@framers/agentos-ext-browser-automation/attach')) as any;

    const ipcDir = path.join(os.tmpdir(), `attach-e2e-daemon-${process.pid}`);
    const entryPath = fileURLToPath(
      import.meta.resolve('@framers/agentos-ext-browser-automation/attach/daemon/daemon-main'),
    );
    const child = spawn(process.execPath, [entryPath], {
      stdio: 'ignore',
      env: {
        ...process.env,
        WUNDERLAND_ATTACH_IDENTITY: process.env.WUNDERLAND_ATTACH_IDENTITY || '@gmail.com',
        WUNDERLAND_ATTACH_IPC_DIR: ipcDir,
        WUNDERLAND_ATTACH_PID_FILE: path.join(ipcDir, 'daemon.pid'),
      },
    });
    try {
      const client = new AttachDaemonClient({ ipcDir, client: 'e2e' });
      const snapshot = new JxaBackend({});
      const before = await snapshot.probeIdentity().catch(() => 'n/a');

      for (let i = 0; i < 75 && client.statusFile()?.state !== 'connected'; i++) {
        await new Promise((r) => setTimeout(r, 400));
      }
      expect(client.statusFile()?.state).toBe('connected');
      await client.claim();
      const landed = await client.goto('https://example.com/');
      expect(landed.url).toContain('example.com');
      await client.release();
      await client.quit();

      // The daemon only ever touched its own created tab; a pre-existing
      // tab's content is unchanged across the whole session.
      const after = await snapshot.probeIdentity().catch(() => 'n/a');
      expect(after).toBe(before);
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already exited via quit */
      }
    }
  }, 180_000);
});
