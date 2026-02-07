/**
 * @fileoverview Cyberpunk color theme for the Wunderland CLI.
 * Mirrors the wunderland.sh / rabbithole CSS custom properties.
 * @module wunderland/cli/ui/theme
 */

import chalk from 'chalk';

// ── Raw Hex Palette ─────────────────────────────────────────────────────────

export const HEX = {
  purple: '#a855f7',
  cyan: '#06b6d4',
  green: '#22c55e',
  red: '#ef4444',
  gold: '#f59e0b',
  magenta: '#e879f9',
  brightCyan: '#22d3ee',
  muted: '#6b7280',
  dim: '#4b5563',
  white: '#f9fafb',
} as const;

// ── Gradient endpoints (for gradient-string) ────────────────────────────────

export const GRADIENT_COLORS = [HEX.purple, HEX.cyan] as const;
export const GRADIENT_WARM = [HEX.magenta, HEX.gold] as const;
export const GRADIENT_COOL = [HEX.cyan, HEX.green] as const;

// ── Semantic chalk styles ───────────────────────────────────────────────────

/** Primary accent (purple). */
export const accent = chalk.hex(HEX.purple);

/** Secondary accent (cyan). */
export const info = chalk.hex(HEX.cyan);

/** Success / pass (green). */
export const success = chalk.hex(HEX.green);

/** Error / fail (red). */
export const error = chalk.hex(HEX.red);

/** Warning / caution (gold). */
export const warn = chalk.hex(HEX.gold);

/** Tool / extension (magenta). */
export const tool = chalk.hex(HEX.magenta);

/** Channel (bright cyan). */
export const channel = chalk.hex(HEX.brightCyan);

/** Key / credential (gold). */
export const key = chalk.hex(HEX.gold);

/** Muted / secondary text. */
export const muted = chalk.hex(HEX.muted);

/** Dim text. */
export const dim = chalk.hex(HEX.dim);

/** Bold accent. */
export const heading = chalk.hex(HEX.purple).bold;

/** Bold white. */
export const bright = chalk.hex(HEX.white).bold;

/** Separator line. */
export const separator = muted('─'.repeat(60));
