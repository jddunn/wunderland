import { describe, it, expect } from 'vitest';
import { COMMANDS } from '../index.js';

/**
 * Every CLI command is loaded through a dynamic import string in COMMANDS.
 * tsc cannot resolve those strings, so a clean build has shipped runtime-broken
 * paths before (the v0.72.3 src reorg broke 32 of them silently). This test
 * import()s every loader so a bad path is a red CI run, not a runtime failure.
 */
describe('CLI command loaders', () => {
  it('every dynamic import in COMMANDS resolves to a module with a default export', async () => {
    const failures: string[] = [];
    for (const [name, loader] of Object.entries(COMMANDS)) {
      try {
        const mod = await loader();
        if (!mod || typeof mod.default !== 'function') {
          failures.push(`${name}: loaded but has no callable default export`);
        }
      } catch (err) {
        failures.push(`${name}: ${(err as Error).message}`);
      }
    }
    expect(failures, `broken command loaders:\n${failures.join('\n')}`).toEqual([]);
  }, 120_000);
});
