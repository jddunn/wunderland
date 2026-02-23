/**
 * @fileoverview Full ASCII banner with gradient coloring and typewriter animation.
 * Shown on: `wunderland` (no args), `wunderland setup`, `wunderland init`, `wunderland --help`.
 * @module wunderland/cli/ui/banner
 */

import { VERSION, URLS } from '../constants.js';
import { dim, muted } from './theme.js';
import { ASCII_BANNER, ASCII_BANNER_ASCII, brandGradient } from './brand.js';
import { stripAnsi, sliceAnsi } from './ansi-utils.js';
import { glyphs } from './glyphs.js';
import { getUiRuntime } from './runtime.js';

// ── Typewriter reveal ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Reveal banner lines column-by-column with a typewriter effect.
 * Only runs in TTY terminals; callers should check `process.stdout.isTTY` first.
 */
async function typewriterReveal(lines: string[], stepCols = 3, delayMs = 6): Promise<void> {
  const maxLen = Math.max(...lines.map((l) => stripAnsi(l).length));

  // Reserve vertical space
  for (let i = 0; i < lines.length; i++) {
    process.stdout.write('\n');
  }

  for (let col = 0; col <= maxLen; col += stepCols) {
    // Move cursor up to first banner line
    process.stdout.write(`\x1b[${lines.length}A`);

    for (const line of lines) {
      const visible = sliceAnsi(line, 0, col);
      process.stdout.write(`\r${visible}\x1b[K\n`);
    }

    await sleep(delayMs);
  }

  // Final full render (ensure nothing clipped)
  process.stdout.write(`\x1b[${lines.length}A`);
  for (const line of lines) {
    process.stdout.write(`\r${line}\x1b[K\n`);
  }
}

// ── Tagline ──────────────────────────────────────────────────────────────────

function printTagline(): void {
  const g = glyphs();
  const tagline = [
    dim(`  v${VERSION}`),
    dim('  '),
    muted(URLS.website),
    dim(`  ${g.dot}  `),
    muted(URLS.saas),
    dim(`  ${g.dot}  `),
    muted(URLS.docs),
  ].join('');

  console.log(tagline);
  console.log();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Print the full WUNDERLAND banner with gradient + typewriter animation.
 * Uses cfonts if available, falls back to static ASCII art.
 */
export async function printBanner(): Promise<void> {
  const ui = getUiRuntime();
  let bannerLines: string[] = [];
  let rendered = false;

  // Try cfonts for a dynamic, font-rendered banner
  if (ui.theme === 'cyberpunk' && !ui.noColor && !ui.ascii) {
    try {
      const cfonts = await import('cfonts');
      const result = cfonts.default.render('WUNDERLAND', {
        font: 'chrome',
        gradient: ['#a855f7', '#c084fc', '#22d3ee', '#06b6d4'],
        transitionGradient: true,
        space: false,
      });
      if (result && typeof result === 'object' && 'string' in result && (result as any).string) {
        bannerLines = (result as any).string.split('\n');
        rendered = true;
      }
    } catch {
      // cfonts not available — fall through to static banner
    }
  }

  if (!rendered) {
    if (ui.ascii) {
      bannerLines = ASCII_BANNER_ASCII.split('\n');
    } else if (ui.theme === 'cyberpunk' && !ui.noColor) {
      bannerLines = brandGradient(ASCII_BANNER).split('\n');
    } else {
      bannerLines = ASCII_BANNER.split('\n');
    }
  }

  // Filter out empty trailing lines
  while (bannerLines.length > 0 && stripAnsi(bannerLines[bannerLines.length - 1]).trim() === '') {
    bannerLines.pop();
  }

  // Display: animated only for the cyberpunk theme in capable terminals.
  if (process.stdout.isTTY && bannerLines.length > 0 && ui.theme === 'cyberpunk' && !ui.noColor && !ui.ascii) {
    console.log(); // top margin
    await typewriterReveal(bannerLines);
  } else {
    console.log(bannerLines.join('\n'));
  }

  console.log();
  printTagline();
}
