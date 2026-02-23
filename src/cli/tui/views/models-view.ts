/**
 * @fileoverview TUI drill-down view: interactive LLM provider browser.
 * @module wunderland/cli/tui/views/models-view
 */

import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor, warn as wColor } from '../../ui/theme.js';
import { ansiPadEnd } from '../../ui/ansi-utils.js';
import { renderOverlayBox, stampOverlay } from '../widgets/overlay.js';
import { LLM_PROVIDERS } from '../../constants.js';
import { loadDotEnvIntoProcessUpward } from '../../config/env-manager.js';
import { glyphs } from '../../ui/glyphs.js';
import { getUiRuntime } from '../../ui/runtime.js';

type Provider = (typeof LLM_PROVIDERS)[number];

export class ModelsView {
  private screen: Screen;
  private keys: KeybindingManager;
  private onBack: () => void;
  private configDir?: string;
  private cursor = 0;
  private scrollOffset = 0;
  private searchMode = false;
  private filter = '';
  private modal: null | { title: string; lines: string[] } = null;

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void; configDir?: string }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;
    this.configDir = opts.configDir;

    this.keys.push({
      name: 'models-view',
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
    await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: this.configDir });
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
    lines.push('');
    const filtered = this.getFilteredProviders();
    if (this.cursor > filtered.length - 1) this.cursor = Math.max(0, filtered.length - 1);
    this.clampScroll(filtered.length, maxVisible);

    lines.push(`  ${accent(g.bullet)} ${bright('LLM Providers & Models')}  ${dim(`(${filtered.length}/${LLM_PROVIDERS.length})`)}`);
    lines.push('');

    if (this.searchMode) {
      const q = this.filter.trim();
      const shown = q ? bright(q) : dim(`type to filter${g.ellipsis}`);
      lines.push(`  ${dim(g.search)} ${muted('Search:')} ${shown}  ${dim('(esc to exit)')}`);
      lines.push('');
    }

    if (filtered.length === 0) {
      const msg = this.filter.trim().length > 0 ? dim('No matches. Press esc to exit search.') : dim('No providers available.');
      lines.push(`  ${msg}`);
    } else {
      const start = this.scrollOffset;
      const end = Math.min(filtered.length, start + maxVisible);

      for (let i = start; i < end; i++) {
        const provider = filtered[i];
        const envSet = provider.envVar ? !!process.env[provider.envVar] : true;
        const statusIcon = envSet ? sColor(g.ok) : muted(g.circle);
        const selected = i === this.cursor;
        const cursor = selected ? accent(g.cursor) : ' ';
        const label = selected ? bright(provider.label) : provider.label;
        const id = accent(provider.id);
        const keyHint = provider.envVar ? dim(provider.envVar) : dim('no key');

        lines.push(`  ${cursor} ${statusIcon} ${ansiPadEnd(id, 18)} ${ansiPadEnd(label, 22)} ${keyHint}`);
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

    const stamped = this.modal
      ? stampOverlay({
          screenLines: lines,
          overlayLines: renderOverlayBox({
            title: this.modal.title,
            width: this.modalWidth(cols),
            lines: this.modal.lines,
          }),
          cols,
          rows,
        })
      : lines;

    this.screen.render(stamped.join('\n'));
  }

  private move(delta: number): void {
    const filtered = this.getFilteredProviders();
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

  private getFilteredProviders(): Provider[] {
    const q = this.filter.trim().toLowerCase();
    if (!q) return [...LLM_PROVIDERS];
    return LLM_PROVIDERS.filter((p) => {
      const hay = `${p.id} ${p.label} ${p.envVar} ${(p.models || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }

  private openDetails(): void {
    const g = glyphs();
    const provider = this.getFilteredProviders()[this.cursor];
    if (!provider) return;

    const envSet = provider.envVar ? !!process.env[provider.envVar] : true;
    const envHint = provider.envVar
      ? (envSet ? sColor(`configured ${g.ok}`) : wColor(`not set ${g.circle}`))
      : muted('no key needed');

    const { cols } = this.screen.getSize();
    const inner = Math.max(0, this.modalWidth(cols) - 2);
    const modelLines = wrapText((provider.models || []).join(', '), Math.max(20, inner - 8));

    this.modal = {
      title: 'Provider Details',
      lines: [
        `${muted('Provider:')} ${bright(provider.label)}  ${dim(`(${provider.id})`)}`,
        `${muted('Key:')}      ${envHint}${provider.envVar ? dim(` (${provider.envVar})`) : ''}`,
        '',
        `${muted('Models:')}`,
        ...modelLines.map((l) => `  ${dim(l)}`),
        ...(provider.docsUrl ? ['', `${muted('Docs:')} ${dim(provider.docsUrl)}`] : []),
        '',
        `${muted('CLI:')} ${accent(`wunderland models test ${provider.id}`)}`,
      ],
    };
    this.render();
  }

  private modalWidth(cols: number): number {
    return Math.min(Math.max(44, Math.min(74, cols - 8)), Math.max(24, cols - 4));
  }

  private maxVisibleRows(rows: number): number {
    const header = this.searchMode ? 6 : 4;
    const footer = 3;
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
      `${bright('Notes')}`,
      `${dim('-')} Provider keys are read from your environment/.env.`,
      `${dim('-')} Use details to see model lists + docs links.`,
    ];
  }

  dispose(): void {
    this.keys.pop();
  }
}

function wrapText(text: string, width: number): string[] {
  const w = Math.max(8, width);
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return ['(none)'];

  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) {
      line = word;
      continue;
    }
    if ((line + ' ' + word).length <= w) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}
