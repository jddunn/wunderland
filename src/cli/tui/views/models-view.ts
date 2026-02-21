/**
 * @fileoverview TUI drill-down view: interactive LLM provider browser.
 * @module wunderland/cli/tui/views/models-view
 */

import type { Screen } from '../screen.js';
import type { KeybindingManager } from '../keybindings.js';
import { accent, dim, muted, bright, success as sColor } from '../../ui/theme.js';
import { LLM_PROVIDERS } from '../../constants.js';
import { loadDotEnvIntoProcessUpward } from '../../config/env-manager.js';

export class ModelsView {
  private screen: Screen;
  private keys: KeybindingManager;
  private onBack: () => void;
  private cursor = 0;
  private expanded = -1;

  constructor(opts: { screen: Screen; keys: KeybindingManager; onBack: () => void }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onBack = opts.onBack;

    this.keys.push({
      name: 'models-view',
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
    await loadDotEnvIntoProcessUpward({ startDir: process.cwd() });
    this.render();
  }

  private render(): void {
    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${accent('◆')} ${bright('LLM Providers & Models')}`);
    lines.push('');

    for (let i = 0; i < LLM_PROVIDERS.length; i++) {
      const provider = LLM_PROVIDERS[i];
      const envSet = provider.envVar ? !!process.env[provider.envVar] : true;
      const statusIcon = envSet ? sColor('✓') : muted('○');
      const selected = i === this.cursor;
      const cursor = selected ? accent('>') : ' ';
      const label = selected ? bright(provider.label) : provider.label;
      const id = accent(provider.id);

      lines.push(`  ${cursor} ${statusIcon} ${id.padEnd(30)} ${label}`);

      if (i === this.expanded) {
        const envHint = provider.envVar
          ? (envSet ? sColor('configured') : muted('not set'))
          : muted('no key needed');
        lines.push(`      ${muted('Key:')} ${envHint}${provider.envVar ? dim(` (${provider.envVar})`) : ''}`);
        lines.push(`      ${muted('Models:')} ${provider.models.map((m) => dim(m)).join(', ')}`);
        if (provider.docsUrl) lines.push(`      ${muted('Docs:')} ${dim(provider.docsUrl)}`);
        lines.push('');
      }
    }

    lines.push('');
    lines.push(`  ${dim('↑↓')} navigate  ${dim('⏎')} expand/collapse  ${dim('esc')} back`);

    this.screen.render(lines.join('\n'));
  }

  private move(delta: number): void {
    this.cursor = Math.max(0, Math.min(LLM_PROVIDERS.length - 1, this.cursor + delta));
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
