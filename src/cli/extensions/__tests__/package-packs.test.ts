import { describe, expect, it } from 'vitest';
import { PACKAGE_PACKS, packagePackEntries, packagePackFor, takePackagePacks } from '../package-packs.js';

describe('bundled package packs', () => {
  it('treats the withdrawn film pack like any unknown pack', () => {
    const name = 'wildweave-film';
    const packageName = '@framers/agentos-ext-wildweave-film';

    expect(Object.keys(PACKAGE_PACKS)).not.toContain(name);
    expect(Object.values(PACKAGE_PACKS).map((pack) => pack.package)).not.toContain(packageName);
    for (const ref of [name, packageName, 'unknown-pack']) {
      expect(packagePackFor(ref)).toBeUndefined();
      expect(packagePackEntries([ref])).toEqual([]);
      expect(takePackagePacks(['web-search', ref, 'giphy'])).toEqual({
        packagePacks: [],
        rest: ['web-search', ref, 'giphy'],
      });
    }
  });
});
