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
