/**
 * @fileoverview Terminal screen management via node:readline.
 * Handles alternate screen buffer, cursor control, raw keypresses, and resize.
 * @module wunderland/cli/tui/screen
 */

import * as readline from 'node:readline';

// ── Types ──────────────────────────────────────────────────────────────────

export interface KeypressEvent {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
}

// ── Screen ─────────────────────────────────────────────────────────────────

export class Screen {
  private resizeHandlers: (() => void)[] = [];
  private keypressHandlers: ((key: KeypressEvent) => void)[] = [];
  private inAltScreen = false;
  private disposed = false;

  constructor() {
    // Enable keypress events on stdin
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
    }
  }

  /** Enter the alternate screen buffer (preserves original terminal). */
  enterAltScreen(): void {
    if (this.inAltScreen) return;
    process.stdout.write('\x1b[?1049h');
    this.inAltScreen = true;
  }

  /** Exit the alternate screen buffer (restores original terminal). */
  exitAltScreen(): void {
    if (!this.inAltScreen) return;
    process.stdout.write('\x1b[?1049l');
    this.inAltScreen = false;
  }

  /** Hide the cursor. */
  hideCursor(): void {
    process.stdout.write('\x1b[?25l');
  }

  /** Show the cursor. */
  showCursor(): void {
    process.stdout.write('\x1b[?25h');
  }

  /** Clear the entire screen. */
  clear(): void {
    process.stdout.write('\x1b[2J\x1b[H');
  }

  /** Move cursor to a specific row and column (1-indexed). */
  moveCursor(row: number, col: number): void {
    process.stdout.write(`\x1b[${row};${col}H`);
  }

  /** Get terminal dimensions. */
  getSize(): { rows: number; cols: number } {
    return {
      rows: process.stdout.rows || 24,
      cols: process.stdout.columns || 80,
    };
  }

  /** Register a resize handler. */
  onResize(cb: () => void): void {
    this.resizeHandlers.push(cb);
    process.stdout.on('resize', cb);
  }

  /** Register a keypress handler and enable raw mode. */
  onKeypress(cb: (key: KeypressEvent) => void): void {
    this.keypressHandlers.push(cb);

    if (process.stdin.isTTY && !process.stdin.isRaw) {
      process.stdin.setRawMode(true);
    }

    const handler = (_str: string | undefined, key: any) => {
      if (!key) return;
      cb({
        name: key.name || '',
        ctrl: key.ctrl || false,
        meta: key.meta || false,
        shift: key.shift || false,
        sequence: key.sequence || '',
      });
    };

    process.stdin.on('keypress', handler);
    process.stdin.resume();
  }

  /** Render content string to the full screen (clears first). */
  render(content: string): void {
    this.clear();
    process.stdout.write(content);
  }

  /** Clean up: restore cursor, exit alt screen, release stdin. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.showCursor();
    this.exitAltScreen();

    // Remove resize handlers
    for (const handler of this.resizeHandlers) {
      process.stdout.removeListener('resize', handler);
    }
    this.resizeHandlers = [];
    this.keypressHandlers = [];

    // Restore stdin
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }
}
