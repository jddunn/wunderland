/**
 * @fileoverview TUI drill-down view: RAG query + results browser.
 * @module wunderland/cli/tui/views/rag-view
 */

import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, info as iColor } from '../../ui/theme.js';
import { renderOverlayBox, stampOverlay } from '../widgets/overlay.js';
import { wrapInFrame } from '../layout.js';
import { glyphs } from '../../ui/glyphs.js';
import { getUiRuntime } from '../../ui/runtime.js';

export class RagView {
  private screen: Screen;
  private keys: KeybindingManager;
  private onBack: () => void;
  private query = '';
  private results: Array<{ score: number; text: string; source: string }> = [];
  private cursor = 0;
  private inputMode = true;
  private modal: null | { title: string; lines: string[] } = null;

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;

    this.keys.push({
      name: 'rag-view',
      bindings: {
        '__text__': (key) => {
          if (this.modal) return true;
          if (!this.inputMode) return true;
          this.query += key.sequence;
          this.render();
          return true;
        },
        '?': () => {
          if (this.modal?.title === 'Help') { this.modal = null; this.render(); return; }
          if (this.modal) return;
          this.modal = { title: 'Help', lines: this.getHelpLines() };
          this.render();
        },
        'escape': () => {
          if (this.modal) { this.modal = null; this.render(); return; }
          if (this.inputMode) { this.back(); }
          else { this.inputMode = true; this.render(); }
        },
        'backspace': () => {
          if (this.modal) { this.modal = null; this.render(); return; }
          if (this.inputMode && this.query.length > 0) {
            this.query = this.query.slice(0, -1);
            this.render();
          } else if (!this.inputMode) {
            this.back();
          }
        },
        'return': () => {
          if (this.modal) { this.modal = null; this.render(); return; }
          if (this.inputMode && this.query.length > 0) {
            this.search();
            return;
          }
          if (!this.inputMode && this.results.length > 0) {
            this.openResultDetails();
          }
        },
        'up': () => {
          if (this.modal) return;
          if (!this.inputMode) { this.move(-1); }
        },
        'down': () => {
          if (this.modal) return;
          if (!this.inputMode) { this.move(1); }
        },
        'q': () => {
          if (this.modal) { this.modal = null; this.render(); return true; }
          if (this.inputMode) return false; // allow typing "q" into the query
          this.back();
          return true;
        },
      },
    });
  }

  async run(): Promise<void> {
    this.render();
  }

  private render(): void {
    const g = glyphs();
    const ui = getUiRuntime();
    const upDown = ui.ascii ? 'Up/Down' : '↑/↓';
    const enter = ui.ascii ? 'Enter' : '⏎';
    const { rows, cols } = this.screen.getSize();
    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${accent(g.bullet)} ${bright('RAG Memory Query')}`);
    lines.push('');

    // Query input
    const cursorChar = this.inputMode ? accent(ui.ascii ? '|' : '▌') : '';
    lines.push(`  ${iColor(g.bulletHollow)} Query: ${bright(this.query)}${cursorChar}`);
    lines.push('');

    if (this.results.length > 0) {
      lines.push(`  ${iColor(g.bulletHollow)} ${bright('Results')}  ${dim(`(${this.results.length} matches)`)}`);
      lines.push(`  ${dim(g.hr.repeat(60))}`);

      for (let i = 0; i < this.results.length; i++) {
        const r = this.results[i];
        const selected = !this.inputMode && i === this.cursor;
        const cursor = selected ? accent('>') : ' ';
        const scoreBar = this.scoreBar(r.score, 10);
        const text = r.text.length > 60 ? r.text.slice(0, 57) + '...' : r.text;
        lines.push(`  ${cursor} ${scoreBar} ${muted(r.source.padEnd(20))} ${dim(text)}`);
      }
    } else if (this.query.length > 0 && !this.inputMode) {
      lines.push(`  ${muted('No results found.')}`);
    } else {
      lines.push(`  ${dim('Type a query and press Enter to search RAG memory.')}`);
      lines.push(`  ${dim('Note: Requires backend to be running (wunderland start).')}`);
    }

    lines.push('');
    const hints = this.inputMode
      ? `${dim('type')}  ${dim(enter)} search  ${dim('?')} help  ${dim('esc')} back`
      : `${dim(upDown)} navigate  ${dim(enter)} details  ${dim('?')} help  ${dim('esc')} edit  ${dim('q')} back`;
    lines.push(`  ${hints}`);

    const framed = wrapInFrame(lines, cols, 'RAG MEMORY');

    const stamped = this.modal
      ? stampOverlay({
          screenLines: framed,
          overlayLines: renderOverlayBox({
            title: this.modal.title,
            width: Math.min(Math.max(44, Math.min(74, cols - 8)), Math.max(24, cols - 4)),
            lines: this.modal.lines,
          }),
          cols,
          rows,
        })
      : framed;

    this.screen.render(stamped.join('\n'));
  }

  private async search(): Promise<void> {
    this.inputMode = false;
    this.results = [];
    this.cursor = 0;

    try {
      const res = await fetch(`http://localhost:3001/api/rag/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: this.query, limit: 10 }),
      });
      if (res.ok) {
        const data = await res.json() as any;
        this.results = (data.results || []).map((r: any) => ({
          score: r.score ?? r.similarity ?? 0,
          text: r.text || r.content || '',
          source: r.source || r.collection || 'unknown',
        }));
      }
    } catch {
      // Backend not reachable
    }

    this.render();
  }

  private scoreBar(score: number, width: number): string {
    const ui = getUiRuntime();
    const filled = Math.round(score * width);
    const bar = ui.ascii
      ? accent('#'.repeat(filled)) + dim('.'.repeat(width - filled))
      : accent('█'.repeat(filled)) + dim('░'.repeat(width - filled));
    return `${bar} ${muted((score * 100).toFixed(0) + '%')}`;
  }

  private move(delta: number): void {
    this.cursor = Math.max(0, Math.min(this.results.length - 1, this.cursor + delta));
    this.render();
  }

  private openResultDetails(): void {
    const r = this.results[this.cursor];
    if (!r) return;

    const { cols } = this.screen.getSize();
    const width = Math.min(Math.max(44, Math.min(74, cols - 8)), Math.max(24, cols - 4));
    const inner = Math.max(0, width - 2);
    const body = wrapText(r.text, Math.max(20, inner - 2));

    this.modal = {
      title: 'Result',
      lines: [
        `${muted('Score:')} ${dim((r.score * 100).toFixed(0) + '%')}`,
        `${muted('Source:')} ${bright(r.source)}`,
        '',
        ...body.map((l) => dim(l)),
      ],
    };
    this.render();
  }

  private getHelpLines(): string[] {
    const ui = getUiRuntime();
    const upDown = ui.ascii ? 'Up/Down' : '↑/↓';
    const enter = ui.ascii ? 'Enter' : '⏎';
    return [
      `${bright('Query')}`,
      `${accent('type')} enter a query  ${accent(enter)} search`,
      '',
      `${bright('Results')}`,
      `${accent(upDown)} move  ${accent(enter)} details  ${accent('esc')} edit query`,
      '',
      `${bright('Notes')}`,
      `${dim('-')} Requires the backend running: ${accent('wunderland start')}`,
      `${dim('-')} Press ${accent('?')} again or ${accent('esc')} to close this overlay.`,
    ];
  }

  private back(): void {
    this.keys.pop();
    this.onBack();
  }

  dispose(): void {
    this.keys.pop();
  }
}

function wrapText(text: string, width: number): string[] {
  const w = Math.max(8, width);
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return ['(empty)'];

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
