import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import { FileTokenStore } from '@framers/agentos/auth';
import type { OAuthTokenSet } from '@framers/agentos/auth';

describe('FileTokenStore', () => {
  let tmpDir: string;
  let store: FileTokenStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wunderland-auth-test-'));
    store = new FileTokenStore(tmpDir);
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  const sampleTokens: OAuthTokenSet = {
    accessToken: 'test-access-token-abc123',
    refreshToken: 'test-refresh-token-xyz789',
    expiresAt: Date.now() + 3600_000,
  };

  it('returns null when no tokens are stored', async () => {
    const result = await store.load('openai');
    expect(result).toBeNull();
  });

  it('saves and loads tokens correctly', async () => {
    await store.save('openai', sampleTokens);
    const loaded = await store.load('openai');

    expect(loaded).not.toBeNull();
    expect(loaded!.accessToken).toBe(sampleTokens.accessToken);
    expect(loaded!.refreshToken).toBe(sampleTokens.refreshToken);
    expect(loaded!.expiresAt).toBe(sampleTokens.expiresAt);
  });

  it('creates the directory if it does not exist', async () => {
    const nestedDir = join(tmpDir, 'nested', 'auth');
    const nestedStore = new FileTokenStore(nestedDir);

    await nestedStore.save('openai', sampleTokens);

    expect(existsSync(nestedDir)).toBe(true);
    expect(existsSync(join(nestedDir, 'openai.json'))).toBe(true);
  });

  it('clears tokens by deleting the file', async () => {
    await store.save('openai', sampleTokens);
    expect(existsSync(join(tmpDir, 'openai.json'))).toBe(true);

    await store.clear('openai');
    expect(existsSync(join(tmpDir, 'openai.json'))).toBe(false);
  });

  it('clear() does not throw when no tokens exist', async () => {
    await expect(store.clear('openai')).resolves.not.toThrow();
  });

  it('stores tokens as valid JSON', async () => {
    await store.save('openai', sampleTokens);
    const raw = readFileSync(join(tmpDir, 'openai.json'), 'utf8');
    const parsed = JSON.parse(raw);

    expect(parsed.accessToken).toBe(sampleTokens.accessToken);
    expect(parsed.refreshToken).toBe(sampleTokens.refreshToken);
    expect(parsed.expiresAt).toBe(sampleTokens.expiresAt);
  });

  it('handles tokens without refreshToken', async () => {
    const noRefresh: OAuthTokenSet = {
      accessToken: 'access-only',
      expiresAt: Date.now() + 3600_000,
    };

    await store.save('openai', noRefresh);
    const loaded = await store.load('openai');

    expect(loaded).not.toBeNull();
    expect(loaded!.accessToken).toBe('access-only');
    expect(loaded!.refreshToken).toBeUndefined();
  });

  it('isolates tokens by provider ID', async () => {
    const openaiTokens: OAuthTokenSet = { accessToken: 'openai-token', expiresAt: Date.now() + 3600_000 };
    const otherTokens: OAuthTokenSet = { accessToken: 'other-token', expiresAt: Date.now() + 3600_000 };

    await store.save('openai', openaiTokens);
    await store.save('other-provider', otherTokens);

    const loadedOpenai = await store.load('openai');
    const loadedOther = await store.load('other-provider');

    expect(loadedOpenai!.accessToken).toBe('openai-token');
    expect(loadedOther!.accessToken).toBe('other-token');
  });

  it('sanitizes provider ID to prevent path traversal', async () => {
    await store.save('../../../etc/passwd', sampleTokens);
    // Should create a safely-named file, not traverse paths
    expect(existsSync(join(tmpDir, '_________etc_passwd.json'))).toBe(true);
    expect(existsSync('/etc/passwd.json')).toBe(false);
  });

  it('returns null for corrupted JSON', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(tmpDir, 'openai.json'), 'not valid json!!!', 'utf8');

    const loaded = await store.load('openai');
    expect(loaded).toBeNull();
  });

  it('returns null for JSON missing required fields', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(tmpDir, 'openai.json'), JSON.stringify({ foo: 'bar' }), 'utf8');

    const loaded = await store.load('openai');
    expect(loaded).toBeNull();
  });

  it('sets file permissions to 0o600 on Unix', async () => {
    await store.save('openai', sampleTokens);
    const filePath = join(tmpDir, 'openai.json');
    const stats = statSync(filePath);
    // 0o600 = 384 in decimal, mode includes file type bits so mask with 0o777
    const perms = stats.mode & 0o777;
    expect(perms).toBe(0o600);
  });
});
