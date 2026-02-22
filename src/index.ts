/**
 * @fileoverview Wunderland (library-first entrypoint).
 *
 * This package intentionally exposes a small, ergonomic API from the root
 * import (`wunderland`). Advanced modules remain available under
 * `wunderland/advanced/*`, and the HTTP/server helpers live under
 * `wunderland/api`.
 *
 * @module wunderland
 */

export * from './public/index.js';

// Version info (read from package.json at runtime)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };
export const VERSION = pkg.version;
export const PACKAGE_NAME = pkg.name;

