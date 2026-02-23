/**
 * @fileoverview Unicode/ASCII glyph selection for CLI + TUI.
 * @module wunderland/cli/ui/glyphs
 */

import { getUiRuntime } from './runtime.js';

export interface BoxGlyphs {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
  lT: string;
  rT: string;
  tT: string;
  bT: string;
  cross: string;
}

export interface GlyphSet {
  ok: string;
  fail: string;
  warn: string;
  info: string;

  bullet: string;
  bulletHollow: string;
  circle: string;
  mask: string;

  dot: string;
  hr: string;
  ellipsis: string;

  cursor: string;
  search: string;

  triUp: string;
  triDown: string;

  box: BoxGlyphs;
  boxHeavy: BoxGlyphs;
}

const ASCII: GlyphSet = {
  ok: 'OK',
  fail: 'X',
  warn: '!',
  info: 'i',

  bullet: '*',
  bulletHollow: '-',
  circle: 'o',
  mask: '*',

  dot: '|',
  hr: '-',
  ellipsis: '...',

  cursor: '>',
  search: '/',

  triUp: '^',
  triDown: 'v',

  box: {
    tl: '+', tr: '+', bl: '+', br: '+',
    h: '-', v: '|',
    lT: '+', rT: '+', tT: '+', bT: '+',
    cross: '+',
  },
  boxHeavy: {
    tl: '+', tr: '+', bl: '+', br: '+',
    h: '=', v: '|',
    lT: '+', rT: '+', tT: '+', bT: '+',
    cross: '+',
  },
};

const UNICODE: GlyphSet = {
  ok: '\u2713', // ✓
  fail: '\u2717', // ✗
  warn: '\u26A0', // ⚠
  info: '\u25C7', // ◇

  bullet: '\u25C6', // ◆
  bulletHollow: '\u25C7', // ◇
  circle: '\u25CB', // ○
  mask: '\u2022', // •

  dot: '\u00B7', // ·
  hr: '\u2500', // ─
  ellipsis: '\u2026', // …

  cursor: '\u25B8', // ▸
  search: '\u2315', // ⌕

  triUp: '\u25B2', // ▲
  triDown: '\u25BC', // ▼

  box: {
    tl: '\u250C', tr: '\u2510', bl: '\u2514', br: '\u2518',
    h: '\u2500', v: '\u2502',
    lT: '\u251C', rT: '\u2524', tT: '\u252C', bT: '\u2534',
    cross: '\u253C',
  },
  boxHeavy: {
    tl: '\u250F', tr: '\u2513', bl: '\u2517', br: '\u251B',
    h: '\u2501', v: '\u2503',
    lT: '\u2523', rT: '\u252B', tT: '\u2533', bT: '\u253B',
    cross: '\u254B',
  },
};

export function glyphs(): GlyphSet {
  return getUiRuntime().ascii ? ASCII : UNICODE;
}
