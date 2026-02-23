/**
 * @fileoverview TUI drill-down view: browsable skill catalog.
 * @module wunderland/cli/tui/views/skills-view
 */

import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor, warn as wColor } from '../../ui/theme.js';
import { ansiPadEnd } from '../../ui/ansi-utils.js';
import { renderOverlayBox, stampOverlay } from '../widgets/overlay.js';
import { wrapInFrame } from '../layout.js';
import { glyphs } from '../../ui/glyphs.js';
import { getUiRuntime } from '../../ui/runtime.js';

interface SkillEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  verified: boolean;
}

export class SkillsView {
  private screen: Screen;
  private keys: KeybindingManager;
  private onBack: () => void;
  private cursor = 0;
  private skills: SkillEntry[] = [];
  private scrollOffset = 0;
  private searchMode = false;
  private filter = '';
  private modal: null | { title: string; lines: string[] } = null;

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;

    this.keys.push({
      name: 'skills-view',
      bindings: {
        '__text__': (key) => {
          if (this.modal) return true; // consume text so it doesn't fall through to dashboard
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
    // Load skills catalog
    try {
      const moduleName: string = '@framers/agentos-skills-registry';
      const registry: any = await import(moduleName);
      const catalog = await registry.getSkillsCatalog();
      this.skills = (catalog.skills.curated ?? []).map((s: any) => ({
        id: s.id, name: s.name, description: s.description,
        version: s.version, verified: s.verified ?? false,
      }));
    } catch {
      this.skills = [
        { id: 'web-search', name: 'Web Search', description: 'Search the web', version: '1.0.0', verified: true },
        { id: 'code-interpreter', name: 'Code Interpreter', description: 'Execute code', version: '1.0.0', verified: true },
        { id: 'memory', name: 'Memory', description: 'Persistent memory', version: '1.0.0', verified: true },
      ];
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

    const filtered = this.getFilteredSkills();
    if (this.cursor > filtered.length - 1) this.cursor = Math.max(0, filtered.length - 1);
    this.clampScroll(filtered.length, maxVisible);

    lines.push('');
    lines.push(`  ${accent(g.bullet)} ${bright('Skills Catalog')}  ${dim(`(${filtered.length}/${this.skills.length})`)}`);
    lines.push('');

    if (this.searchMode) {
      const q = this.filter.trim();
      const shown = q ? bright(q) : dim(`type to filter${g.ellipsis}`);
      lines.push(`  ${dim(g.search)} ${muted('Search:')} ${shown}  ${dim('(esc to exit)')}`);
      lines.push('');
    }

    if (filtered.length === 0) {
      const msg = this.filter.trim().length > 0 ? dim('No matches. Press esc to exit search.') : dim('No skills available.');
      lines.push(`  ${msg}`);
    } else {
      const start = this.scrollOffset;
      const end = Math.min(filtered.length, start + maxVisible);

      for (let i = start; i < end; i++) {
        const skill = filtered[i];
        const selected = i === this.cursor;
        const cursor = selected ? accent(g.cursor) : ' ';
        const verified = skill.verified ? sColor(g.ok) : muted(g.circle);
        const name = selected ? bright(skill.name) : skill.name;
        const ver = muted(skill.version);

        lines.push(`  ${cursor} ${verified} ${ansiPadEnd(name, 26)} ${ver}`);
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

    const framed = wrapInFrame(lines, cols, 'SKILLS');

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
    const filtered = this.getFilteredSkills();
    this.cursor = Math.max(0, Math.min(Math.max(0, filtered.length - 1), this.cursor + delta));
    this.render();
  }

  private openDetails(): void {
    const g = glyphs();
    const filtered = this.getFilteredSkills();
    const skill = filtered[this.cursor];
    if (!skill) return;

    const { cols } = this.screen.getSize();
    const inner = Math.max(0, this.modalWidth(cols) - 2);

    const desc = wrapText(skill.description, Math.max(20, inner - 4));
    const verified = skill.verified ? sColor(`${g.ok} verified`) : wColor(`${g.circle} unverified`);

    this.modal = {
      title: 'Skill Details',
      lines: [
        `${muted('Name:')} ${bright(skill.name)}`,
        `${muted('ID:')}   ${accent(skill.id)}`,
        `${muted('Ver:')}  ${dim(skill.version)}  ${verified}`,
        '',
        `${muted('About:')}`,
        ...desc.map((l) => `  ${dim(l)}`),
        '',
        `${muted('CLI:')} ${accent(`wunderland skills info ${skill.id}`)}`,
      ],
    };
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

  private getFilteredSkills(): SkillEntry[] {
    const q = this.filter.trim().toLowerCase();
    if (!q) return this.skills;
    return this.skills.filter((s) => {
      const hay = `${s.id} ${s.name} ${s.description}`.toLowerCase();
      return hay.includes(q);
    });
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
      `${dim('-')} Search matches id, name, and description.`,
      `${dim('-')} Details shows the CLI command to inspect a skill.`,
    ];
  }

  dispose(): void {
    this.keys.pop();
  }
}

function wrapText(text: string, width: number): string[] {
  const w = Math.max(8, width);
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return ['(no description)'];

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
