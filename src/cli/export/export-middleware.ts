/**
 * @fileoverview Export middleware — wraps any command to capture output as PNG.
 * Usage: wunderland <command> --export-png <path>
 * @module wunderland/cli/export/export-middleware
 */

import * as path from 'node:path';
import type { GlobalFlags, CommandHandler } from '../types.js';
import { OutputCapture } from '../ui/output-capture.js';
import { ansiToHtml } from './ansi-to-html.js';
import { renderPng } from './png-renderer.js';
import { success as sColor, error as eColor, dim } from '../ui/theme.js';

/**
 * Wraps a command handler to capture its output and export as PNG.
 *
 * Steps:
 * 1. Start OutputCapture
 * 2. Run the command handler normally (output appears in terminal)
 * 3. Stop capture and get ANSI string
 * 4. Convert ANSI → HTML
 * 5. Render HTML → PNG via Playwright
 * 6. Print confirmation
 */
export async function withExport(
  handler: CommandHandler,
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const exportPath = typeof flags['export-png'] === 'string'
    ? flags['export-png']
    : 'output.png';

  const resolved = path.resolve(exportPath);

  // Capture output
  const capture = new OutputCapture();
  capture.start();

  try {
    await handler(args, flags, globals);
  } finally {
    // Always stop capture even if command throws
    var ansiOutput = capture.stop();
  }

  if (!ansiOutput || ansiOutput.trim().length === 0) {
    console.log(`  ${eColor('\u2717')} No output to export`);
    return;
  }

  // Convert and render
  try {
    const html = ansiToHtml(ansiOutput, {
      watermark: true,
    });
    await renderPng(html, resolved);
    console.log();
    console.log(`  ${sColor('\u2713')} Exported to ${dim(resolved)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log();
    console.log(`  ${eColor('\u2717')} PNG export failed: ${dim(msg)}`);
    process.exitCode = 1;
  }
}
