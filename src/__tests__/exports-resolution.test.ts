import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '../..');
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

describe('package.json exports field', () => {
  const exports = PKG.exports as Record<string, { import?: string; types?: string }>;
  const subpaths = Object.keys(exports);

  it('declares at least one export', () => {
    expect(subpaths.length).toBeGreaterThan(0);
  });

  for (const subpath of subpaths) {
    if (subpath.includes('*')) continue;

    it(`subpath "${subpath}" points to an existing source file`, () => {
      const target = exports[subpath].import;
      expect(target, `subpath ${subpath} has no "import" field`).toBeTruthy();
      const targetAbs = path.resolve(PKG_ROOT, target!);
      const sourceCandidate = targetAbs
        .replace(/\/dist\//, '/src/')
        .replace(/\.js$/, '.ts');
      expect(
        fs.existsSync(targetAbs) || fs.existsSync(sourceCandidate),
        `Neither ${target} nor source equivalent ${path.relative(PKG_ROOT, sourceCandidate)} exists`,
      ).toBe(true);
    });
  }
});
