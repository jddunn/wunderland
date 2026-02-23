/**
 * @fileoverview One-line compact header for non-primary commands.
 * @module wunderland/cli/ui/compact-header
 */

import { VERSION, URLS } from '../constants.js';
import { bright, dim, muted } from './theme.js';
import { wordmarkGradient } from './brand.js';
import { glyphs } from './glyphs.js';
import { getUiRuntime } from './runtime.js';

/**
 * Print a single-line branded header.
 * Shown on: all commands except setup / help / no-args.
 */
export function printCompactHeader(): void {
  const ui = getUiRuntime();
  const g = glyphs();
  const brand = ui.theme === 'cyberpunk' && !ui.noColor && !ui.ascii
    ? wordmarkGradient.multiline('WUNDERLAND')
    : bright('WUNDERLAND');
  console.log(`  ${brand} ${dim(`v${VERSION}`)}${dim(`  ${g.dot}  `)}${muted(URLS.website)}${dim(`  ${g.dot}  `)}${muted(URLS.saas)}`);
  console.log();
}
