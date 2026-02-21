/**
 * @fileoverview TUI home screen with status summary and quick action menu.
 * @module wunderland/cli/tui/dashboard
 */

import type { Screen } from './screen.js';
import type { KeybindingManager } from './keybindings.js';
import { truncate } from './layout.js';
import { accent, dim, muted, bright, success as sColor, info as iColor } from '../ui/theme.js';
import { VERSION } from '../constants.js';
import { loadConfig } from '../config/config-manager.js';
import { checkEnvSecrets } from '../config/secrets.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface QuickAction {
  label: string;
  description: string;
  command: string;
}

// ── Quick Actions ──────────────────────────────────────────────────────────

const ACTIONS: QuickAction[] = [
  { label: 'Start agent server', description: 'wunderland start', command: 'start' },
  { label: 'Open chat', description: 'wunderland chat', command: 'chat' },
  { label: 'Run health check', description: 'wunderland doctor', command: 'doctor' },
  { label: 'Browse skills', description: 'wunderland skills list', command: 'skills' },
  { label: 'Browse extensions', description: 'wunderland extensions list', command: 'extensions' },
  { label: 'View models', description: 'wunderland models', command: 'models' },
  { label: 'Query RAG memory', description: 'wunderland rag query', command: 'rag' },
  { label: 'Configure settings', description: 'wunderland setup', command: 'setup' },
  { label: 'View status', description: 'wunderland status', command: 'status' },
];

// ── Dashboard ──────────────────────────────────────────────────────────────

export class Dashboard {
  private cursor = 0;
  private screen: Screen;
  private keys: KeybindingManager;
  private onSelect: (command: string) => void;
  private onQuit: () => void;

  constructor(opts: {
    screen: Screen;
    keys: KeybindingManager;
    onSelect: (command: string) => void;
    onQuit: () => void;
  }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onSelect = opts.onSelect;
    this.onQuit = opts.onQuit;

    this.keys.push({
      name: 'dashboard',
      bindings: {
        'up': () => { this.moveCursor(-1); },
        'down': () => { this.moveCursor(1); },
        'k': () => { this.moveCursor(-1); },
        'j': () => { this.moveCursor(1); },
        'return': () => { this.selectCurrent(); },
        'q': () => { this.onQuit(); },
        'ctrl+c': () => { this.onQuit(); },
        'escape': () => { this.onQuit(); },
      },
    });
  }

  async render(): Promise<void> {
    const { cols } = this.screen.getSize();
    const lines: string[] = [];

    // Load status info
    let agentName = 'not configured';
    let llmInfo = 'not configured';
    try {
      const config = await loadConfig();
      if (config.agentName) agentName = config.agentName;
      if (config.llmProvider && config.llmModel) {
        llmInfo = `${config.llmProvider} / ${config.llmModel}`;
      } else if (config.llmProvider) {
        llmInfo = config.llmProvider;
      }
    } catch {}

    // Check key status
    const secrets = checkEnvSecrets();
    const openaiSet = secrets.find((s) => s.id === 'openai.apiKey')?.isSet ?? false;
    const anthropicSet = secrets.find((s) => s.id === 'anthropic.apiKey')?.isSet ?? false;

    // ── Header ─────────────────────────────────────────────────────────
    const headerWidth = Math.min(cols - 4, 72);
    lines.push('');
    lines.push(`  ${accent('┌')}${accent('─'.repeat(headerWidth - 2))}${accent('┐')}`);
    lines.push(`  ${accent('│')} ${bright(`WUNDERLAND v${VERSION}`)}${' '.repeat(Math.max(0, headerWidth - 22 - VERSION.length))}${accent('│')}`);
    lines.push(`  ${accent('│')}${' '.repeat(headerWidth - 2)}${accent('│')}`);
    lines.push(`  ${accent('│')}  ${accent('◆')} Agent: ${muted(truncate(agentName, 20))}     ${accent('◆')} LLM: ${muted(truncate(llmInfo, 24))}${' '.repeat(Math.max(0, headerWidth - 62 - agentName.slice(0, 20).length))}${accent('│')}`);
    lines.push(`  ${accent('└')}${accent('─'.repeat(headerWidth - 2))}${accent('┘')}`);
    lines.push('');

    // ── Health Summary ─────────────────────────────────────────────────
    const healthItems = [
      openaiSet ? `${sColor('✓')} OpenAI key` : `${muted('○')} OpenAI key`,
      anthropicSet ? `${sColor('✓')} Anthropic key` : `${muted('○')} Anthropic key`,
    ];
    lines.push(`  ${iColor('◇')} ${bright('Health')}  ${healthItems.join('  ')}`);
    lines.push('');

    // ── Quick Actions ──────────────────────────────────────────────────
    lines.push(`  ${iColor('◇')} ${bright('Quick Actions')}`);
    lines.push(`  ${dim('─'.repeat(Math.min(cols - 4, 68)))}`);

    for (let i = 0; i < ACTIONS.length; i++) {
      const action = ACTIONS[i];
      const selected = i === this.cursor;
      const cursor = selected ? accent('>') : ' ';
      const label = selected ? bright(action.label) : action.label;
      const hint = selected ? dim(`[enter] ${action.description}`) : '';
      lines.push(`  ${cursor} ${label}${hint ? '  ' + hint : ''}`);
    }

    lines.push('');
    lines.push(`  ${dim('─'.repeat(Math.min(cols - 4, 68)))}`);
    lines.push(`  ${dim('↑↓')} navigate  ${dim('⏎')} select  ${dim('q')} quit`);
    lines.push('');

    this.screen.render(lines.join('\n'));
  }

  private moveCursor(delta: number): void {
    this.cursor = Math.max(0, Math.min(ACTIONS.length - 1, this.cursor + delta));
    this.render();
  }

  private selectCurrent(): void {
    const action = ACTIONS[this.cursor];
    if (action) {
      this.onSelect(action.command);
    }
  }

  dispose(): void {
    this.keys.pop();
  }
}
