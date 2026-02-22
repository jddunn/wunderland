#!/usr/bin/env npx tsx
/**
 * Generate PNG screenshots for all non-interactive CLI commands.
 * Uses the existing --export-png pipeline (OutputCapture → ansi-to-html → Playwright).
 *
 * Usage:
 *   cd packages/wunderland
 *   npx tsx scripts/generate-screenshots.ts
 *
 * Prerequisites:
 *   - Build the CLI first: npx tsc --outDir dist --skipLibCheck
 *   - Install Chromium for Playwright: npx playwright install chromium
 */

import { execSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCREENSHOT_DIR = join(ROOT, 'screenshots');
const BIN = join(ROOT, 'bin', 'wunderland.js');

// Ensure screenshots directory exists
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Commands to screenshot (non-interactive, deterministic output)
const COMMANDS = [
  { cmd: '--help',       file: 'help.png' },
  { cmd: 'version',      file: 'version.png' },
  { cmd: 'doctor',       file: 'doctor.png' },
  { cmd: 'status',       file: 'status.png' },
  { cmd: 'list-presets',  file: 'list-presets.png' },
  { cmd: 'models',       file: 'models.png' },
  { cmd: 'skills list',  file: 'skills.png' },
  { cmd: 'plugins',      file: 'plugins.png' },
];

console.log(`\n  Generating ${COMMANDS.length} screenshots → ${SCREENSHOT_DIR}\n`);

let passed = 0;
let failed = 0;

for (const { cmd, file } of COMMANDS) {
  const outPath = join(SCREENSHOT_DIR, file);
  const display = `wunderland ${cmd}`;
  process.stdout.write(`  ${display.padEnd(30)}`);

  try {
    execSync(
      `node "${BIN}" ${cmd} --export-png "${outPath}"`,
      { cwd: ROOT, stdio: 'pipe', timeout: 30_000 },
    );

    if (existsSync(outPath)) {
      console.log(`✓ ${file}`);
      passed++;
    } else {
      console.log(`✗ ${file} (file not created)`);
      failed++;
    }
  } catch (err: any) {
    const msg = err.stderr ? err.stderr.toString().trim().split('\n')[0] : 'unknown error';
    console.log(`✗ ${file} — ${msg}`);
    failed++;
  }
}

console.log(`\n  Done: ${passed} generated, ${failed} failed\n`);
process.exitCode = failed > 0 ? 1 : 0;
