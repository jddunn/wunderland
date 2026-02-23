/**
 * @fileoverview Global UI runtime settings (theme, ASCII fallback, color).
 * @module wunderland/cli/ui/runtime
 */

export type UiTheme = 'cyberpunk' | 'plain';

export interface UiRuntime {
  theme: UiTheme;
  ascii: boolean;
  noColor: boolean;
}

const DEFAULT_RUNTIME: UiRuntime = {
  // User preference: default to plain/no-color unless explicitly overridden.
  theme: 'plain',
  ascii: false,
  noColor: false,
};

let RUNTIME: UiRuntime = { ...DEFAULT_RUNTIME };

export function getUiRuntime(): UiRuntime {
  return RUNTIME;
}

export function setUiRuntime(next: Partial<UiRuntime>): UiRuntime {
  RUNTIME = { ...RUNTIME, ...next };
  return RUNTIME;
}

export function isAscii(): boolean {
  return RUNTIME.ascii;
}

export function isPlainTheme(): boolean {
  return RUNTIME.theme === 'plain';
}

export function detectAsciiFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['WUNDERLAND_ASCII'] && env['WUNDERLAND_ASCII'] !== '0') return true;
  if (env['NO_UNICODE'] && env['NO_UNICODE'] !== '0') return true;
  if ((env['TERM'] || '').toLowerCase() === 'dumb') return true;

  const locale = String(env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || '');
  if (locale && !/utf-?8/i.test(locale)) return true;

  return false;
}

export function parseUiTheme(raw: unknown): UiTheme | undefined {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'plain' || v === 'no-color' || v === 'nocolor' || v === 'mono' || v === 'monochrome') return 'plain';
  if (v === 'cyberpunk' || v === 'neon' || v === 'default') return 'cyberpunk';
  return undefined;
}

