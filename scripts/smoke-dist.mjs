#!/usr/bin/env node

/**
 * Dist smoke test: imports the built package the way Node does at run time.
 *
 * `tsc` cannot follow the dynamic `import()` strings the CLI uses, and vitest
 * does not enforce ES module named exports, so a build can pass both and still
 * ship a command that fails to load (0.84.0 shipped `wunderland chat` broken
 * this way). This script imports, under plain Node:
 *
 *   1. every entry of the package `exports` map,
 *      and the names `scripts/public-names.json` requires from its subpaths,
 *   2. every loader in the CLI `COMMANDS` table,
 *   3. the entry point of every `@framers/agentos-ext-*` dependency.
 *
 * Usage:
 *   node scripts/smoke-dist.mjs                 # the package this script is in
 *   node scripts/smoke-dist.mjs --root <dir>    # an installed copy of the package
 *
 * Exits 0 when everything loads, 1 otherwise. No network, no API keys.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const root = path.resolve(
  rootFlag >= 0 && args[rootFlag + 1]
    ? args[rootFlag + 1]
    : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** @type {string[]} */
const failures = [];
let checked = 0;

/** Runs one check and records a one-line failure instead of throwing. */
async function check(label, run) {
  checked += 1;
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label}: ${message.split('\n')[0]}`);
  }
}

const importFile = (file) => import(pathToFileURL(file).href);

/** Finds an installed package by walking up from the package root, as Node does. */
function findPackageDir(name) {
  let dir = root;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolves the ES module entry file of an installed package. */
function entryFile(packageDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const dot = manifest.exports?.['.'] ?? manifest.exports;
  const fromExports =
    typeof dot === 'string' ? dot : (dot?.import ?? dot?.default ?? dot?.require);
  const target = typeof fromExports === 'string' ? fromExports : (manifest.main ?? 'index.js');
  return path.join(packageDir, target);
}

// 1. Package exports.
const exportsMap = pkg.exports ?? { '.': pkg.main ?? 'index.js' };
for (const [subpath, target] of Object.entries(exportsMap)) {
  if (subpath === './package.json') continue;
  const file = typeof target === 'string' ? target : (target.import ?? target.default);
  if (typeof file !== 'string') continue;
  await check(`export ${subpath}`, () => importFile(path.join(root, file)));
}

// 1b. Names other packages import from the public subpaths. Dropping one in a
// refactor breaks hosts such as RabbitHole at run time while the build stays green.
const contractFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public-names.json');
const contract = fs.existsSync(contractFile)
  ? JSON.parse(fs.readFileSync(contractFile, 'utf8'))
  : null;
if (contract && contract.package === pkg.name) {
  for (const [subpath, names] of Object.entries(contract.subpaths)) {
    await check(`export ${subpath} names`, async () => {
      const target = exportsMap[subpath];
      if (!target) throw new Error('is not in the exports map');
      const file = typeof target === 'string' ? target : (target.import ?? target.default);
      const mod = await importFile(path.join(root, file));
      const missing = names.filter((name) => !(name in mod));
      if (missing.length > 0) throw new Error(`does not export ${missing.join(', ')}`);
    });
  }
}

// 2. CLI command loaders.
let commands = {};
await check('dist/cli/index.js', async () => {
  const cli = await importFile(path.join(root, 'dist', 'cli', 'index.js'));
  if (!cli.COMMANDS || typeof cli.COMMANDS !== 'object') {
    throw new Error('does not export the COMMANDS table');
  }
  commands = cli.COMMANDS;
});
for (const [name, loader] of Object.entries(commands)) {
  await check(`command ${name}`, async () => {
    const mod = await loader();
    if (!mod || typeof mod.default !== 'function') {
      throw new Error('loaded but has no callable default export');
    }
  });
}

// 3. Extension pack dependencies.
const packs = Object.keys(pkg.dependencies ?? {}).filter((name) =>
  name.startsWith('@framers/agentos-ext-'),
);
for (const name of packs) {
  await check(`dependency ${name}`, async () => {
    const dir = findPackageDir(name);
    if (!dir) throw new Error('is not installed');
    await importFile(entryFile(dir));
  });
}

if (failures.length > 0) {
  console.error(`smoke-dist: ${failures.length} of ${checked} checks failed in ${root}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`smoke-dist: ${checked} checks passed in ${root}`);
// Command modules may leave handles open; the result is already decided.
process.exit(0);
