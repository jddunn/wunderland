/**
 * @fileoverview Cyberpunk TUI home screen with solid-framed panels,
 * animated scan line intro, scroll support, and keyboard-driven quick actions.
 * @module wunderland/cli/tui/dashboard
 */

import chalk from 'chalk';
import type { Screen } from './screen.js';
import type { KeybindingManager } from './keybindings.js';
import { truncate, composeSideBySide } from './layout.js';
import {
  success as sColor,
} from '../ui/theme.js';
import { stripAnsi, sliceAnsi, visibleLength, ansiPadEnd } from '../ui/ansi-utils.js';
import { VERSION, URLS } from '../constants.js';
import { loadConfig } from '../config/config-manager.js';
import { checkEnvSecrets } from '../config/secrets.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface QuickAction {
  label: string;
  command: string;
  hint: string;
  shortcut?: string;
}

interface DashboardState {
  agentName: string;
  llmInfo: string;
  channelCount: number;
  keys: { label: string; isSet: boolean }[];
}

// ── Color Palette (hex values for chalk.hex) ───────────────────────────────

const C = {
  purple:     '#a855f7',
  lavender:   '#c084fc',
  magenta:    '#e879f9',
  fuchsia:    '#f0abfc',
  cyan:       '#06b6d4',
  brightCyan: '#22d3ee',
  lightCyan:  '#67e8f9',
  green:      '#22c55e',
  white:      '#f9fafb',
  text:       '#c9d1d9',
  muted:      '#6b7280',
  dim:        '#4b5563',
  dark:       '#374151',
  darker:     '#1f2937',
} as const;

// ── Solid Border Colors ──────────────────────────────────────────────────

const frameBorder  = chalk.hex(C.cyan);
const accentBorder = chalk.hex(C.lavender);

// ── Quick Actions ──────────────────────────────────────────────────────────

const ACTIONS: QuickAction[] = [
  { label: 'Start agent server',  command: 'start',      hint: 'wunderland start',      shortcut: '1' },
  { label: 'Open chat',           command: 'chat',       hint: 'wunderland chat',       shortcut: '2' },
  { label: 'Run health check',    command: 'doctor',     hint: 'wunderland doctor',     shortcut: 'd' },
  { label: 'Browse skills',       command: 'skills',     hint: 'wunderland skills',     shortcut: '3' },
  { label: 'Browse extensions',   command: 'extensions', hint: 'wunderland extensions', shortcut: '4' },
  { label: 'View models',         command: 'models',     hint: 'wunderland models',     shortcut: '5' },
  { label: 'Query RAG memory',    command: 'rag',        hint: 'wunderland rag',        shortcut: '6' },
  { label: 'Voice providers',     command: 'voice',      hint: 'wunderland voice',      shortcut: 'v' },
  { label: 'Configure settings',  command: 'setup',      hint: 'wunderland setup',      shortcut: '7' },
  { label: 'View status',         command: 'status',     hint: 'wunderland status',     shortcut: 's' },
];

// ── ASCII Banner ───────────────────────────────────────────────────────────

const ASCII_BANNER = [
  ' ██╗    ██╗██╗   ██╗███╗   ██╗██████╗ ███████╗██████╗ ██╗      █████╗ ███╗   ██╗██████╗ ',
  ' ██║    ██║██║   ██║████╗  ██║██╔══██╗██╔════╝██╔══██╗██║     ██╔══██╗████╗  ██║██╔══██╗',
  ' ██║ █╗ ██║██║   ██║██╔██╗ ██║██║  ██║█████╗  ██████╔╝██║     ███████║██╔██╗ ██║██║  ██║',
  ' ╚██╗╚█╗██╔╝╚██████╔╝██║╚████║██████╔╝███████╗██║  ██║███████╗██║  ██║██║╚████║██████╔╝',
  '  ╚═╝ ╚═╝    ╚═════╝ ╚═╝ ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝ ╚═══╝╚═════╝',
];

