import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '../..');

function extractNamedExports(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const names = new Set<string>();
  for (const m of content.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const name of m[1].split(',')) {
      const cleaned = name
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (cleaned) names.add(cleaned);
    }
  }
  for (const m of content.matchAll(
    /export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_]\w*)/g,
  )) {
    names.add(m[1]);
  }
  return [...names].sort();
}

describe('packages/wunderland/src/public/index.ts named-export surface', () => {
  it('matches the Phase 1 baseline snapshot', () => {
    const baseline = JSON.parse(
      fs.readFileSync(path.join(PKG_ROOT, 'src/__tests__/__snapshots__/public-exports.snap'), 'utf8'),
    );
    const current = extractNamedExports(path.join(PKG_ROOT, 'src/public/index.ts'));
    expect(current).toEqual(baseline);
  });
});
