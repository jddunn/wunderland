/**
 * @fileoverview Styled table component wrapping cli-table3 with theme integration.
 * @module wunderland/cli/ui/table
 */

import Table from 'cli-table3';
import { dim, accent, muted, bright, info } from './theme.js';
import { glyphs } from './glyphs.js';

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

function borderBoxed(): Record<string, string> {
  const g = glyphs();
  const indent = '  ';
  return {
    'top': dim(g.box.h),
    'top-mid': dim(g.box.tT),
    'top-left': dim(indent + g.box.tl),
    'top-right': dim(g.box.tr),
    'bottom': dim(g.box.h),
    'bottom-mid': dim(g.box.bT),
    'bottom-left': dim(indent + g.box.bl),
    'bottom-right': dim(g.box.br),
    'left': dim(indent + g.box.v),
    'left-mid': dim(indent + g.box.lT),
    'mid': dim(g.box.h),
    'mid-mid': dim(g.box.cross),
    'right': dim(g.box.v),
    'right-mid': dim(g.box.rT),
    'middle': dim(g.box.v),
  };
}

// ── Render ──────────────────────────────────────────────────────────────────

/**
 * Render a styled table to a string.
 */
export function renderTable(opts: TableOptions): string {
  const termWidth = process.stdout.columns || 130;
  const g = glyphs();
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
    chars: compact ? BORDER_COMPACT : borderBoxed(),
    colWidths,
    colAligns,
    style: { head: [], border: [], 'padding-left': 1, 'padding-right': 1 },
    wordWrap: true,
  });

  // Header row — cyan uppercase
  table.push(columns.map((c) => info(c.label.toUpperCase())));

  // Separator row — thin accent line under header
  if (compact) {
    table.push(columns.map((_, i) => dim(g.hr.repeat(Math.max(colWidths[i] - 2, 1)))));
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
    lines.push(`  ${accent(g.bullet)} ${titleText}`);
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
