#!/usr/bin/env node
/**
 * rewrite-imports.mjs — rewrites relative TS/JS imports across the monorepo
 * after a batch of file moves.
 *
 * Usage: node packages/wunderland/scripts/rewrite-imports.mjs <mapping.json>
 *
 * Mapping JSON format:
 *   [
 *     ["packages/wunderland/src/old/path.ts", "packages/wunderland/src/new/path.ts"],
 *     ...
 *   ]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

const mappingFile = process.argv[2];
if (!mappingFile) {
  console.error('Usage: node rewrite-imports.mjs <mapping.json>');
  process.exit(1);
}

const mappingArr = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
const mapping = new Map(
  mappingArr.map(([oldPath, newPath]) => [
    path.resolve(REPO_ROOT, oldPath),
    path.resolve(REPO_ROOT, newPath),
  ]),
);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', '.turbo', 'build']);

function findSourceFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findSourceFiles(full));
    } else if (/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function tryResolve(importerDir, importPath) {
  const candidates = [
    path.resolve(importerDir, importPath),
    path.resolve(importerDir, importPath.replace(/\.js$/, '.ts')),
    path.resolve(importerDir, importPath.replace(/\.js$/, '.tsx')),
    path.resolve(importerDir, importPath + '.ts'),
    path.resolve(importerDir, importPath + '.tsx'),
    path.resolve(importerDir, importPath, 'index.ts'),
    path.resolve(importerDir, importPath, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (mapping.has(c)) return c;
  }
  return null;
}

function rewriteFile(file) {
  const content = fs.readFileSync(file, 'utf8');
  const fileDir = path.dirname(file);
  let modified = content;
  let changed = false;

  modified = modified.replace(
    /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,
    (full, prefix, importPath, suffix) => {
      const matchedOldAbs = tryResolve(fileDir, importPath);
      if (!matchedOldAbs) return full;
      const newAbs = mapping.get(matchedOldAbs);
      let newRel = path.relative(fileDir, newAbs);
      if (!newRel.startsWith('.')) newRel = './' + newRel;
      if (importPath.endsWith('.js')) {
        newRel = newRel.replace(/\.tsx?$/, '.js');
      } else {
        newRel = newRel.replace(/\.tsx?$/, '');
      }
      changed = true;
      return prefix + newRel + suffix;
    },
  );

  if (changed) {
    fs.writeFileSync(file, modified);
    return true;
  }
  return false;
}

const files = findSourceFiles(REPO_ROOT);
let updated = 0;
for (const file of files) {
  if (rewriteFile(file)) updated++;
}
console.log(`Rewrote imports in ${updated} files (scanned ${files.length})`);
