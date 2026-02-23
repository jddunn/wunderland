import { describe, expect, it } from 'vitest';

import * as root from '../../index.js';
import * as advanced from '../../advanced/index.js';
import * as security from '../../advanced/security.js';

describe('wunderland package exports', () => {
  it('exposes a small library-first root API', () => {
    expect(typeof root.createWunderland).toBe('function');
    expect(root.WunderlandConfigError).toBeDefined();
    expect(typeof root.VERSION).toBe('string');
    expect(typeof root.PACKAGE_NAME).toBe('string');

    // Keep legacy/low-level surface off the root import.
    expect((root as any).createWunderlandSeed).toBeUndefined();
  });

  it('exposes the legacy surface under wunderland/advanced', () => {
    expect(typeof (advanced as any).createWunderlandSeed).toBe('function');
    expect((advanced as any).HEXACO_PRESETS).toBeDefined();
  });

  it('exposes key security helpers under wunderland/advanced/security', () => {
    expect(typeof security.createDefaultFolderConfig).toBe('function');
    expect(typeof security.checkFolderAccess).toBe('function');
    expect(security.AuditLogger).toBeDefined();
  });
});

