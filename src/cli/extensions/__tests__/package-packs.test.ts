import { describe, expect, it } from 'vitest';
import { PACKAGE_PACKS, packagePackEntries, takePackagePacks } from '../package-packs.js';

describe('takePackagePacks', () => {
  it('takes the packs start imports by package out of a list, keeping the order of both', () => {
    expect(takePackagePacks(['web-search', 'wildweave-film', 'giphy'])).toEqual({
      packagePacks: ['wildweave-film'],
      rest: ['web-search', 'giphy'],
    });
    expect(takePackagePacks([])).toEqual({ packagePacks: [], rest: [] });
  });
});

/** The endpoint's bearer token: 64 hex characters, as `openssl rand -hex 32` writes one. Synthetic. */
const TOKEN = 'c3'.repeat(32);

/** A secret reader holding `secrets`, recording the ids it is asked for. */
function secretsOf(secrets: Record<string, string>) {
  const asked: string[] = [];
  const read = (id: string): string | undefined => {
    asked.push(id);
    return secrets[id];
  };
  return { read, asked };
}

describe('packagePackEntries', () => {
  it("gives the pack wunderland's options: the studio on wilds.ai and the MCP endpoint at /mcp/wildweave-film, its token from wildweave.studio.http_token", () => {
    const secrets = secretsOf({ 'wildweave.studio.http_token': TOKEN });
    expect(packagePackEntries(['wildweave-film'], {}, secrets.read)).toEqual([
      {
        name: 'wildweave-film',
        package: '@framers/agentos-ext-wildweave-film',
        options: { baseUrl: 'https://wilds.ai', http: { path: '/mcp/wildweave-film', token: TOKEN } },
      },
    ]);
    expect(secrets.asked).toEqual(['wildweave.studio.http_token']);
  });

  it('leaves the endpoint off, keeping the pack, with a note naming the secret and its variable, when no token is stored', () => {
    // The pack refuses to load with http and no token; http: null loads its tools without the endpoint.
    for (const read of [undefined, secretsOf({}).read, secretsOf({ 'wildweave.studio.http_token': '   ' }).read]) {
      const [entry] = packagePackEntries(['wildweave-film'], {}, read);
      expect(entry!.options).toEqual({ baseUrl: 'https://wilds.ai', http: null });
      expect(entry!.note).toContain('wildweave.studio.http_token');
      expect(entry!.note).toContain('WILDWEAVE_STUDIO_HTTP_TOKEN');
      expect(entry!.note).not.toContain(TOKEN);
    }
  });

  it("lays the agent's override options over wunderland's, key by key, and keeps its priority", () => {
    const [entry] = packagePackEntries(
      ['wildweave-film'],
      { 'wildweave-film': { priority: 40, options: { baseUrl: 'https://studio.example.test', engineDir: '/srv/wilds-ai' } } },
      secretsOf({ 'wildweave.studio.http_token': TOKEN }).read,
    );
    expect(entry).toEqual({
      name: 'wildweave-film',
      package: '@framers/agentos-ext-wildweave-film',
      priority: 40,
      options: { baseUrl: 'https://studio.example.test', engineDir: '/srv/wilds-ai', http: { path: '/mcp/wildweave-film', token: TOKEN } },
    });
    // The defaults stay as they were for the next agent, with no token in them.
    expect(PACKAGE_PACKS['wildweave-film']!.options).toEqual({ baseUrl: 'https://wilds.ai', http: { path: '/mcp/wildweave-film' } });
  });

  it("keeps a token the override gives without reading the secret, and an override's http: null without a note", () => {
    const given = 'd4'.repeat(32);
    const secrets = secretsOf({ 'wildweave.studio.http_token': TOKEN });
    const [withToken] = packagePackEntries(['wildweave-film'], { 'wildweave-film': { options: { http: { path: '/mcp/studio', token: given } } } }, secrets.read);
    expect(withToken!.options['http']).toEqual({ path: '/mcp/studio', token: given });
    expect(secrets.asked).toEqual([]);

    const [off] = packagePackEntries(['wildweave-film'], { 'wildweave-film': { options: { http: null } } }, secrets.read);
    expect(off!.options['http']).toBeNull();
    expect(off!.note).toBeUndefined();
  });

  it('leaves out a pack its override disables, lists a pack once, and skips names it does not hold', () => {
    expect(packagePackEntries(['wildweave-film'], { 'wildweave-film': { enabled: false } })).toEqual([]);
    expect(packagePackEntries(['wildweave-film', 'wildweave-film', 'web-search']).map((e) => e.name)).toEqual(['wildweave-film']);
  });
});
