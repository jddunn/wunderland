/**
 * @fileoverview Simple region-based layout engine for TUI panels.
 * @module wunderland/cli/tui/layout
 */

import { dim, accent, bright } from '../ui/theme.js';

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
  style: 'normal' | 'focused' = 'normal',
): string[] {
  const borderColor = style === 'focused' ? accent : dim;
  const lines: string[] = [];

  // Top border
  const titleStr = title ? ` ${bright(title)} ` : '';
  const titleLen = title ? title.length + 2 : 0;
  const topLine = borderColor('┌') + titleStr + borderColor('─'.repeat(Math.max(0, width - 2 - titleLen))) + borderColor('┐');
  lines.push(topLine);

  // Content lines
  for (let i = 0; i < height - 2; i++) {
    lines.push(borderColor('│') + ' '.repeat(Math.max(0, width - 2)) + borderColor('│'));
  }

  // Bottom border
  lines.push(borderColor('└') + borderColor('─'.repeat(Math.max(0, width - 2))) + borderColor('┘'));

  return lines;
}

/**
 * Truncate a string to fit within a width, adding ellipsis if needed.
 */
export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return '\u2026';
  return text.slice(0, maxWidth - 1) + '\u2026';
}

/**
 * Pad a string to a fixed width.
 */
export function padTo(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + ' '.repeat(width - text.length);
}

/**
 * Create a horizontal separator line.
 */
export function horizontalLine(width: number, style: 'normal' | 'focused' = 'normal'): string {
  const color = style === 'focused' ? accent : dim;
  return color('─'.repeat(width));
}
