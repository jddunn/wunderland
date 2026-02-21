/**
 * @fileoverview Bordered panel component wrapping boxen with theme integration.
 * @module wunderland/cli/ui/panel
 */

import boxen from 'boxen';
import { HEX } from './theme.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type PanelStyle = 'brand' | 'success' | 'warning' | 'error' | 'info';

export interface PanelOptions {
  title?: string;
  content: string;
  style?: PanelStyle;
  width?: number;
  padding?: number;
}

// ── Style map ──────────────────────────────────────────────────────────────

const PANEL_COLORS: Record<PanelStyle, string> = {
  brand: HEX.purple,
  success: HEX.green,
  warning: HEX.gold,
  error: HEX.red,
  info: HEX.cyan,
};

// ── Render ──────────────────────────────────────────────────────────────────

/**
 * Render a bordered panel to a string.
 */
export function renderPanel(opts: PanelOptions): string {
  const { content, title, style = 'brand', width, padding = 1 } = opts;
  const borderColor = PANEL_COLORS[style];

  const box = boxen(content, {
    title: title ? ` ${title} ` : undefined,
    titleAlignment: 'left',
    padding: { top: 0, bottom: 0, left: padding, right: padding },
    margin: { top: 0, bottom: 0, left: 2, right: 0 },
    borderStyle: 'round',
    borderColor,
    width: width ?? Math.min(process.stdout.columns || 80, 76),
    dimBorder: false,
  });

  return box;
}

/**
 * Print a bordered panel to stdout.
 */
export function printPanel(opts: PanelOptions): void {
  console.log(renderPanel(opts));
}
