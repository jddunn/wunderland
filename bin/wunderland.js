#!/usr/bin/env node
/**
 * Wunderland CLI — thin bootstrap.
 *
 * All logic lives in TypeScript at src/cli/, compiled to dist/cli/.
 * This file only resolves the compiled entry and hands off to it.
 * Keeping this in plain JS avoids coupling CLI availability to build health.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(__dirname, '..', 'dist', 'cli', 'index.js');

try {
  const { main } = await import(cliEntry);
  await main(process.argv.slice(2));
} catch (err) {
  // If the compiled CLI isn't available, show a helpful message.
  if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
    console.error(
      '[wunderland] CLI not built. Run: cd packages/wunderland && pnpm build'
    );
    process.exitCode = 1;
  } else {
    console.error(`[wunderland] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
