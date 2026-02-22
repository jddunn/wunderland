/**
 * @fileoverview Shared ANSI escape-code utilities.
 * Used by banner.ts (typewriter), layout.ts (truncate/pad), and dashboard.ts (side-by-side).
 * @module wunderland/cli/ui/ansi-utils
 */

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const ANSI_PREFIX_RE = new RegExp(`^${ESC}\\[[0-9;]*m`);

/** Strip all ANSI escape codes from a string. */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

/** Visible (non-ANSI) length of a string. */
export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

/**
 * Slice an ANSI-colored string by visible character positions.
 * All ANSI escape codes preceding visible characters up to `end` are preserved.
 */
export function sliceAnsi(str: string, _start: number, end: number): string {
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

/**
 * Pad an ANSI-colored string to a fixed visible width.
 * Uses visibleLength so ANSI codes don't count toward width.
 */
export function ansiPadEnd(str: string, width: number): string {
  const vLen = visibleLength(str);
  if (vLen >= width) return str;
  return str + ' '.repeat(width - vLen);
}
