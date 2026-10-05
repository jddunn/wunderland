import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/smoke-dist.mjs', import.meta.url));

/** Writes a file, creating its directories. */
function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * Builds a minimal package tree shaped like the published one: an `exports`
 * entry, a CLI `COMMANDS` table and one command module.
 */
function fixture(commandSource: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-dist-'));
  write(
    root,
    'package.json',
    JSON.stringify({
      name: 'smoke-fixture',
      type: 'module',
      exports: { '.': { import: './dist/index.js' } },
      dependencies: {},
    }),
  );
  write(root, 'dist/index.js', 'export const ok = true;\n');
  write(root, 'dist/barrel.js', 'export const present = 1;\n');
  write(
    root,
    'dist/cli/index.js',
    "export const COMMANDS = { chat: () => import('./commands/chat.js') };\n",
  );
  write(root, 'dist/cli/commands/chat.js', commandSource);
  return root;
}

function runSmoke(root: string) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}

describe('scripts/smoke-dist.mjs', () => {
  it('passes when every export and command loads', () => {
    const root = fixture(
      "import { present } from '../../barrel.js';\nexport default async function chat() { return present; }\n",
    );
    const result = runSmoke(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('checks passed');
  });

  it('fails when a command imports a name its barrel does not export', () => {
    // The 0.84.0 defect: chat imported `injectMemoryContext` from a barrel that
    // had stopped exporting it. Node rejects this at link time; vitest does not.
    const root = fixture(
      "import { missing } from '../../barrel.js';\nexport default async function chat() { return missing; }\n",
    );
    const result = runSmoke(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('command chat');
    expect(result.stderr).toContain('missing');
  });

  it('fails when a command module has no default export', () => {
    const root = fixture('export const notDefault = true;\n');
    const result = runSmoke(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no callable default export');
  });

  it('fails when a public subpath loses a name other packages import', () => {
    const root = fixture('export default async function chat() {}\n');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    manifest.name = 'wunderland';
    manifest.exports['./core'] = { import: './dist/types/core-types.js' };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    write(root, 'dist/types/core-types.js', 'export const DEFAULT_SECURITY_PROFILE = {};\n');
    const result = runSmoke(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'export ./core names: does not export DEFAULT_INFERENCE_HIERARCHY',
    );
    expect(result.stderr).toContain('export ./seed names: is not in the exports map');
  });

  it('fails when an extension pack dependency is not installed', () => {
    const root = fixture('export default async function chat() {}\n');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    manifest.dependencies = { '@framers/agentos-ext-absent': '^1.0.0' };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    const result = runSmoke(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dependency @framers/agentos-ext-absent: is not installed');
  });
});
