// @ts-nocheck
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

import base from './vitest.config';

/**
 * Integration lane: `*.integration.test.ts` files, run as their own blocking
 * step in CI and before a publish. The default config excludes these files, so
 * this one sets `include` and `exclude` itself and reuses only the resolver and
 * dependency settings.
 */
const quarantined: string[] = JSON.parse(
  readFileSync(resolve(__dirname, 'vitest.integration.quarantine.json'), 'utf8'),
).map((entry: { file: string }) => entry.file);

export default defineConfig({
  resolve: base.resolve,
  test: {
    include: ['src/**/*.integration.test.ts'],
    exclude: ['node_modules/**', ...quarantined],
    passWithNoTests: true,
    server: base.test.server,
  },
});
