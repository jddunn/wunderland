/**
 * @fileoverview Layered keyboard handler for TUI mode.
 * Stack-based context layers: dashboard keys at bottom, view-specific on top.
 * @module wunderland/cli/tui/keybindings
 */

import type { KeypressEvent } from './screen.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type KeyHandler = (key: KeypressEvent) => void | boolean;

export interface KeyLayer {
  name: string;
  bindings: Record<string, KeyHandler>;
}

// ── KeybindingManager ──────────────────────────────────────────────────────

export class KeybindingManager {
  private stack: KeyLayer[] = [];

  /** Push a new key context layer onto the stack. */
  push(layer: KeyLayer): void {
    this.stack.push(layer);
  }

  /** Pop the top key context layer. Returns the removed layer or undefined. */
  pop(): KeyLayer | undefined {
    if (this.stack.length <= 1) return undefined; // Don't pop the root layer
    return this.stack.pop();
  }

  /** Get the current (top) layer name. */
  get currentLayer(): string {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1].name : 'none';
  }

  /** Get the depth of the stack. */
  get depth(): number {
    return this.stack.length;
  }

  /**
   * Handle a keypress event. Checks layers top-to-bottom.
   * Returns true if the key was handled.
   */
  handle(key: KeypressEvent): boolean {
    // Build the lookup key string
    const keyName = this.normalizeKey(key);
    const isText =
      !key.ctrl
      && !key.meta
      && typeof key.sequence === 'string'
      && key.sequence.length === 1
      // `readline` may set `name` to '' (unset), a single character, or e.g. 'space'.
      && (key.name === '' || key.name === 'space' || key.name.length === 1);

    // Check layers from top to bottom
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const layer = this.stack[i];
      const handler = layer.bindings[keyName];
      if (handler) {
        const result = handler(key);
        // If handler returns false, continue to next layer
        if (result !== false) return true;

        // If the explicit handler defers (returns false), allow the layer's
        // text handler to catch printable characters before falling through.
        if (isText) {
          const textHandler = layer.bindings['__text__'];
          if (textHandler) {
            const textResult = textHandler(key);
            if (textResult !== false) return true;
          }
        }

        continue;
      }

      // Special handler for text input (printable characters).
      // Allows views to implement input without registering every possible character.
      if (isText) {
        const textHandler = layer.bindings['__text__'];
        if (textHandler) {
          const result = textHandler(key);
          if (result !== false) return true;
        }
      }

      // Catch-all handler for overlays/palettes that want to consume all keys.
      const anyHandler = layer.bindings['__any__'];
      if (anyHandler) {
        const result = anyHandler(key);
        if (result !== false) return true;
      }
    }

    return false;
  }

  /** Clear all layers. */
  clear(): void {
    this.stack = [];
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private normalizeKey(key: KeypressEvent): string {
    const parts: string[] = [];
    if (key.ctrl) parts.push('ctrl');
    if (key.meta) parts.push('meta');
    if (key.shift) parts.push('shift');

    const name = key.name || key.sequence;
    if (name) parts.push(name);

    return parts.join('+');
  }
}
