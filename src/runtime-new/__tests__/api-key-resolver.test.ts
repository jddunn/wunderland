// @ts-nocheck
import { describe, expect, it } from 'vitest';

import { resolveApiKeyInput } from '../../runtime-new/identity/api-key-resolver.js';

describe('resolveApiKeyInput', () => {
  it('resolves plain string keys', async () => {
    await expect(resolveApiKeyInput('sk-test', { source: 'unit' })).resolves.toBe('sk-test');
  });

  it('resolves promise keys', async () => {
    await expect(resolveApiKeyInput(Promise.resolve('sk-promise'), { source: 'unit' })).resolves.toBe('sk-promise');
  });

  it('resolves function-based keys', async () => {
    await expect(resolveApiKeyInput(() => Promise.resolve('sk-fn'), { source: 'unit' })).resolves.toBe('sk-fn');
  });

  it('throws for non-string resolved values', async () => {
    await expect(resolveApiKeyInput({} as any, { source: 'unit' })).rejects.toThrow(/expected API key string/i);
  });

  it('throws for empty keys', async () => {
    await expect(resolveApiKeyInput('   ', { source: 'unit' })).rejects.toThrow(/missing or empty/i);
  });
});
