/**
 * @fileoverview Full ASCII banner with gradient coloring.
 * Shown on: `wunderland` (no args), `wunderland setup`, `wunderland --help`.
 * @module wunderland/cli/ui/banner
 */

import gradient from 'gradient-string';
import { VERSION, URLS } from '../constants.js';
import { dim, muted } from './theme.js';

// ── Static ASCII banner (fallback / always used) ────────────────────────────

const ASCII_BANNER = `
 ██╗    ██╗██╗   ██╗███╗   ██╗██████╗ ███████╗██████╗ ██╗      █████╗ ███╗   ██╗██████╗
 ██║    ██║██║   ██║████╗  ██║██╔══██╗██╔════╝██╔══██╗██║     ██╔══██╗████╗  ██║██╔══██╗
 ██║ █╗ ██║██║   ██║██╔██╗ ██║██║  ██║█████╗  ██████╔╝██║     ███████║██╔██╗ ██║██║  ██║
 ╚██╗╚█╗██╔╝╚██████╔╝██║╚████║██████╔╝███████╗██║  ██║███████╗██║  ██║██║╚████║██████╔╝
  ╚═╝ ╚═╝    ╚═════╝ ╚═╝ ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝ ╚═══╝╚═════╝`;

// Purple → Cyan gradient (matches --sol-purple → --neon-cyan)
const wunderlandGradient = gradient(['#a855f7', '#c084fc', '#22d3ee', '#06b6d4']);

/**
 * Print the full WUNDERLAND banner with gradient + links.
 * Uses cfonts if available, falls back to static ASCII art.
 */
export async function printBanner(): Promise<void> {
  let rendered = false;

  // Try cfonts for a dynamic, font-rendered banner
  try {
    const cfonts = await import('cfonts');
    const result = cfonts.default.render('WUNDERLAND', {
      font: 'tiny',
      gradient: ['#a855f7', '#06b6d4'],
      transitionGradient: true,
      space: false,
    });
    if (result && typeof result === 'object' && 'string' in result) {
      // `cfonts.render()` can return `false` depending on terminal support.
      console.log((result as any).string);
      rendered = true;
    }
  } catch {
    // cfonts not available — fall through to static banner
  }

  if (!rendered) {
    console.log(wunderlandGradient(ASCII_BANNER));
    console.log();
  }

  // Tag line with links
  const tagline = [
    dim(`  v${VERSION}`),
    dim('  '),
    muted(URLS.website),
    dim('  \u00B7  '),
    muted(URLS.saas),
    dim('  \u00B7  '),
    muted(URLS.docs),
  ].join('');

  console.log(tagline);
  console.log();
}
