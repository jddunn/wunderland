/**
 * @fileoverview Lightweight overlay box renderer for TUI help/palettes.
 * @module wunderland/cli/tui/widgets/overlay
 */

import { dim, accent, bright } from '../../ui/theme.js';
import { visibleLength, ansiPadEnd, sliceAnsi } from '../../ui/ansi-utils.js';
import { glyphs } from '../../ui/glyphs.js';

export function renderOverlayBox(opts: {
  title: string;
  lines: string[];
  width: number;
}): string[] {
  const g = glyphs();
  const width = Math.max(24, opts.width);
  const inner = Math.max(0, width - 2);
  const title = ` ${bright(opts.title)} `;
  const titleLen = visibleLength(title);
  const top = accent(g.box.tl) + title + accent(g.box.h.repeat(Math.max(0, inner - titleLen))) + accent(g.box.tr);
  const bot = accent(g.box.bl) + accent(g.box.h.repeat(inner)) + accent(g.box.br);

  const out: string[] = [top];
  for (const line of opts.lines) {
    const padded = ansiPadEnd(line, inner);
    out.push(accent(g.box.v) + padded + accent(g.box.v));
  }
  // Ensure at least one blank row for breathing room
  if (opts.lines.length === 0) {
    out.push(accent(g.box.v) + ' '.repeat(inner) + accent(g.box.v));
  }
  out.push(bot);

  // Subtle drop shadow (dim) on the last column when space allows is too hard
  // in a pure string render; keep it simple and readable.
  return out.map((l) => dim(l) + '');
}

/**
 * Stamp an overlay box into a screen buffer.
 * This intentionally replaces underlying rows (no alpha blending) to keep rendering simple and flicker-free.
 */
export function stampOverlay(opts: {
  screenLines: string[];
  overlayLines: string[];
  cols: number;
  rows: number;
  x?: number;
  y?: number;
}): string[] {
  const screen = [...opts.screenLines];
  const overlay = opts.overlayLines;

  while (screen.length < opts.rows) screen.push('');

  const overlayWidth = Math.max(0, ...overlay.map((l) => visibleLength(l)));
  const overlayHeight = overlay.length;

  const x = Math.max(0, Math.min(opts.x ?? Math.floor((opts.cols - overlayWidth) / 2), Math.max(0, opts.cols - overlayWidth)));
  const y = Math.max(0, Math.min(opts.y ?? Math.floor((opts.rows - overlayHeight) / 2), Math.max(0, opts.rows - overlayHeight)));

  for (let i = 0; i < overlay.length; i++) {
    const row = y + i;
    if (row < 0 || row >= screen.length) continue;

    const line = overlay[i] ?? '';
    const padded = ansiPadEnd(`${' '.repeat(x)}${line}`, opts.cols);
    screen[row] = visibleLength(padded) > opts.cols ? sliceAnsi(padded, 0, opts.cols) : padded;
  }

  return screen;
}
