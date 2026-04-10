// @ts-nocheck
/**
 * @fileoverview TUI drill-down view: extension catalog browser.
 * @module wunderland/cli/tui/views/extensions-view
 */

import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor, warn as wColor } from '../../ui/theme.js';
import { ansiPadEnd } from '../../ui/ansi-utils.js';
import { renderOverlayBox, stampOverlay } from '../widgets/overlay.js';
import { wrapInFrame } from '../layout.js';
import { glyphs } from '../../ui/glyphs.js';
import { getUiRuntime } from '../../ui/runtime.js';
import { filterSearch } from '../../utils/search-scoring.js';

interface ExtEntry {
  name: string;
  displayName: string;
  category: string;
  available: boolean;
  /** Whether the extension is enabled in agent.config.json. */
  enabled: boolean;
  /** Secret IDs required by this extension (e.g. 'openai.apiKey'). */
  requiredSecrets: string[];
  /** Whether all required API keys are present in the environment. */
  secretsConfigured: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  tool: 'Tools', channel: 'Channels', voice: 'Voice', productivity: 'Productivity',
  integration: 'Integrations',
};

export class ExtensionsView {
  private screen: Screen;
  private keys: KeybindingManager;
  private onBack: () => void;
  private configDir?: string;
  private cursor = 0;
  private extensions: ExtEntry[] = [];
  private scrollOffset = 0;
  private searchMode = false;
  private filter = '';
  private modal: null | { title: string; lines: string[] } = null;

  constructor(opts: { screen: Screen; keys: KeybindingManager; configDir?: string; onBack: () => void }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.configDir = opts.configDir;
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
        'e': () => {
          if (this.modal || this.searchMode) return true;
          this.toggleExtension().catch(() => {});
          return true;
        },
        'q': () => { if (this.modal) { this.modal = null; this.render(); return true; } if (this.searchMode) return false; this.back(); return true; },
      },
    });
  }

  async run(): Promise<void> {
    try {
      const registry = await import('@framers/agentos-extensions-registry');
      const { loadConfig } = await import('../../config/config-manager.js');
      const config = await loadConfig(this.configDir);
      const enabledTools = ((config?.extensions as any)?.tools as string[]) ?? [];

      const exts = await registry.getAvailableExtensions();
      this.extensions = exts.map((e: any) => ({
        name: e.name,
        displayName: e.displayName,
        category: e.category,
        available: e.available,
        enabled: enabledTools.includes(e.name),
        requiredSecrets: e.requiredSecrets ?? [],
        secretsConfigured: (e.requiredSecrets ?? []).every(
          (s: string) => {
            const mapping = registry.SECRET_ENV_MAP?.[s];
            return mapping ? !!process.env[mapping.envVar] : false;
          },
        ),
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
        const icon = ext.enabled
          ? sColor(g.ok)
          : ext.available
            ? wColor(g.circle)
            : muted(g.circle);
        const name = selected ? bright(ext.displayName) : ext.displayName;
        const status = ext.enabled
          ? sColor('enabled')
          : ext.available
            ? wColor('disabled')
            : muted('not installed');
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
      : `${dim(upDown)} navigate  ${dim(enter)} details  ${dim('e')} enable/disable  ${dim('/')} search  ${dim('?')} help  ${dim('esc')} back`;
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
    this.dispose();
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
    const q = this.filter.trim();
    if (!q) return this.extensions;
    return filterSearch(this.extensions, q);
  }

  /**
   * Toggle the currently-selected extension between enabled and disabled.
   * Persists the change to the user's config.json immediately.
   */
  private async toggleExtension(): Promise<void> {
    const ext = this.getFilteredExtensions()[this.cursor];
    if (!ext) return;

    try {
      const { loadConfig, updateConfig } = await import('../../config/config-manager.js');
      const config = await loadConfig(this.configDir);
      const currentTools = ((config?.extensions as any)?.tools as string[]) ?? [];
      const tools = currentTools.slice();

      if (ext.enabled) {
        const idx = tools.indexOf(ext.name);
        if (idx >= 0) tools.splice(idx, 1);
        ext.enabled = false;
      } else {
        if (!tools.includes(ext.name)) tools.push(ext.name);
        ext.enabled = true;
      }

      const extensions = { ...(config?.extensions as any ?? {}), tools };
      await updateConfig({ extensions }, this.configDir);
      this.render();
    } catch {
      // Config write failed — ignore
    }
  }

  private openDetails(): void {
    const g = glyphs();
    const ext = this.getFilteredExtensions()[this.cursor];
    if (!ext) return;

    const status = ext.enabled
      ? sColor(`enabled ${g.ok}`)
      : ext.available
        ? wColor('disabled')
        : muted('not installed');

    const lines = [
      `${muted('Name:')}   ${bright(ext.displayName)}`,
      `${muted('ID:')}     ${accent(ext.name)}`,
      `${muted('Type:')}   ${dim(CATEGORY_LABELS[ext.category] || ext.category)}`,
      `${muted('Status:')} ${status}`,
    ];

    if (ext.requiredSecrets.length > 0) {
      lines.push('');
      lines.push(`${muted('API Keys:')}`);
      for (const secret of ext.requiredSecrets) {
        const icon = ext.secretsConfigured ? sColor(g.ok) : wColor(g.circle);
        lines.push(`  ${icon} ${dim(secret)}`);
      }
    }

    lines.push('');
    lines.push(`${dim('e')} ${ext.enabled ? 'disable' : 'enable'}  ${dim('esc')} close`);

    this.modal = { title: 'Extension Details', lines };
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
      `${accent(upDown)} move  ${accent(enter)} details  ${accent('/')} search`,
      '',
      `${bright('Actions')}`,
      `${accent('e')} enable/disable extension`,
      '',
      `${bright('Status')}`,
      `${dim('-')} Green = enabled, Yellow = available but disabled`,
      `${dim('-')} API keys are read from environment/.env files.`,
    ];
  }

  private disposed = false;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.keys.pop();
  }
}
