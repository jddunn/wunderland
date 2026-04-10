// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectPackageManager } from '../../src/cli/extensions/installer.js';
import { existsSync } from 'node:fs';

vi.mock('node:fs', () => ({ existsSync: vi.fn() }));

describe('detectPackageManager', () => {
  beforeEach(() => vi.mocked(existsSync).mockReturnValue(false));

  it('detects pnpm from pnpm-lock.yaml', () => {
    vi.mocked(existsSync).mockImplementation((p: any) =>
      String(p).includes('pnpm-lock.yaml'));
    expect(detectPackageManager('/tmp/test')).toBe('pnpm');
  });

  it('detects yarn from yarn.lock', () => {
    vi.mocked(existsSync).mockImplementation((p: any) =>
      String(p).includes('yarn.lock'));
    expect(detectPackageManager('/tmp/test')).toBe('yarn');
  });

  it('detects bun from bun.lockb', () => {
    vi.mocked(existsSync).mockImplementation((p: any) =>
      String(p).includes('bun.lockb'));
    expect(detectPackageManager('/tmp/test')).toBe('bun');
  });

  it('falls back to npm', () => {
    expect(detectPackageManager('/tmp/test')).toBe('npm');
  });
});
