/**
 * @fileoverview Simple region-based layout engine for TUI panels.
 * @module wunderland/cli/tui/layout
 */

import { dim, accent, bright } from '../ui/theme.js';
import { stripAnsi, visibleLength, ansiPadEnd } from '../ui/ansi-utils.js';
import { glyphs } from '../ui/glyphs.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface LayoutRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelDef {
  id: string;
  minWidth: number;
  minHeight: number;
  weight: number;
}

// ── Layout computation ─────────────────────────────────────────────────────

/**
 * Compute regions for panels within available space.
 * Simple horizontal split with weight-based width distribution.
 */
export function computeLayout(
  width: number,
  height: number,
  panels: PanelDef[],
): LayoutRegion[] {
  if (panels.length === 0) return [];

  const totalWeight = panels.reduce((s, p) => s + p.weight, 0);
  const regions: LayoutRegion[] = [];
  let currentX = 0;

  for (const panel of panels) {
    const panelWidth = Math.max(
      panel.minWidth,
      Math.floor((panel.weight / totalWeight) * width),
    );
    regions.push({
      id: panel.id,
      x: currentX,
      y: 0,
      width: Math.min(panelWidth, width - currentX),
      height: Math.max(panel.minHeight, height),
    });
    currentX += panelWidth;
  }

  return regions;
}

// ── Rendering helpers ──────────────────────────────────────────────────────

/**
 * Draw a bordered box at a position in a string buffer.
 */
export function drawBox(
  width: number,
  height: number,
  title?: string,
  style: 'normal' | 'focused' | 'brand' = 'normal',
): string[] {
  const g = glyphs();
  const borderColor = style === 'brand' ? accent : style === 'focused' ? accent : dim;
  const lines: string[] = [];

  // Top border
  const titleStr = title ? ` ${bright(title)} ` : '';
  const titleLen = title ? title.length + 2 : 0;
  const topLine =
    borderColor(g.box.tl)
    + titleStr
    + borderColor(g.box.h.repeat(Math.max(0, width - 2 - titleLen)))
    + borderColor(g.box.tr);
  lines.push(topLine);

  // Content lines
  for (let i = 0; i < height - 2; i++) {
    lines.push(borderColor(g.box.v) + ' '.repeat(Math.max(0, width - 2)) + borderColor(g.box.v));
  }

  // Bottom border
  lines.push(borderColor(g.box.bl) + borderColor(g.box.h.repeat(Math.max(0, width - 2))) + borderColor(g.box.br));

  return lines;
}

/**
 * Truncate a string to fit within a width, adding ellipsis if needed.
 * ANSI-safe: uses visible length, not raw string length.
 */
export function truncate(text: string, maxWidth: number): string {
  const g = glyphs();
  const vLen = visibleLength(text);
  if (vLen <= maxWidth) return text;
  const ell = g.ellipsis;
  const ellLen = visibleLength(ell);
  if (maxWidth <= ellLen) return ell.slice(0, Math.max(0, maxWidth));
  return stripAnsi(text).slice(0, Math.max(0, maxWidth - ellLen)) + ell;
}

/**
 * Pad a string to a fixed visible width.
 * ANSI-safe: uses visible length for padding calculation.
 */
export function padTo(text: string, width: number): string {
  return ansiPadEnd(text, width);
}

/**
 * Create a horizontal separator line.
 */
export function horizontalLine(width: number, style: 'normal' | 'focused' = 'normal'): string {
  const g = glyphs();
  const color = style === 'focused' ? accent : dim;
  return color(g.hr.repeat(width));
}

/**
 * Compose two sets of lines side-by-side with a gap between them.
 * ANSI-safe: uses visibleLength for alignment.
 */
export function composeSideBySide(
  leftLines: string[],
  rightLines: string[],
  leftWidth: number,
  gap = 2,
): string[] {
  const maxRows = Math.max(leftLines.length, rightLines.length);
  const result: string[] = [];
  const gapStr = ' '.repeat(gap);

  for (let i = 0; i < maxRows; i++) {
    const left = i < leftLines.length ? leftLines[i] : '';
    const right = i < rightLines.length ? rightLines[i] : '';
    result.push(ansiPadEnd(left, leftWidth) + gapStr + right);
  }

  return result;
}
