/**
 * @fileoverview ANSI escape → styled HTML converter for PNG export.
 * Maps CLI hex palette to CSS classes for pixel-perfect terminal screenshots.
 * @module wunderland/cli/export/ansi-to-html
 */

import Convert from 'ansi-to-html';
import { HEX } from '../ui/theme.js';

export interface AnsiToHtmlOptions {
  fontFamily?: string;
  fontSize?: number;
  background?: string;
  padding?: number;
  width?: number;
  watermark?: boolean;
}

const DEFAULTS: Required<AnsiToHtmlOptions> = {
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Menlo', 'Consolas', monospace",
  fontSize: 14,
  background: '#0a0a0f',
  padding: 32,
  width: 800,
  watermark: true,
};

/**
 * Convert an ANSI-escaped string to a full HTML document ready for screenshot.
 */
export function ansiToHtml(ansi: string, opts?: AnsiToHtmlOptions): string {
  const o = { ...DEFAULTS, ...opts };

  const converter = new Convert({
    fg: HEX.white,
    bg: o.background,
    newline: true,
    escapeXML: true,
    colors: {
      0: '#1a1a2e',     // black
      1: HEX.red,       // red
      2: HEX.green,     // green
      3: HEX.gold,      // yellow
      4: HEX.cyan,      // blue
      5: HEX.magenta,   // magenta
      6: HEX.brightCyan,// cyan
      7: HEX.white,     // white
      8: HEX.dim,       // bright black
      9: '#ff6b6b',     // bright red
      10: '#4ade80',    // bright green
      11: '#fbbf24',    // bright yellow
      12: '#38bdf8',    // bright blue
      13: HEX.magenta,  // bright magenta
      14: HEX.brightCyan,// bright cyan
      15: '#ffffff',    // bright white
    } as any,
  });

  const htmlContent = converter.toHtml(ansi);

  const watermarkHtml = o.watermark
    ? `<div class="watermark">wunderland.sh</div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: ${o.background};
    color: ${HEX.white};
    font-family: ${o.fontFamily};
    font-size: ${o.fontSize}px;
    line-height: 1.5;
    padding: ${o.padding}px;
    width: ${o.width}px;
    min-height: 100px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  pre {
    white-space: pre-wrap;
    word-wrap: break-word;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
  }
  .watermark {
    margin-top: 24px;
    padding-top: 12px;
    border-top: 1px solid ${HEX.dim};
    color: ${HEX.muted};
    font-size: 11px;
    text-align: right;
    letter-spacing: 0.5px;
  }
</style>
</head>
<body>
<pre>${htmlContent}</pre>
${watermarkHtml}
</body>
</html>`;
}
