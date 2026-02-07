/**
 * @fileoverview One-line compact header for non-primary commands.
 * @module wunderland/cli/ui/compact-header
 */

import gradient from 'gradient-string';
import { VERSION, URLS } from '../constants.js';
import { dim, muted } from './theme.js';

const wunderlandGradient = gradient(['#a855f7', '#06b6d4']);

/**
 * Print a single-line branded header.
 * Shown on: all commands except setup / help / no-args.
 */
export function printCompactHeader(): void {
  const brand = wunderlandGradient.multiline('WUNDERLAND');
  console.log(`  ${brand} ${dim(`v${VERSION}`)}${dim('  \u00B7  ')}${muted(URLS.website)}${dim('  \u00B7  ')}${muted(URLS.saas)}`);
  console.log();
}
