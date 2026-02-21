/**
 * @fileoverview TUI drill-down view: RAG query + results browser.
 * @module wunderland/cli/tui/views/rag-view
 */

import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, info as iColor } from '../../ui/theme.js';

export class RagView {
  private screen: Screen;
  private keys: KeybindingManager;
  private onBack: () => void;
  private query = '';
  private results: Array<{ score: number; text: string; source: string }> = [];
  private cursor = 0;
  private inputMode = true;

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;

    this.keys.push({
      name: 'rag-view',
      bindings: {
        'escape': () => {
          if (this.inputMode) { this.back(); }
          else { this.inputMode = true; this.render(); }
        },
        'backspace': () => {
          if (this.inputMode && this.query.length > 0) {
            this.query = this.query.slice(0, -1);
            this.render();
          } else if (!this.inputMode) {
            this.back();
          }
        },
        'return': () => {
          if (this.inputMode && this.query.length > 0) {
            this.search();
          }
        },
        'up': () => {
          if (!this.inputMode) { this.move(-1); }
        },
        'down': () => {
          if (!this.inputMode) { this.move(1); }
        },
        'q': () => {
          if (!this.inputMode) { this.back(); }
        },
      },
    });
  }

  async run(): Promise<void> {
    this.render();
  }

  private render(): void {
    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${accent('◆')} ${bright('RAG Memory Query')}`);
    lines.push('');

    // Query input
    const cursorChar = this.inputMode ? accent('▌') : '';
    lines.push(`  ${iColor('◇')} Query: ${bright(this.query)}${cursorChar}`);
    lines.push('');

    if (this.results.length > 0) {
      lines.push(`  ${iColor('◇')} ${bright('Results')}  ${dim(`(${this.results.length} matches)`)}`);
      lines.push(`  ${dim('─'.repeat(60))}`);

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
      ? `${dim('type to search')}  ${dim('⏎')} search  ${dim('esc')} back`
      : `${dim('↑↓')} navigate  ${dim('esc')} edit query  ${dim('q')} back`;
    lines.push(`  ${hints}`);

    this.screen.render(lines.join('\n'));
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
    const filled = Math.round(score * width);
    const bar = accent('█'.repeat(filled)) + dim('░'.repeat(width - filled));
    return `${bar} ${muted((score * 100).toFixed(0) + '%')}`;
  }

  private move(delta: number): void {
    this.cursor = Math.max(0, Math.min(this.results.length - 1, this.cursor + delta));
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
