/**
 * @fileoverview TUI drill-down view: browsable skill catalog.
 * @module wunderland/cli/tui/views/skills-view
 */

import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor } from '../../ui/theme.js';

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
  private expanded = -1;
  private scrollOffset = 0;

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;

    this.keys.push({
      name: 'skills-view',
      bindings: {
        'up': () => { this.move(-1); },
        'down': () => { this.move(1); },
        'k': () => { this.move(-1); },
        'j': () => { this.move(1); },
        'return': () => { this.toggle(); },
        'escape': () => { this.back(); },
        'backspace': () => { this.back(); },
        'q': () => { this.back(); },
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
    const { rows } = this.screen.getSize();
    const maxVisible = Math.max(5, rows - 8);
    const lines: string[] = [];

    lines.push('');
    lines.push(`  ${accent('◆')} ${bright('Skills Catalog')}  ${dim(`(${this.skills.length} skills)`)}`);
    lines.push('');

    const start = this.scrollOffset;
    const end = Math.min(this.skills.length, start + maxVisible);

    for (let i = start; i < end; i++) {
      const skill = this.skills[i];
      const selected = i === this.cursor;
      const cursor = selected ? accent('>') : ' ';
      const verified = skill.verified ? sColor('✓') : muted('○');
      const name = selected ? bright(skill.name) : skill.name;
      const id = accent(skill.id);

      lines.push(`  ${cursor} ${verified} ${name.padEnd(24)} ${muted(skill.version)}`);

      if (i === this.expanded) {
        lines.push(`      ${muted('ID:')} ${id}`);
        lines.push(`      ${muted('Description:')} ${dim(skill.description)}`);
        lines.push('');
      }
    }

    if (this.skills.length > maxVisible) {
      lines.push(`  ${dim(`... ${this.scrollOffset + 1}-${end} of ${this.skills.length}`)}`);
    }

    lines.push('');
    lines.push(`  ${dim('↑↓')} navigate  ${dim('⏎')} expand  ${dim('esc')} back`);

    this.screen.render(lines.join('\n'));
  }

  private move(delta: number): void {
    this.cursor = Math.max(0, Math.min(this.skills.length - 1, this.cursor + delta));
    const { rows } = this.screen.getSize();
    const maxVisible = Math.max(5, rows - 8);
    if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
    if (this.cursor >= this.scrollOffset + maxVisible) this.scrollOffset = this.cursor - maxVisible + 1;
    this.render();
  }

  private toggle(): void {
    this.expanded = this.expanded === this.cursor ? -1 : this.cursor;
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
