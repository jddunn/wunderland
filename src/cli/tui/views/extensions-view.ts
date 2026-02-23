/**
 * @fileoverview TUI drill-down view: extension catalog browser.
 * @module wunderland/cli/tui/views/extensions-view
 */

import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor } from '../../ui/theme.js';
import { ansiPadEnd } from '../../ui/ansi-utils.js';
import { renderOverlayBox, stampOverlay } from '../widgets/overlay.js';
import { wrapInFrame } from '../layout.js';
import { glyphs } from '../../ui/glyphs.js';
import { getUiRuntime } from '../../ui/runtime.js';

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
  private searchMode = false;
  private filter = '';
  private modal: null | { title: string; lines: string[] } = null;

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;

    this.keys.push({
      name: 'extensions-view',
      bindings: {
        '__text__': (key) => {
          if (this.modal) return true;
          if (!this.searchMode) return true;
          this.filter += key.sequence;
          this.cursor = 0;
          this.scrollOffset = 0;
          this.render();
          return true;
        },
        '/': () => {
          if (this.modal) return true;
          if (this.searchMode) return false;
          this.enterSearch();
          return true;
        },
        '?': () => {
          if (this.searchMode) return false;
          if (this.modal?.title === 'Help') { this.modal = null; this.render(); return true; }
          if (this.modal) return true;
          this.modal = { title: 'Help', lines: this.getHelpLines() };
          this.render();
          return true;
        },
        'up': () => { if (this.modal) return; this.move(-1); },
        'down': () => { if (this.modal) return; this.move(1); },
        'k': () => { if (this.modal) return true; if (this.searchMode) return false; this.move(-1); return true; },
        'j': () => { if (this.modal) return true; if (this.searchMode) return false; this.move(1); return true; },
        'return': () => {
          if (this.modal) { this.modal = null; this.render(); return; }
          this.openDetails();
        },
        'escape': () => {
          if (this.modal) { this.modal = null; this.render(); return; }
          if (this.searchMode) { this.exitSearch(); return; }
          this.back();
        },
        'backspace': () => {
          if (this.modal) { this.modal = null; this.render(); return; }
          if (this.searchMode) {
            if (this.filter.length > 0) {
              this.filter = this.filter.slice(0, -1);
              this.cursor = 0;
              this.scrollOffset = 0;
              this.render();
              return;
            }
            this.exitSearch();
            return;
          }
          this.back();
        },
        'q': () => { if (this.modal) { this.modal = null; this.render(); return true; } if (this.searchMode) return false; this.back(); return true; },
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
    const g = glyphs();
    const ui = getUiRuntime();
    const upDown = ui.ascii ? 'Up/Down' : '↑/↓';
    const enter = ui.ascii ? 'Enter' : '⏎';
    const { rows, cols } = this.screen.getSize();
    const maxVisible = this.maxVisibleRows(rows);
    const lines: string[] = [];

    const filtered = this.getFilteredExtensions();
    if (this.cursor > filtered.length - 1) this.cursor = Math.max(0, filtered.length - 1);
    this.clampScroll(filtered.length, maxVisible);

    const installed = this.extensions.filter((e) => e.available).length;
    lines.push('');
    lines.push(`  ${accent(g.bullet)} ${bright('Extensions')}  ${dim(`(${installed}/${this.extensions.length} installed)`)}`);
    lines.push('');

    if (this.searchMode) {
      const q = this.filter.trim();
      const shown = q ? bright(q) : dim(`type to filter${g.ellipsis}`);
      lines.push(`  ${dim(g.search)} ${muted('Search:')} ${shown}  ${dim('(esc to exit)')}`);
      lines.push('');
    }

    if (filtered.length === 0) {
      const msg = this.filter.trim().length > 0 ? dim('No matches. Press esc to exit search.') : dim('No extensions available.');
      lines.push(`  ${msg}`);
    } else {
      const start = this.scrollOffset;
      const end = Math.min(filtered.length, start + maxVisible);

      for (let i = start; i < end; i++) {
        const ext = filtered[i];
        const selected = i === this.cursor;
        const cursor = selected ? accent(g.cursor) : ' ';
        const icon = ext.available ? sColor(g.ok) : muted(g.circle);
        const name = selected ? bright(ext.displayName) : ext.displayName;
        const status = ext.available ? sColor('installed') : muted('not installed');
        const category = muted(CATEGORY_LABELS[ext.category] || ext.category);

        lines.push(`  ${cursor} ${icon} ${ansiPadEnd(name, 28)} ${ansiPadEnd(category, 16)} ${status}`);
      }

      if (filtered.length > maxVisible) {
        lines.push(`  ${dim(`... ${this.scrollOffset + 1}-${end} of ${filtered.length}`)}`);
      }
    }

    lines.push('');
    const hint = this.searchMode
      ? `${dim(upDown)} navigate  ${dim(enter)} details  ${dim('?')} help  ${dim('esc')} exit search`
      : `${dim(upDown)} navigate  ${dim(enter)} details  ${dim('/')} search  ${dim('?')} help  ${dim('esc')} back`;
    lines.push(`  ${hint}`);

    const framed = wrapInFrame(lines, cols, 'EXTENSIONS');

    const stamped = this.modal
      ? stampOverlay({
          screenLines: framed,
          overlayLines: renderOverlayBox({
            title: this.modal.title,
            width: this.modalWidth(cols),
            lines: this.modal.lines,
          }),
          cols,
          rows,
        })
      : framed;

    this.screen.render(stamped.join('\n'));
  }

  private move(delta: number): void {
    const filtered = this.getFilteredExtensions();
    this.cursor = Math.max(0, Math.min(Math.max(0, filtered.length - 1), this.cursor + delta));
    this.render();
  }

  private back(): void {
    this.keys.pop();
    this.onBack();
  }

  private enterSearch(): void {
    this.searchMode = true;
    this.filter = '';
    this.cursor = 0;
    this.scrollOffset = 0;
    this.render();
  }

  private exitSearch(): void {
    this.searchMode = false;
    this.filter = '';
    this.cursor = 0;
    this.scrollOffset = 0;
    this.render();
  }

  private getFilteredExtensions(): ExtEntry[] {
    const q = this.filter.trim().toLowerCase();
    if (!q) return this.extensions;
    return this.extensions.filter((e) => {
      const hay = `${e.name} ${e.displayName} ${e.category}`.toLowerCase();
      return hay.includes(q);
    });
  }

  private openDetails(): void {
    const g = glyphs();
    const filtered = this.getFilteredExtensions();
    const ext = filtered[this.cursor];
    if (!ext) return;

    const status = ext.available ? sColor(`installed ${g.ok}`) : muted('not installed');
    const cat = CATEGORY_LABELS[ext.category] || ext.category;

    this.modal = {
      title: 'Extension Details',
      lines: [
        `${muted('Name:')} ${bright(ext.displayName)}`,
        `${muted('ID:')}   ${accent(ext.name)}`,
        `${muted('Type:')} ${dim(cat)}`,
        `${muted('Stat:')} ${status}`,
        '',
        `${muted('CLI:')} ${accent(`wunderland extensions info ${ext.name}`)}`,
        `${muted('Enable:')} ${accent(`wunderland extensions enable ${ext.name}`)}`,
        `${muted('Disable:')} ${accent(`wunderland extensions disable ${ext.name}`)}`,
      ],
    };
    this.render();
  }

  private modalWidth(cols: number): number {
    return Math.min(Math.max(44, Math.min(74, cols - 8)), Math.max(24, cols - 4));
  }

  private maxVisibleRows(rows: number): number {
    const header = this.searchMode ? 6 : 4;
    const footer = 5; // 3 + 2 for frame borders
    return Math.max(5, rows - header - footer);
  }

  private clampScroll(totalItems: number, maxVisible: number): void {
    if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
    if (this.cursor >= this.scrollOffset + maxVisible) this.scrollOffset = this.cursor - maxVisible + 1;
    const maxOffset = Math.max(0, totalItems - maxVisible);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }

  private getHelpLines(): string[] {
    const ui = getUiRuntime();
    const upDown = ui.ascii ? 'Up/Down' : '↑/↓';
    const enter = ui.ascii ? 'Enter' : '⏎';
    return [
      `${bright('Navigation')}`,
      `${accent(upDown)} move  ${accent(enter)} details`,
      '',
      `${bright('Search')}`,
      `${accent('/')} start search  ${accent('esc')} exit search`,
      '',
      `${bright('Tips')}`,
      `${dim('-')} Search matches id, name, and category.`,
      `${dim('-')} Details shows the CLI commands to manage an extension.`,
    ];
  }

  dispose(): void {
    this.keys.pop();
  }
}
