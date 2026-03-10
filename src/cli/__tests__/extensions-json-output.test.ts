import { afterEach, describe, expect, it, vi } from 'vitest';
import cmdExtensions from '../commands/extensions.js';

describe('extensions json output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints machine-readable JSON without a section header', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cmdExtensions([], { format: 'json' }, {} as any);

    const output = log.mock.calls.flat().join('\n').trim();
    expect(output.startsWith('{')).toBe(true);
    expect(() => JSON.parse(output)).not.toThrow();
  });
});
