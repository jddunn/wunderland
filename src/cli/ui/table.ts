/**
 * @fileoverview Styled table component wrapping cli-table3 with theme integration.
 * @module wunderland/cli/ui/table
 */

import Table from 'cli-table3';
import { dim, accent, muted, bright, info } from './theme.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TableColumn {
  label: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
}

export interface TableOptions {
  columns: TableColumn[];
  rows: (string | number)[][];
  title?: string;
  compact?: boolean;
  zebra?: boolean;
}

// ── Border characters ──────────────────────────────────────────────────────

// Clean compact — no borders, just spacing between columns
const BORDER_COMPACT: Record<string, string> = {
  'top': '', 'top-mid': '', 'top-left': '', 'top-right': '',
  'bottom': '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
  'left': '    ', 'left-mid': '', 'mid': '', 'mid-mid': '',
  'right': '', 'right-mid': '', 'middle': '   ',
};

const BORDER_BOXED: Record<string, string> = {
  'top': dim('\u2500'), 'top-mid': dim('\u252C'), 'top-left': dim('  \u250C'), 'top-right': dim('\u2510'),
  'bottom': dim('\u2500'), 'bottom-mid': dim('\u2534'), 'bottom-left': dim('  \u2514'), 'bottom-right': dim('\u2518'),
  'left': dim('  \u2502'), 'left-mid': dim('  \u251C'), 'mid': dim('\u2500'), 'mid-mid': dim('\u253C'),
  'right': dim('\u2502'), 'right-mid': dim('\u2524'), 'middle': dim('\u2502'),
};

// ── Render ──────────────────────────────────────────────────────────────────

/**
 * Render a styled table to a string.
 */
export function renderTable(opts: TableOptions): string {
  const termWidth = process.stdout.columns || 130;
  const { columns, rows, title, compact = false, zebra = true } = opts;

  // Calculate column widths
  const totalExplicit = columns.reduce((s, c) => s + (c.width ?? 0), 0);
  const autoCount = columns.filter((c) => !c.width).length;
  const overhead = compact ? columns.length * 3 + 4 : columns.length + 3;
  const remaining = Math.max(0, termWidth - totalExplicit - overhead);
  const autoWidth = autoCount > 0 ? Math.floor(remaining / autoCount) : 0;

  const colWidths = columns.map((c) => c.width ?? Math.max(autoWidth, 12));
  const colAligns = columns.map((c) => c.align ?? 'left') as ('left' | 'right' | 'center')[];

  const table = new Table({
    chars: compact ? BORDER_COMPACT : BORDER_BOXED,
    colWidths,
    colAligns,
    style: { head: [], border: [], 'padding-left': 1, 'padding-right': 1 },
    wordWrap: true,
  });

  // Header row — cyan uppercase
  table.push(columns.map((c) => info(c.label.toUpperCase())));

  // Separator row — thin accent line under header
  if (compact) {
    table.push(columns.map((_, i) => dim('\u2500'.repeat(Math.max(colWidths[i] - 2, 1)))));
  }

  // Data rows
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r].map((cell) => String(cell));
    if (zebra && r % 2 === 1) {
      table.push(row.map((cell) => muted(cell)));
    } else {
      table.push(row);
    }
  }

  const rendered = table.toString();
  const lines: string[] = [];

  if (title) {
    const titleText = bright(title);
    lines.push(`  ${accent('\u25C6')} ${titleText}`);
    lines.push('');
  }

  for (const line of rendered.split('\n')) {
    lines.push(line);
  }

  return lines.join('\n');
}

/**
 * Print a styled table to stdout.
 */
export function printTable(opts: TableOptions): void {
  console.log(renderTable(opts));
}
