/**
 * @fileoverview TUI drill-down view: extension catalog browser.
 * @module wunderland/cli/tui/views/extensions-view
 */

import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor } from '../../ui/theme.js';

interface ExtEntry {
  name: string;
  displayName: string;
  category: string;
  available: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  tool: 'Tools', channel: 'Channels', voice: 'Voice', productivity: 'Productivity',
  integration: 'Integrations',
};

export class ExtensionsView {
  private screen: Screen;
  private keys: KeybindingManager;
  private onBack: () => void;
  private cursor = 0;
  private extensions: ExtEntry[] = [];
  private scrollOffset = 0;

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;

    this.keys.push({
      name: 'extensions-view',
      bindings: {
        'up': () => { this.move(-1); },
        'down': () => { this.move(1); },
        'k': () => { this.move(-1); },
        'j': () => { this.move(1); },
        'escape': () => { this.back(); },
        'backspace': () => { this.back(); },
        'q': () => { this.back(); },
      },
    });
  }

  async run(): Promise<void> {
    try {
      const registry = await import('@framers/agentos-extensions-registry');
      const exts = await registry.getAvailableExtensions();
      this.extensions = exts.map((e: any) => ({
        name: e.name, displayName: e.displayName,
        category: e.category, available: e.available,
      }));
    } catch {
      this.extensions = [];
    }
    this.render();
  }

  private render(): void {
    const { rows } = this.screen.getSize();
    const maxVisible = Math.max(5, rows - 8);
    const lines: string[] = [];

    const installed = this.extensions.filter((e) => e.available).length;
    lines.push('');
    lines.push(`  ${accent('◆')} ${bright('Extensions')}  ${dim(`(${installed}/${this.extensions.length} installed)`)}`);
    lines.push('');

    // Group by category for display
    let currentCategory = '';
    const start = this.scrollOffset;
    const end = Math.min(this.extensions.length, start + maxVisible);

    for (let i = start; i < end; i++) {
      const ext = this.extensions[i];

      if (ext.category !== currentCategory) {
        currentCategory = ext.category;
        const label = CATEGORY_LABELS[currentCategory] || currentCategory;
        lines.push(`  ${bright(label)}`);
      }

      const selected = i === this.cursor;
      const cursor = selected ? accent('>') : ' ';
      const icon = ext.available ? sColor('✓') : muted('○');
      const name = selected ? bright(ext.displayName) : ext.displayName;
      const status = ext.available ? sColor('installed') : muted('not installed');

      lines.push(`  ${cursor} ${icon} ${name.padEnd(28)} ${status}`);
    }

    if (this.extensions.length > maxVisible) {
      lines.push(`  ${dim(`... ${start + 1}-${end} of ${this.extensions.length}`)}`);
    }

    lines.push('');
    lines.push(`  ${dim('↑↓')} navigate  ${dim('esc')} back`);

    this.screen.render(lines.join('\n'));
  }

  private move(delta: number): void {
    this.cursor = Math.max(0, Math.min(this.extensions.length - 1, this.cursor + delta));
    const { rows } = this.screen.getSize();
    const maxVisible = Math.max(5, rows - 8);
    if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
    if (this.cursor >= this.scrollOffset + maxVisible) this.scrollOffset = this.cursor - maxVisible + 1;
    this.render();
  }

  private back(): void {
    this.keys.pop();
    this.onBack();
  }

  dispose(): void {
    this.keys.pop();
  }
}
