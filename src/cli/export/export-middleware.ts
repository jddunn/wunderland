/**
 * @fileoverview Export middleware — wraps any command to capture output as PNG.
 * Usage: wunderland <command> --export-png <path>
 * @module wunderland/cli/export/export-middleware
 */

import chalk from 'chalk';
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
 * 1. Force chalk colors so ANSI codes are emitted even in non-TTY
 * 2. Start OutputCapture
 * 3. Run the command handler normally (output appears in terminal)
 * 4. Stop capture and get ANSI string
 * 5. Convert ANSI → HTML with a terminal-style command header
 * 6. Render HTML → PNG via Playwright
 * 7. Print confirmation
 */
export async function withExport(
  handler: CommandHandler,
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
  commandName?: string,
): Promise<void> {
  const exportPath = typeof flags['export-png'] === 'string'
    ? flags['export-png']
    : 'output.png';

  const resolved = path.resolve(exportPath);

  // Force chalk to emit color codes even when stdout is not a TTY.
  const originalChalkLevel = chalk.level;
  if (chalk.level === 0) {
    chalk.level = 3; // truecolor
  }

  // Also set FORCE_COLOR so any child chalk instances or subprocesses get colors
  const originalForceColor = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '3';

  // Build the command string for the screenshot header
  const cmdString = buildCommandString(commandName, args, flags);

  // Capture output
  const capture = new OutputCapture();
  capture.start();

  try {
    await handler(args, flags, globals);
  } finally {
    // Always stop capture even if command throws
    var ansiOutput = capture.stop();
  }

  // Restore chalk level and env
  chalk.level = originalChalkLevel;
  if (originalForceColor === undefined) {
    delete process.env.FORCE_COLOR;
  } else {
    process.env.FORCE_COLOR = originalForceColor;
  }

  if (!ansiOutput || ansiOutput.trim().length === 0) {
    console.log(`  ${eColor('\u2717')} No output to export`);
    return;
  }

  // Convert and render
  try {
    const html = ansiToHtml(ansiOutput, {
      watermark: true,
      commandHeader: cmdString,
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

/**
 * Build the command string shown in the screenshot title bar.
 */
function buildCommandString(
  commandName: string | undefined,
  args: string[],
  flags: Record<string, string | boolean>,
): string {
  const parts = ['wunderland'];

  if (commandName) {
    parts.push(commandName);
    if (args.length > 0) parts.push(...args);
  } else if (args.length > 0) {
    parts.push(...args);
  } else if (flags['help'] || flags['h']) {
    parts.push('--help');
  } else if (flags['version'] || flags['v']) {
    parts.push('version');
  }

  return parts.join(' ');
}