// ── Dashboard ──────────────────────────────────────────────────────────────

export class Dashboard {
  private cursor = 0;
  private scrollOffset = 0;
  private actionLineOffset = 0;
  private screen: Screen;
  private keys: KeybindingManager;
  private onSelect: (command: string) => void;
  private onQuit: () => void;
  private state: DashboardState = {
    agentName: 'not configured',
    llmInfo: 'not configured',
    channelCount: 0,
    keys: [],
  };
  private introPlayed = false;

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
        'up':      () => { this.moveCursor(-1); },
        'down':    () => { this.moveCursor(1); },
        'k':       () => { this.moveCursor(-1); },
        'j':       () => { this.moveCursor(1); },
        'return':  () => { this.selectCurrent(); },
        'q':       () => { this.onQuit(); },
        'ctrl+c':  () => { this.onQuit(); },
        'escape':  () => { this.onQuit(); },
        'd':       () => { this.onSelect('doctor'); },
        's':       () => { this.onSelect('status'); },
        'v':       () => { this.onSelect('voice'); },
        'r':       () => { this.refresh(); },
        '1':       () => { this.selectIndex(0); },
        '2':       () => { this.selectIndex(1); },
        '3':       () => { this.selectIndex(3); },
        '4':       () => { this.selectIndex(4); },
        '5':       () => { this.selectIndex(5); },
        '6':       () => { this.selectIndex(6); },
        '7':       () => { this.selectIndex(8); },
      },
    });
  }

  /** Pre-load config and secrets. Call once before first render. */
  async init(): Promise<void> {
    try {
      const config = await loadConfig();
      if (config.agentName) this.state.agentName = config.agentName;
      if (config.llmProvider && config.llmModel) {
        this.state.llmInfo = `${config.llmProvider} / ${config.llmModel}`;
      } else if (config.llmProvider) {
        this.state.llmInfo = config.llmProvider;
      }
    } catch { /* config not available */ }

    const secrets = checkEnvSecrets();
    const keyIds = [
      { id: 'openai.apiKey',     label: 'OpenAI' },
      { id: 'anthropic.apiKey',  label: 'Anthropic' },
      { id: 'openrouter.apiKey', label: 'OpenRouter' },
      { id: 'elevenlabs.apiKey', label: 'ElevenLabs' },
    ];
    this.state.keys = keyIds.map(({ id, label }) => ({
      label,
      isSet: secrets.find((s) => s.id === id)?.isSet ?? false,
    }));
  }

  /** Render dashboard with optional animated intro on first call. */
  async render(): Promise<void> {
    if (!this.introPlayed) {
      this.introPlayed = true;
      await this.playIntro();
    }
    this.renderDashboard();
  }

  // ── Animated Intro ────────────────────────────────────────────────────

  private async playIntro(): Promise<void> {
    let bannerLines: string[] = [];

    // Try cfonts first for premium chrome font
    try {
      const cfonts = await import('cfonts');
      const result = cfonts.default.render('WUNDERLAND', {
        font: 'chrome',
        gradient: [C.purple, C.lavender, C.brightCyan, C.cyan],
        transitionGradient: true,
        space: false,
      });
      if (result && typeof result === 'object' && 'string' in result && (result as any).string) {
        bannerLines = (result as any).string.split('\n');
      }
    } catch { /* cfonts unavailable */ }

    if (bannerLines.length === 0) {
      bannerLines = ASCII_BANNER.map((line) => accentBorder(line));
    }

    while (bannerLines.length > 0 && stripAnsi(bannerLines[bannerLines.length - 1]).trim() === '') {
      bannerLines.pop();
    }

    const { cols } = this.screen.getSize();
    const contentWidth = Math.max(cols - 4, 60);
    const innerWidth = contentWidth - 2;

    // Truncate banner lines to fit inside frame (innerWidth - 4 for padding)
    bannerLines = bannerLines.map((l) => {
      const vLen = visibleLength(l);
      if (vLen > innerWidth - 4) return sliceAnsi(l, 0, innerWidth - 4);
      return l;
    });

    this.screen.clear();

    const bL = frameBorder('║');
    const bR = frameBorder('║');

    // ── Phase 1: Scan line sweep ──────────────────────────────────────

    const scanLen = 14;
    const scanPattern = '░░░▒▒▒▓▓██▓▓▒▒';
    const totalSweep = contentWidth + scanLen + 10;
    const scanStepSize = 6;
    const scanDelay = 2;

    // Reserve 3 lines
    process.stdout.write('\n\n\n');

    for (let pos = -scanLen; pos <= totalSweep; pos += scanStepSize) {
      process.stdout.write('\x1b[3A');
      let line = '';
      for (let x = 0; x < contentWidth; x++) {
        const rel = x - pos;
        if (rel >= 0 && rel < scanLen) {
          const ch = scanPattern[rel] || ' ';
          const t = rel / scanLen;
          const color = t < 0.3 ? C.purple : t < 0.6 ? C.magenta : C.cyan;
          line += chalk.hex(color)(ch);
        } else if (x < pos) {
          line += ' ';
        } else {
          line += chalk.hex(C.darker)('░');
        }
      }
      process.stdout.write(`\r  ${line}\x1b[K\n`);
      process.stdout.write(`\r\x1b[K\n\r\x1b[K\n`);
      await sleep(scanDelay);
    }

    // Clear scan area
    process.stdout.write('\x1b[3A');
    for (let i = 0; i < 3; i++) process.stdout.write('\r\x1b[K\n');
    process.stdout.write('\x1b[3A');

    // ── Phase 2: Top border ───────────────────────────────────────────

    const topBorder = frameBorder('╔' + '═'.repeat(innerWidth) + '╗');
    process.stdout.write(`  ${topBorder}\n`);
    await sleep(15);

    // ── Phase 3: Banner typewriter ────────────────────────────────────

    const bannerPadded = bannerLines.length + 2; // +2 for top/bottom margin inside frame

    // Reserve space
    for (let i = 0; i < bannerPadded; i++) process.stdout.write('\n');

    const maxLen = Math.max(...bannerLines.map((l) => stripAnsi(l).length));
    const stepCols = 5;
    const typeDelay = 3;

    for (let col = 0; col <= maxLen; col += stepCols) {
      process.stdout.write(`\x1b[${bannerPadded}A`);
      // Top margin line
      process.stdout.write(`\r  ${bL}${' '.repeat(innerWidth)}${bR}\n`);
      for (const bLine of bannerLines) {
        const vis = sliceAnsi(bLine, 0, col);
        const vLen = visibleLength(vis);
        const pad = ' '.repeat(Math.max(0, innerWidth - 2 - vLen));
        process.stdout.write(`\r  ${bL} ${vis}${pad} ${bR}\x1b[K\n`);
      }
      // Bottom margin line
      process.stdout.write(`\r  ${bL}${' '.repeat(innerWidth)}${bR}\n`);
      await sleep(typeDelay);
    }

    // Final full render
    process.stdout.write(`\x1b[${bannerPadded}A`);
    process.stdout.write(`\r  ${bL}${' '.repeat(innerWidth)}${bR}\n`);
    for (const bLine of bannerLines) {
      const vLen = visibleLength(bLine);
      const pad = ' '.repeat(Math.max(0, innerWidth - 2 - vLen));
      process.stdout.write(`\r  ${bL} ${bLine}${pad} ${bR}\x1b[K\n`);
    }
    process.stdout.write(`\r  ${bL}${' '.repeat(innerWidth)}${bR}\n`);

    // ── Phase 4: Tagline + divider ────────────────────────────────────

    await sleep(50);

    const tagText = buildTagline(innerWidth - 2);
    const tagVLen = visibleLength(tagText);
    const tagPadL = Math.max(0, Math.floor((innerWidth - tagVLen) / 2));
    const tagPadR = Math.max(0, innerWidth - tagVLen - tagPadL);
    process.stdout.write(`  ${bL}${' '.repeat(tagPadL)}${tagText}${' '.repeat(tagPadR)}${bR}\n`);

    await sleep(30);

    const divHalf = Math.max(0, Math.floor((innerWidth - 5) / 2));
    const divRight = Math.max(0, innerWidth - divHalf - 5);
    const divStr = accentBorder('═'.repeat(divHalf)) + ' ' + chalk.hex(C.magenta)('<>') + ' ' + accentBorder('═'.repeat(divRight));
    process.stdout.write(`  ${frameBorder('╠')}${divStr}${frameBorder('╣')}\n`);

    await sleep(100);
  }

  // ── Static Dashboard Render ───────────────────────────────────────────

  private renderDashboard(): void {
    const { rows, cols } = this.screen.getSize();
    const contentLines: string[] = [];
    const contentWidth = Math.max(cols - 4, 60);
    const innerWidth = contentWidth - 2;

    const bL = frameBorder('║');
    const bR = frameBorder('║');

    // Frame a content line inside the outer border (truncates if too wide)
    const frameLine = (content: string): string => {
      const vLen = visibleLength(content);
      if (vLen > innerWidth) {
        // Truncate to fit
        const trimmed = sliceAnsi(content, 0, innerWidth);
        return `  ${bL}${trimmed}${bR}`;
      }
      const pad = Math.max(0, innerWidth - vLen);
      return `  ${bL}${content}${' '.repeat(pad)}${bR}`;
    };
    const emptyFrame = (): string => frameLine(' '.repeat(innerWidth));

    // ═══ Top Border ═══════════════════════════════════════════════════
    contentLines.push(`  ${frameBorder('╔')}${frameBorder('═'.repeat(innerWidth))}${frameBorder('╗')}`);

    // ═══ Banner ═══════════════════════════════════════════════════════
    let bannerLines: string[] = ASCII_BANNER.map((l) => accentBorder(l));
    bannerLines = bannerLines.map((l) => {
      const vLen = visibleLength(l);
      if (vLen > innerWidth - 4) return sliceAnsi(l, 0, innerWidth - 4);
      return l;
    });

    contentLines.push(emptyFrame());
    for (const bl of bannerLines) {
      const vLen = visibleLength(bl);
      const padR = Math.max(0, innerWidth - 2 - vLen);
      contentLines.push(frameLine(` ${bl}${' '.repeat(padR)} `));
    }
    contentLines.push(emptyFrame());

    // ═══ Tagline (centered, width-adaptive) ═════════════════════════
    const tagText = buildTagline(innerWidth - 2);
    const tagVLen = visibleLength(tagText);
    const tagPadL = Math.max(0, Math.floor((innerWidth - tagVLen) / 2));
    contentLines.push(frameLine(`${' '.repeat(tagPadL)}${tagText}`));

    // ═══ Art Deco Divider ═════════════════════════════════════════════
    // " <> " = 4 visible chars, so dashes fill innerWidth - 4
    const divDeco = ` ${chalk.hex(C.magenta)('<>')} `;
    const divDecoVis = 4;
    const divHalfL = Math.max(0, Math.floor((innerWidth - divDecoVis) / 2));
    const divHalfR = Math.max(0, innerWidth - divDecoVis - divHalfL);
    const divContent = accentBorder('═'.repeat(divHalfL)) + divDeco + accentBorder('═'.repeat(divHalfR));
    contentLines.push(frameLine(divContent));

    // ═══ Status Panels ════════════════════════════════════════════════
    contentLines.push(emptyFrame());

    const pBdr = chalk.hex(C.lavender);
    const pTitleColor = chalk.hex(C.magenta).bold;

    // Decide layout: side-by-side if innerWidth >= 70, else stacked
    const sideBySideLayout = innerWidth >= 70;

    if (sideBySideLayout) {
      const panelInner = Math.floor((innerWidth - 9) / 2);
      const panelWidth = panelInner + 2;

      const agentContent = [
        `  ${chalk.hex(C.brightCyan)('●')} ${chalk.hex(C.muted)('Name:')} ${truncate(this.state.agentName, panelInner - 12)}`,
        `  ${chalk.hex(C.brightCyan)('●')} ${chalk.hex(C.muted)('LLM:')}  ${truncate(this.state.llmInfo, panelInner - 12)}`,
        `  ${chalk.hex(C.brightCyan)('●')} ${chalk.hex(C.muted)('Chan:')} ${this.state.channelCount > 0 ? sColor(`${this.state.channelCount} active`) : chalk.hex(C.muted)('0 active')}`,
      ];

      const keyPairs: string[] = [];
      for (let i = 0; i < this.state.keys.length; i += 2) {
        const k1 = this.state.keys[i];
        const k2 = this.state.keys[i + 1];
        const s1 = k1 ? `${k1.isSet ? sColor('✓') : chalk.hex(C.dim)('○')} ${k1.label}` : '';
        const s2 = k2 ? `${k2.isSet ? sColor('✓') : chalk.hex(C.dim)('○')} ${k2.label}` : '';
        keyPairs.push(`  ${ansiPadEnd(s1, 14)}${s2}`);
      }

      const agentPanel = buildHeavyPanel('AGENT', agentContent, panelWidth, pBdr, pTitleColor);
      const keysPanel = buildHeavyPanel('API KEYS', keyPairs, panelWidth, pBdr, pTitleColor);

      const composed = composeSideBySide(agentPanel, keysPanel, panelWidth, 2);
      for (const row of composed) {
        contentLines.push(frameLine(`   ${row}`));
      }
    } else {
      // Stacked layout for narrow terminals
      const panelWidth = Math.max(30, innerWidth - 6);
      const panelContentW = panelWidth - 2;

      const agentContent = [
        `  ${chalk.hex(C.brightCyan)('●')} ${chalk.hex(C.muted)('Name:')} ${truncate(this.state.agentName, panelContentW - 12)}`,
        `  ${chalk.hex(C.brightCyan)('●')} ${chalk.hex(C.muted)('LLM:')}  ${truncate(this.state.llmInfo, panelContentW - 12)}`,
        `  ${chalk.hex(C.brightCyan)('●')} ${chalk.hex(C.muted)('Chan:')} ${this.state.channelCount > 0 ? sColor(`${this.state.channelCount} active`) : chalk.hex(C.muted)('0 active')}`,
      ];

      const keyLine = this.state.keys.map((k) =>
        `${k.isSet ? sColor('✓') : chalk.hex(C.dim)('○')} ${k.label}`
      ).join('  ');
      const keyPairs = [`  ${keyLine}`];

      const agentPanel = buildHeavyPanel('AGENT', agentContent, panelWidth, pBdr, pTitleColor);
      const keysPanel = buildHeavyPanel('API KEYS', keyPairs, panelWidth, pBdr, pTitleColor);

      for (const row of agentPanel) contentLines.push(frameLine(`   ${row}`));
      contentLines.push(emptyFrame());
      for (const row of keysPanel) contentLines.push(frameLine(`   ${row}`));
    }

    contentLines.push(emptyFrame());

    // ═══ Actions Section Header ═══════════════════════════════════════
    const actTitle = ` ${chalk.hex(C.magenta).bold('ACTIONS')} `; // visible: " ACTIONS " = 9
    const actTitleVis = 9;
    const actHalfL = Math.max(0, Math.floor((innerWidth - actTitleVis) / 2));
    const actHalfR = Math.max(0, innerWidth - actTitleVis - actHalfL);
    const actHeaderContent = accentBorder('─'.repeat(actHalfL)) + actTitle + accentBorder('─'.repeat(actHalfR));
    contentLines.push(frameLine(actHeaderContent));

    contentLines.push(emptyFrame());

    // ═══ Quick Actions ════════════════════════════════════════════════
    this.actionLineOffset = contentLines.length;

    for (let i = 0; i < ACTIONS.length; i++) {
      const action = ACTIONS[i];
      const selected = i === this.cursor;

      const cursor = selected ? chalk.hex(C.brightCyan)('▸') : ' ';
      const label  = selected ? chalk.hex(C.white).bold(action.label) : chalk.hex(C.text)(action.label);
      const hint   = selected ? chalk.hex(C.cyan)(action.hint) : chalk.hex(C.dim)(action.hint);

      const labelVis = visibleLength(label);
      const hintVis  = visibleLength(hint);
      const dotsLen  = Math.max(2, innerWidth - 9 - labelVis - hintVis);
      const dotColor = selected ? C.dark : C.darker;
      const dots     = chalk.hex(dotColor)('·'.repeat(dotsLen));

      contentLines.push(frameLine(`   ${cursor} ${label} ${dots} ${hint}  `));
    }

    contentLines.push(emptyFrame());

    // ═══ Bottom Border ════════════════════════════════════════════════
    contentLines.push(`  ${frameBorder('╚')}${frameBorder('═'.repeat(innerWidth))}${frameBorder('╝')}`);

    // ═══ Footer Keybinding Bar (pinned at bottom) ═════════════════════
    const hintSep = chalk.hex(C.dark)('  ·  ');
    const hintFull = [
      `${chalk.hex(C.purple)('↑↓')} navigate`,
      `${chalk.hex(C.lavender)('⏎')} select`,
      `${chalk.hex(C.magenta)('d')} doctor`,
      `${chalk.hex(C.brightCyan)('s')} status`,
      `${chalk.hex(C.fuchsia)('v')} voice`,
      `${chalk.hex(C.cyan)('r')} refresh`,
      `${chalk.hex(C.purple)('q')} quit`,
    ];
    const hintShort = [
      `${chalk.hex(C.purple)('↑↓')} nav`,
      `${chalk.hex(C.lavender)('⏎')} sel`,
      `${chalk.hex(C.magenta)('d')} doc`,
      `${chalk.hex(C.purple)('q')} quit`,
    ];
    // Choose hint set that fits
    const fullStr = hintFull.join(hintSep);
    const shortStr = hintShort.join(hintSep);
    const hintStr = visibleLength(fullStr) + 10 <= contentWidth ? fullStr : shortStr;
    const hintVLen = visibleLength(hintStr);
    const scanL = chalk.hex(C.purple)('░▒▓');
    const scanR = chalk.hex(C.cyan)('▓▒░');
    const footerPad = Math.max(0, Math.floor((contentWidth - hintVLen - 10) / 2));

    const footerLines: string[] = [
      '',
      `  ${' '.repeat(footerPad)}${scanL}  ${hintStr}  ${scanR}`,
      '',
    ];

    // ═══ Viewport Slicing ═════════════════════════════════════════════
    const viewportHeight = Math.max(1, rows - footerLines.length);

    // Auto-scroll to keep cursor visible
    this.ensureCursorVisible(viewportHeight, contentLines.length);

    const visibleContent = contentLines.slice(
      this.scrollOffset,
      this.scrollOffset + viewportHeight,
    );

    // Pad if content is shorter than viewport
    while (visibleContent.length < viewportHeight) {
      visibleContent.push('');
    }

    // Scroll indicators
    if (this.scrollOffset > 0) {
      const indicator = chalk.hex(C.dim)('▲ scroll up');
      const indPad = Math.max(0, Math.floor((contentWidth - 11) / 2));
      visibleContent[0] = `  ${' '.repeat(indPad)}${indicator}`;
    }
    if (this.scrollOffset + viewportHeight < contentLines.length) {
      const indicator = chalk.hex(C.dim)('▼ scroll down');
      const indPad = Math.max(0, Math.floor((contentWidth - 13) / 2));
      visibleContent[visibleContent.length - 1] = `  ${' '.repeat(indPad)}${indicator}`;
    }

    this.screen.render([...visibleContent, ...footerLines].join('\n'));
  }

  // ── Scroll ──────────────────────────────────────────────────────────────

  private ensureCursorVisible(viewportHeight: number, totalLines: number): void {
    const cursorLine = this.actionLineOffset + this.cursor;
    const margin = 2;

    if (cursorLine - margin < this.scrollOffset) {
      this.scrollOffset = Math.max(0, cursorLine - margin);
    }
    if (cursorLine + margin >= this.scrollOffset + viewportHeight) {
      this.scrollOffset = cursorLine + margin - viewportHeight + 1;
    }

    // Clamp to valid range
    const maxScroll = Math.max(0, totalLines - viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
  }

  // ── Navigation ────────────────────────────────────────────────────────

  private moveCursor(delta: number): void {
    const prev = this.cursor;
    this.cursor = Math.max(0, Math.min(ACTIONS.length - 1, this.cursor + delta));

    // When cursor is already at boundary, scroll the viewport instead
    if (this.cursor === prev && delta !== 0) {
      this.scrollOffset += delta;
    }

    this.renderDashboard();
  }

  private selectCurrent(): void {
    const action = ACTIONS[this.cursor];
    if (action) this.onSelect(action.command);
  }

  private selectIndex(index: number): void {
    if (index >= 0 && index < ACTIONS.length) {
      this.cursor = index;
      this.selectCurrent();
    }
  }

  private async refresh(): Promise<void> {
    await this.init();
    this.renderDashboard();
  }

  dispose(): void {
    this.keys.pop();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build the tagline with individually colored segments, adapted to available width. */
function buildTagline(maxWidth: number): string {
  const sep = `  ${chalk.hex(C.dim)('·')}  `;
  const sepVis = 5;

  // Full tagline: v0.25.0 · https://wunderland.sh · https://rabbithole.inc · https://docs.wunderland.sh
  // ~91 visible chars
  const full = [
    chalk.hex(C.purple)(`v${VERSION}`),
    sep,
    chalk.hex(C.cyan)(URLS.website),
    sep,
    chalk.hex(C.brightCyan)(URLS.saas),
    sep,
    chalk.hex(C.cyan)(URLS.docs),
  ].join('');
  const fullVis = VERSION.length + 1 + sepVis + URLS.website.length + sepVis + URLS.saas.length + sepVis + URLS.docs.length;

  if (fullVis <= maxWidth) return full;

  // Medium: drop docs URL — v0.25.0 · wunderland.sh · rabbithole.inc
  const medium = [
    chalk.hex(C.purple)(`v${VERSION}`),
    sep,
    chalk.hex(C.cyan)('wunderland.sh'),
    sep,
    chalk.hex(C.brightCyan)('rabbithole.inc'),
  ].join('');
  const medVis = VERSION.length + 1 + sepVis + 13 + sepVis + 14;

  if (medVis <= maxWidth) return medium;

  // Short: just version + main site
  const short = [
    chalk.hex(C.purple)(`v${VERSION}`),
    sep,
    chalk.hex(C.cyan)('wunderland.sh'),
  ].join('');

  return short;
}

/** Build a heavy-bordered panel (┏━┓┃┗┛) with a colored title. */
function buildHeavyPanel(
  title: string,
  content: string[],
  width: number,
  borderColor: (s: string) => string,
  titleColor: (s: string) => string,
): string[] {
  const titleStr = ` ${titleColor(title)} `;
  const titleLen = title.length + 2;
  const result: string[] = [];

  result.push(
    borderColor('┏') + titleStr + borderColor('━'.repeat(Math.max(0, width - 2 - titleLen))) + borderColor('┓'),
  );

  for (const line of content) {
    const vLen = visibleLength(line);
    const pad = Math.max(0, width - 2 - vLen);
    result.push(borderColor('┃') + line + ' '.repeat(pad) + borderColor('┃'));
  }

  result.push(borderColor('┗') + borderColor('━'.repeat(Math.max(0, width - 2))) + borderColor('┛'));
  return result;
}
