/**
 * @fileoverview Formatted output helpers for the Wunderland CLI.
 * Provides consistent styled logging across all commands.
 * @module wunderland/cli/ui/format
 */

import chalk from 'chalk';
import { success as sColor, error as eColor, warn as wColor, info as iColor, muted, dim, key as kColor, tool as tColor, channel as cColor, accent, bright } from './theme.js';

// ── Prefixed output ─────────────────────────────────────────────────────────

/** Green check + message. */
export function ok(msg: string): void {
  console.log(`  ${sColor('\u2713')} ${msg}`);
}

/** Red cross + message. */
export function fail(msg: string): void {
  console.log(`  ${eColor('\u2717')} ${msg}`);
}

/** Yellow warning triangle + message. */
export function warning(msg: string): void {
  console.log(`  ${wColor('\u26A0')} ${msg}`);
}

/** Cyan info dot + message. */
export function note(msg: string): void {
  console.log(`  ${iColor('\u25C7')} ${msg}`);
}

/** Gray circle (skipped/optional). */
export function skip(msg: string): void {
  console.log(`  ${muted('\u25CB')} ${msg}`);
}

// ── Structured output ───────────────────────────────────────────────────────

/** Section header with decorative line. */
export function section(title: string): void {
  console.log();
  console.log(`  ${accent('\u25C6')} ${bright(title)}`);
}

/** Indented key-value pair. */
export function kvPair(label: string, value: string): void {
  console.log(`    ${muted(label.padEnd(24))} ${value}`);
}

/** Masked API key display (shows last 4 chars). */
export function maskedKey(label: string, value: string): void {
  const display = value.length > 8
    ? `${dim('\u2022'.repeat(8))}${kColor(value.slice(-4))}`
    : kColor('set');
  console.log(`    ${muted(label.padEnd(24))} ${display}`);
}

/** Tool name with magenta accent. */
export function toolName(name: string, description?: string): void {
  const desc = description ? `  ${dim(description)}` : '';
  console.log(`    ${tColor(name)}${desc}`);
}

/** Channel name with cyan accent. */
export function channelName(name: string, status?: string): void {
  const st = status ? `  ${status === 'active' ? sColor('active') : muted(status)}` : '';
  console.log(`    ${cColor(name)}${st}`);
}

// ── Inline formatters (return string, don't print) ──────────────────────────

/** Clickable URL (for terminals that support it). */
export function link(url: string, label?: string): string {
  const text = label || url;
  // OSC 8 hyperlink escape
  return `\x1b]8;;${url}\x07${iColor(text)}\x1b]8;;\x07`;
}

/** Dim dot separator. */
export function dot(): string {
  return dim('  \u00B7  ');
}

/** Highlighted value inline. */
export function highlight(text: string): string {
  return accent(text);
}

/** Bold label. */
export function label(text: string): string {
  return bright(text);
}

// ── Blank line / spacing ────────────────────────────────────────────────────

export function blank(): void {
  console.log();
}

/** Horizontal rule. */
export function hr(): void {
  console.log(`  ${dim('\u2500'.repeat(56))}`);
}

// ── Error display ───────────────────────────────────────────────────────────

/** Formatted error block. */
export function errorBlock(title: string, detail?: string): void {
  console.log();
  console.log(`  ${eColor('\u2717')} ${chalk.red.bold(title)}`);
  if (detail) {
    console.log(`    ${dim(detail)}`);
  }
  console.log();
}

/** Formatted success block. */
export function successBlock(title: string, detail?: string): void {
  console.log();
  console.log(`  ${sColor('\u2713')} ${chalk.green.bold(title)}`);
  if (detail) {
    console.log(`    ${dim(detail)}`);
  }
  console.log();
}
