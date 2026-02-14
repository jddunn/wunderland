/**
 * @fileoverview Full ASCII banner with gradient coloring and typewriter animation.
 * Shown on: `wunderland` (no args), `wunderland setup`, `wunderland init`, `wunderland --help`.
 * @module wunderland/cli/ui/banner
 */

import gradient from 'gradient-string';
import { VERSION, URLS } from '../constants.js';
import { dim, muted } from './theme.js';

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const ANSI_PREFIX_RE = new RegExp(`^${ESC}\\[[0-9;]*m`);

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

/**
 * Slice an ANSI-colored string by visible character positions.
 * All ANSI escape codes preceding visible characters up to `end` are preserved.
 */
function sliceAnsi(str: string, _start: number, end: number): string {
  let visible = 0;
  let result = '';
  let i = 0;

  while (i < str.length && visible < end) {
    const rest = str.slice(i);
    const m = rest.match(ANSI_PREFIX_RE);
    if (m) {
      result += m[0];
      i += m[0].length;
    } else {
      result += str[i];
      visible++;
      i++;
    }
  }

  result += '\x1b[0m';
  return result;
}

// ── Static ASCII banner (fallback when cfonts unavailable) ───────────────────

const ASCII_BANNER = `
 ██╗    ██╗██╗   ██╗███╗   ██╗██████╗ ███████╗██████╗ ██╗      █████╗ ███╗   ██╗██████╗
 ██║    ██║██║   ██║████╗  ██║██╔══██╗██╔════╝██╔══██╗██║     ██╔══██╗████╗  ██║██╔══██╗
 ██║ █╗ ██║██║   ██║██╔██╗ ██║██║  ██║█████╗  ██████╔╝██║     ███████║██╔██╗ ██║██║  ██║
 ╚██╗╚█╗██╔╝╚██████╔╝██║╚████║██████╔╝███████╗██║  ██║███████╗██║  ██║██║╚████║██████╔╝
  ╚═╝ ╚═╝    ╚═════╝ ╚═╝ ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝ ╚═══╝╚═════╝`;

// Purple → Magenta → Cyan gradient (matches brand palette)
const wunderlandGradient = gradient(['#a855f7', '#c084fc', '#e879f9', '#22d3ee', '#06b6d4']);

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

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Print the full WUNDERLAND banner with gradient + typewriter animation.
 * Uses cfonts if available, falls back to static ASCII art.
 */
export async function printBanner(): Promise<void> {
  let bannerLines: string[] = [];
  let rendered = false;

  // Try cfonts for a dynamic, font-rendered banner
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

  if (!rendered) {
    bannerLines = wunderlandGradient(ASCII_BANNER).split('\n');
  }

  // Filter out empty trailing lines
  while (bannerLines.length > 0 && stripAnsi(bannerLines[bannerLines.length - 1]).trim() === '') {
    bannerLines.pop();
  }

  // Display: animated for TTY, instant for piped output
  if (process.stdout.isTTY && bannerLines.length > 0) {
    console.log(); // top margin
    await typewriterReveal(bannerLines);
  } else {
    console.log(bannerLines.join('\n'));
  }

  console.log();
  printTagline();
}
