import { describe, expect, it } from 'vitest';
import { PACKAGE_PACKS, packagePackEntries, packagePackFor, takePackagePacks } from '../package-packs.js';

describe('takePackagePacks', () => {
  it('takes the packs start imports by package out of a list, keeping the order of both', () => {
    expect(takePackagePacks(['web-search', 'wildweave-film', 'giphy'])).toEqual({
      packagePacks: ['wildweave-film'],
      rest: ['web-search', 'giphy'],
    });
    expect(takePackagePacks([])).toEqual({ packagePacks: [], rest: [] });
  });
});

describe('packagePackEntries', () => {
  it("gives the pack wunderland's options: the studio on wilds.ai and the MCP endpoint at /mcp/wildweave-film", () => {
    expect(packagePackEntries(['wildweave-film'])).toEqual([
      {
        name: 'wildweave-film',
        package: '@framers/agentos-ext-wildweave-film',
        options: { baseUrl: 'https://wilds.ai', http: { path: '/mcp/wildweave-film' } },
      },
    ]);
  });

  it("lays the agent's override options over wunderland's, key by key, and passes its priority as options.priority", () => {
    const [entry] = packagePackEntries(['wildweave-film'], {
      'wildweave-film': { priority: 40, options: { baseUrl: 'https://studio.example.test', engineDir: '/srv/wilds-ai' } },
    });
    // The loader hands the pack its options alone, and the pack reads options.priority.
    expect(entry).toEqual({
      name: 'wildweave-film',
      package: '@framers/agentos-ext-wildweave-film',
      options: { baseUrl: 'https://studio.example.test', engineDir: '/srv/wilds-ai', http: { path: '/mcp/wildweave-film' }, priority: 40 },
    });
    // The defaults stay as they were for the next agent.
    expect(PACKAGE_PACKS['wildweave-film']!.options).toEqual({ baseUrl: 'https://wilds.ai', http: { path: '/mcp/wildweave-film' } });
  });

  it("takes the override's priority over a priority in its options, and leaves an options priority alone otherwise", () => {
    expect(packagePackEntries(['wildweave-film'], { 'wildweave-film': { priority: 5, options: { priority: 9 } } })[0]!.options['priority']).toBe(5);
    expect(packagePackEntries(['wildweave-film'], { 'wildweave-film': { options: { priority: 9 } } })[0]!.options['priority']).toBe(9);
    expect(packagePackEntries(['wildweave-film'], { 'wildweave-film': { priority: '5' } })[0]!.options).not.toHaveProperty('priority');
  });

  it('leaves out a pack its override disables, lists a pack once, and skips names it does not hold', () => {
    expect(packagePackEntries(['wildweave-film'], { 'wildweave-film': { enabled: false } })).toEqual([]);
    expect(packagePackEntries(['wildweave-film', 'wildweave-film', 'web-search']).map((e) => e.name)).toEqual(['wildweave-film']);
  });
});

describe('packagePackFor', () => {
  it('finds a pack by the name a config gives it or by its npm package, and nothing else', () => {
    expect(packagePackFor('wildweave-film')).toEqual({ name: 'wildweave-film', package: '@framers/agentos-ext-wildweave-film' });
    expect(packagePackFor('@framers/agentos-ext-wildweave-film')).toEqual({ name: 'wildweave-film', package: '@framers/agentos-ext-wildweave-film' });
    expect(packagePackFor('web-search')).toBeUndefined();
    expect(packagePackFor('@framers/agentos-ext-web-search')).toBeUndefined();
    expect(packagePackFor('')).toBeUndefined();
  });
});
