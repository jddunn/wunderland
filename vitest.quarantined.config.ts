// @ts-nocheck
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

import base from './vitest.config';

/**
 * Report-only lane: runs exactly the quarantined files, unit and integration,
 * so their current state is visible on every CI run. The blocking lanes
 * exclude these files; this lane never blocks.
 */
function quarantinedFiles(list: string): string[] {
  return JSON.parse(readFileSync(resolve(__dirname, list), 'utf8')).map(
    (entry: { file: string }) => entry.file,
  );
}

export default defineConfig({
  resolve: base.resolve,
  test: {
    include: [
      ...quarantinedFiles('vitest.quarantine.json'),
      ...quarantinedFiles('vitest.integration.quarantine.json'),
    ],
    exclude: ['node_modules/**'],
    passWithNoTests: true,
    server: base.test.server,
  },
});
