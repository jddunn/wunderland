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
  HEX,
  success as sColor,
} from '../ui/theme.js';
import { ASCII_BANNER, ASCII_BANNER_ASCII } from '../ui/brand.js';
import { stripAnsi, sliceAnsi, visibleLength, ansiPadEnd } from '../ui/ansi-utils.js';
import { VERSION, URLS } from '../constants.js';
import { loadConfig, updateConfig } from '../config/config-manager.js';
import { checkEnvSecrets } from '../config/secrets.js';
import { renderOverlayBox, stampOverlay } from './widgets/overlay.js';
import { glyphs } from '../ui/glyphs.js';
import { getUiRuntime } from '../ui/runtime.js';
import { getTourControlsLine, getTourSteps, shouldAutoLaunchTour, type TourStatus } from './tour.js';

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
  isSetUp: boolean;
}

// ── Color Palette (hex values for chalk.hex) ───────────────────────────────

const C = HEX;

// ── Solid Border Colors ──────────────────────────────────────────────────

const frameBorder  = chalk.hex(C.cyan);
const accentBorder = chalk.hex(C.lavender);

// ── Quick Actions ──────────────────────────────────────────────────────────

const ACTIONS: QuickAction[] = [
  { label: 'Setup onboarding',    command: 'setup',      hint: 'wunderland setup',      shortcut: '1' },
  { label: 'Open chat',           command: 'chat',       hint: 'wunderland chat',       shortcut: '2' },
  { label: 'Start server',        command: 'start',      hint: 'wunderland start',      shortcut: '3' },
  { label: 'Run health check',    command: 'doctor',     hint: 'wunderland doctor',     shortcut: 'd' },
  { label: 'Browse skills',       command: 'skills',     hint: 'wunderland skills',     shortcut: '4' },
  { label: 'Browse extensions',   command: 'extensions', hint: 'wunderland extensions', shortcut: '5' },
  { label: 'View models',         command: 'models',     hint: 'wunderland models',     shortcut: '6' },
  { label: 'Query RAG memory',    command: 'rag',        hint: 'wunderland rag',        shortcut: '7' },
  { label: 'Voice providers',     command: 'voice',      hint: 'wunderland voice',      shortcut: 'v' },
  { label: 'View status',         command: 'status',     hint: 'wunderland status',     shortcut: 's' },
  { label: 'Help',                command: 'help',       hint: 'wunderland --help',     shortcut: 'h' },
  { label: 'Tour / onboarding',   command: 'tour',       hint: 'press t',               shortcut: 't' },
];

// ── ASCII Banner ───────────────────────────────────────────────────────────

function getAsciiBannerLines(): string[] {
  const ui = getUiRuntime();
  const banner = ui.ascii ? ASCII_BANNER_ASCII : ASCII_BANNER;
  return banner.split('\n').filter((l) => l.trim().length > 0);
}

// ── Dashboard ──────────────────────────────────────────────────────────────

export class Dashboard {
  private cursor = 0;
  private scrollOffset = 0;
  private actionLineOffset = 0;
  private searchMode = false;
  private filter = '';
  private showHelp = false;
  private tourActive = false;
  private tourStep = 0;
  private tourAutoLaunch = false;
  private screen: Screen;
  private keys: KeybindingManager;
  private onSelect: (command: string) => void;
  private onQuit: () => void;
  private configDir?: string;
  private state: DashboardState = {
    agentName: 'not configured',
    llmInfo: 'not configured',
    channelCount: 0,
    keys: [],
    isSetUp: false,
  };
  private introPlayed = false;

  constructor(opts: {
    screen: Screen;
    keys: KeybindingManager;
    onSelect: (command: string) => void;
    onQuit: () => void;
    configDir?: string;
  }) {
    this.screen = opts.screen;
    this.keys = opts.keys;
    this.onSelect = opts.onSelect;
    this.onQuit = opts.onQuit;
    this.configDir = opts.configDir;

    this.keys.push({
      name: 'dashboard',
      bindings: {
        'up':      () => { this.moveCursor(-1); },
        'down':    () => { this.moveCursor(1); },
        'k':       () => { if (this.searchMode) return false; this.moveCursor(-1); return true; },
        'j':       () => { if (this.searchMode) return false; this.moveCursor(1); return true; },
        'return':  () => { this.selectCurrent(); },
        't':       () => { if (this.searchMode) return false; this.openTour(); return true; },
        '__text__': (key) => {
          if (!this.searchMode) return false;
          this.filter += key.sequence;
          this.cursor = 0;
          this.renderDashboard();
          return true;
        },
        '/':       () => { if (this.searchMode) return false; this.enterSearch(); return true; },
        '?':       () => { if (this.searchMode) return false; this.showHelp = !this.showHelp; this.renderDashboard(); return true; },
        'backspace': () => {
          if (!this.searchMode) return false;
          this.filter = this.filter.slice(0, -1);
          this.cursor = 0;
          this.renderDashboard();
          return true;
        },
        'q':       () => {
          if (this.showHelp) { this.showHelp = false; this.renderDashboard(); return true; }
          if (this.searchMode) return false;
          this.onQuit();
          return true;
        },
        'ctrl+c':  () => { this.onQuit(); },
        'escape':  () => {
          if (this.showHelp) { this.showHelp = false; this.renderDashboard(); return; }
          if (this.searchMode) { this.exitSearch(); return; }
          this.onQuit();
        },
        'd':       () => { if (this.searchMode) return false; this.onSelect('doctor'); return true; },
        's':       () => { if (this.searchMode) return false; this.onSelect('status'); return true; },
        'v':       () => { if (this.searchMode) return false; this.onSelect('voice'); return true; },
        'h':       () => { if (this.searchMode) return false; this.onSelect('help'); return true; },
        'r':       () => { if (this.searchMode) return false; this.refresh(); return true; },
        '1':       () => { if (this.searchMode) return false; this.selectIndex(0); return true; },
        '2':       () => { if (this.searchMode) return false; this.selectIndex(1); return true; },
        '3':       () => { if (this.searchMode) return false; this.selectIndex(2); return true; },
        '4':       () => { if (this.searchMode) return false; this.selectIndex(4); return true; },
        '5':       () => { if (this.searchMode) return false; this.selectIndex(5); return true; },
        '6':       () => { if (this.searchMode) return false; this.selectIndex(6); return true; },
        '7':       () => { if (this.searchMode) return false; this.selectIndex(7); return true; },
      },
    });
  }

  /** Pre-load config and secrets. Call once before first render. */
  async init(): Promise<void> {
    try {
      const config = await loadConfig(this.configDir);
      if (config.agentName) this.state.agentName = config.agentName;
      if (config.llmProvider && config.llmModel) {
        this.state.llmInfo = `${config.llmProvider} / ${config.llmModel}`;
      } else if (config.llmProvider) {
        this.state.llmInfo = config.llmProvider;
      }
      this.state.isSetUp = !!(config.agentName && config.llmProvider);
      if (Array.isArray(config.channels)) {
        this.state.channelCount = config.channels.length;
      }
      this.tourAutoLaunch = shouldAutoLaunchTour(config);
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
      const ui = getUiRuntime();
      const canAnimate = ui.theme === 'cyberpunk' && !ui.noColor && !ui.ascii && !!process.stdout.isTTY;
      if (canAnimate) {
        await this.playIntro();
      }
    }
    if (this.tourAutoLaunch) {
      this.tourAutoLaunch = false;
      this.openTour();
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
      bannerLines = getAsciiBannerLines().map((line) => accentBorder(line));
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
    const ui = getUiRuntime();
    if (ui.ascii) {
      this.renderDashboardAscii();
      return;
    }
    const { rows, cols } = this.screen.getSize();
    const contentLines: string[] = [];
    const contentWidth = Math.max(cols - 4, 60);
    const innerWidth = contentWidth - 2;
    const g = glyphs();
    const upDown = ui.ascii ? 'Up/Down' : '↑/↓';
    const enter = ui.ascii ? 'Enter' : '⏎';
    const arrow = ui.ascii ? '->' : '→';

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
    let bannerLines: string[] = getAsciiBannerLines().map((l) => accentBorder(l));
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
        const s1 = k1 ? `${k1.isSet ? sColor(g.ok) : chalk.hex(C.dim)(g.circle)} ${k1.label}` : '';
        const s2 = k2 ? `${k2.isSet ? sColor(g.ok) : chalk.hex(C.dim)(g.circle)} ${k2.label}` : '';
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
        `${k.isSet ? sColor(g.ok) : chalk.hex(C.dim)(g.circle)} ${k.label}`
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

    if (this.searchMode) {
      const q = this.filter.trim();
      const placeholder = q ? chalk.hex(C.white)(q) : chalk.hex(C.dim)(`type to filter${g.ellipsis}`);
      const searchLine =
        `   ${chalk.hex(C.lightCyan)(g.search)} ${chalk.hex(C.muted)('Search:')} ${placeholder}  ${chalk.hex(C.dim)('(esc to exit)')}`;
      contentLines.push(frameLine(truncate(searchLine, innerWidth)));
      contentLines.push(emptyFrame());
    } else {
      contentLines.push(emptyFrame());
    }

    // ═══ Quick Actions ════════════════════════════════════════════════
    this.actionLineOffset = contentLines.length;

    const filtered = this.getFilteredActions();
    if (this.cursor > filtered.length - 1) this.cursor = Math.max(0, filtered.length - 1);

    if (filtered.length === 0) {
      const msg = `   ${chalk.hex(C.dim)('No matches. Press / to search or esc to exit.')}`;
      contentLines.push(frameLine(truncate(msg, innerWidth)));
    }

    for (let pos = 0; pos < filtered.length; pos++) {
      const { action } = filtered[pos];
      const selected = pos === this.cursor;

      const cursor = selected ? chalk.hex(C.brightCyan)(g.cursor) : ' ';

      // Shortcut key badge
      const shortcutBadge = action.shortcut
        ? chalk.hex(C.dim)(`[${action.shortcut}]`) + ' '
        : '    ';

      // Setup action shows configuration status
      let label: string;
      if (action.command === 'setup') {
        const tag = this.state.isSetUp
          ? chalk.hex(C.green)(` (configured ${g.ok})`)
          : chalk.hex(C.dim)(' (not configured)');
        label = (selected ? chalk.hex(C.white).bold(action.label) : chalk.hex(C.text)(action.label)) + tag;
      } else {
        label = selected ? chalk.hex(C.white).bold(action.label) : chalk.hex(C.text)(action.label);
      }

      const hint   = selected ? chalk.hex(C.cyan)(action.hint) : chalk.hex(C.dim)(action.hint);

      const fullLabel = shortcutBadge + label;
      const labelVis = visibleLength(fullLabel);
      const hintVis  = visibleLength(hint);
      const dotsLen  = Math.max(2, innerWidth - 9 - labelVis - hintVis);
      const dotColor = selected ? C.dark : C.darker;
      const dots     = chalk.hex(dotColor)(g.dot.repeat(dotsLen));

      contentLines.push(frameLine(`   ${cursor} ${fullLabel} ${dots} ${hint}  `));
    }

    contentLines.push(emptyFrame());

    // ═══ Bottom Border ════════════════════════════════════════════════
    contentLines.push(`  ${frameBorder('╚')}${frameBorder('═'.repeat(innerWidth))}${frameBorder('╝')}`);

    // ═══ Footer Keybinding Bar (pinned at bottom) ═════════════════════
    const hintSep = chalk.hex(C.dark)(`  ${g.dot}  `);
    const hintFull = [
      `${chalk.hex(C.purple)('↑↓')} navigate`,
      `${chalk.hex(C.lavender)('⏎')} select`,
      `${chalk.hex(C.lightCyan)('/')} search`,
      `${chalk.hex(C.lightCyan)('?')} help`,
      `${chalk.hex(C.magenta)('d')} doctor`,
      `${chalk.hex(C.brightCyan)('s')} status`,
      `${chalk.hex(C.fuchsia)('v')} voice`,
      `${chalk.hex(C.lightCyan)('h')} help`,
      `${chalk.hex(C.lightCyan)('t')} tour`,
      `${chalk.hex(C.cyan)('r')} refresh`,
      `${chalk.hex(C.purple)('q')} quit`,
    ];
    const hintShort = [
      `${chalk.hex(C.purple)('↑↓')} nav`,
      `${chalk.hex(C.lavender)('⏎')} sel`,
      `${chalk.hex(C.lightCyan)('/')} search`,
      `${chalk.hex(C.lightCyan)('?')} help`,
      `${chalk.hex(C.lightCyan)('t')} tour`,
      `${chalk.hex(C.lightCyan)('h')} help`,
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
      const indicator = chalk.hex(C.dim)(`${g.triUp} scroll up`);
      const indPad = Math.max(0, Math.floor((contentWidth - 11) / 2));
      visibleContent[0] = `  ${' '.repeat(indPad)}${indicator}`;
    }
    if (this.scrollOffset + viewportHeight < contentLines.length) {
      const indicator = chalk.hex(C.dim)(`${g.triDown} scroll down`);
      const indPad = Math.max(0, Math.floor((contentWidth - 13) / 2));
      visibleContent[visibleContent.length - 1] = `  ${' '.repeat(indPad)}${indicator}`;
    }

    let outLines = [...visibleContent, ...footerLines];

    if (this.showHelp) {
      const overlayWidth = Math.min(Math.max(44, Math.min(74, cols - 8)), Math.max(24, cols - 4));
      const overlay = renderOverlayBox({
        title: 'Dashboard Help',
        width: overlayWidth,
        lines: [
          `${chalk.hex(C.lightCyan)(upDown)} navigate  ${chalk.hex(C.lavender)(enter)} select  ${chalk.hex(C.dim)('/')} palette`,
          `${chalk.hex(C.magenta)('d')} doctor  ${chalk.hex(C.brightCyan)('s')} status  ${chalk.hex(C.fuchsia)('v')} voice  ${chalk.hex(C.lightCyan)('h')} help  ${chalk.hex(C.lightCyan)('t')} tour`,
          `${chalk.hex(C.cyan)('r')} refresh  ${chalk.hex(C.purple)('q')} quit  ${chalk.hex(C.dim)('esc')} close`,
          '',
          `${chalk.hex(C.dim)('First run:')} ${chalk.hex(C.white).bold('setup')} ${arrow} ${chalk.hex(C.white).bold('doctor')} ${arrow} ${chalk.hex(C.white).bold('chat')} ${arrow} ${chalk.hex(C.white).bold('start')}`,
          `${chalk.hex(C.dim)('Guides:')} ${chalk.hex(C.cyan)('wunderland help getting-started')}, ${chalk.hex(C.cyan)('wunderland help tui')}`,
        ],
      });

      const viewportHeight = Math.max(1, rows - footerLines.length);
      outLines = stampOverlay({
        screenLines: outLines,
        overlayLines: overlay,
        cols,
        rows,
        y: Math.max(0, Math.floor((viewportHeight - overlay.length) / 2)),
      });
    }

    if (this.tourActive) {
      const steps = getTourSteps({ ascii: ui.ascii });
      const step = steps[Math.max(0, Math.min(this.tourStep, steps.length - 1))];
      const overlayWidth = Math.min(Math.max(50, Math.min(78, cols - 8)), Math.max(24, cols - 4));
      const overlay = renderOverlayBox({
        title: `Tour: ${step.title} (${this.tourStep + 1}/${steps.length})`,
        width: overlayWidth,
        lines: [
          ...step.lines,
          '',
          chalk.hex(C.dim)(getTourControlsLine({ ascii: ui.ascii })),
        ],
      });

      const viewportHeight = Math.max(1, rows - footerLines.length);
      outLines = stampOverlay({
        screenLines: outLines,
        overlayLines: overlay,
        cols,
        rows,
        y: Math.max(0, Math.floor((viewportHeight - overlay.length) / 2)),
      });
    }

    this.screen.render(outLines.join('\n'));
  }

  private renderDashboardAscii(): void {
    const g = glyphs();
    const ui = getUiRuntime();
    const { rows, cols } = this.screen.getSize();

    const contentLines: string[] = [];
    const width = Math.max(40, cols);
    const innerWidth = Math.max(0, width - 2);

    const fit = (line: string): string => {
      const vLen = visibleLength(line);
      if (vLen > cols) return sliceAnsi(line, 0, Math.max(0, cols));
      return line;
    };

    const headerSep = chalk.hex(C.dim)(g.hr.repeat(Math.max(10, Math.min(innerWidth, 70))));
    const upDown = ui.ascii ? 'Up/Down' : '↑/↓';
    const enter = ui.ascii ? 'Enter' : '⏎';
    const arrow = ui.ascii ? '->' : '→';

    contentLines.push('');
    contentLines.push(fit(`  ${chalk.hex(C.magenta).bold('WUNDERLAND')}`));
    contentLines.push(fit(`  ${buildTagline(Math.max(24, Math.min(innerWidth, 96)))}`));
    contentLines.push(fit(`  ${headerSep}`));
    contentLines.push('');

    // Status
    contentLines.push(fit(`  Agent: ${chalk.hex(C.white)(this.state.agentName)}`));
    contentLines.push(fit(`  LLM:   ${chalk.hex(C.white)(this.state.llmInfo)}`));
    contentLines.push(fit(`  Chan:  ${this.state.channelCount > 0 ? sColor(`${this.state.channelCount} active`) : chalk.hex(C.dim)('0 active')}`));

    const keySummary = this.state.keys
      .map((k) => `${k.isSet ? sColor(g.ok) : chalk.hex(C.dim)(g.circle)} ${k.label}`)
      .join('  ');
    if (keySummary.trim().length > 0) {
      contentLines.push(fit(`  Keys:  ${keySummary}`));
    }

    contentLines.push('');

    // Actions header
    contentLines.push(fit(`  ${chalk.hex(C.magenta).bold('ACTIONS')}`));
    contentLines.push(fit(`  ${chalk.hex(C.dim)(g.hr.repeat(Math.max(10, Math.min(innerWidth, 70))))}`));

    if (this.searchMode) {
      const q = this.filter.trim();
      const placeholder = q ? chalk.hex(C.white)(q) : chalk.hex(C.dim)('type to filter...');
      contentLines.push(fit(`  ${chalk.hex(C.lightCyan)(g.search)} Search: ${placeholder}  ${chalk.hex(C.dim)('(esc to exit)')}`));
      contentLines.push('');
    } else {
      contentLines.push('');
    }

    // Actions list
    this.actionLineOffset = contentLines.length;
    const filtered = this.getFilteredActions();
    if (this.cursor > filtered.length - 1) this.cursor = Math.max(0, filtered.length - 1);

    if (filtered.length === 0) {
      contentLines.push(fit(`  ${chalk.hex(C.dim)('No matches. Press / to search or esc to exit.')}`));
    }

    for (let pos = 0; pos < filtered.length; pos++) {
      const { action } = filtered[pos];
      const selected = pos === this.cursor;
      const cursor = selected ? chalk.hex(C.brightCyan)(g.cursor) : ' ';
      const shortcut = action.shortcut ? chalk.hex(C.dim)(`[${action.shortcut}]`) + ' ' : '';

      let label = selected ? chalk.hex(C.white).bold(action.label) : chalk.hex(C.text)(action.label);
      if (action.command === 'setup') {
        label += this.state.isSetUp ? chalk.hex(C.green)(` (configured ${g.ok})`) : chalk.hex(C.dim)(' (not configured)');
      }

      const hint = selected ? chalk.hex(C.cyan)(action.hint) : chalk.hex(C.dim)(action.hint);

      const left = `  ${cursor} ${shortcut}${label}`;
      const leftLen = visibleLength(left);
      const hintLen = visibleLength(hint);
      const dotsLen = Math.max(2, Math.min(40, innerWidth - leftLen - hintLen - 2));
      const dots = chalk.hex(selected ? C.dark : C.darker)('.'.repeat(dotsLen));

      contentLines.push(fit(`${left} ${dots} ${hint}`));
    }

    // Footer
    const footerLines: string[] = [
      '',
      fit(`  ${chalk.hex(C.dim)(g.hr.repeat(Math.max(10, Math.min(innerWidth, 70))))}`),
      fit(`  ${chalk.hex(C.dim)(`${upDown} nav  ${enter} run  / search  ? help  t tour  r refresh  q quit  esc close`)}`),
      '',
    ];

    const viewportHeight = Math.max(1, rows - footerLines.length);
    this.ensureCursorVisible(viewportHeight, contentLines.length);

    const visibleContent = contentLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
    while (visibleContent.length < viewportHeight) visibleContent.push('');

    if (this.scrollOffset > 0) {
      visibleContent[0] = fit(`  ${chalk.hex(C.dim)(`${g.triUp} scroll up`)}`);
    }
    if (this.scrollOffset + viewportHeight < contentLines.length) {
      visibleContent[visibleContent.length - 1] = fit(`  ${chalk.hex(C.dim)(`${g.triDown} scroll down`)}`);
    }

    let outLines = [...visibleContent, ...footerLines];

    if (this.showHelp) {
      const overlayWidth = Math.min(Math.max(44, Math.min(74, cols - 8)), Math.max(24, cols - 4));
      const overlay = renderOverlayBox({
        title: 'Dashboard Help',
        width: overlayWidth,
        lines: [
          `${chalk.hex(C.lightCyan)(upDown)} navigate  ${chalk.hex(C.lavender)(enter)} select  ${chalk.hex(C.dim)('/')} palette`,
          `${chalk.hex(C.magenta)('d')} doctor  ${chalk.hex(C.brightCyan)('s')} status  ${chalk.hex(C.fuchsia)('v')} voice  ${chalk.hex(C.lightCyan)('h')} help  ${chalk.hex(C.lightCyan)('t')} tour`,
          `${chalk.hex(C.cyan)('r')} refresh  ${chalk.hex(C.purple)('q')} quit  ${chalk.hex(C.dim)('esc')} close`,
          '',
          `${chalk.hex(C.dim)('First run:')} ${chalk.hex(C.white).bold('setup')} ${arrow} ${chalk.hex(C.white).bold('doctor')} ${arrow} ${chalk.hex(C.white).bold('chat')} ${arrow} ${chalk.hex(C.white).bold('start')}`,
          `${chalk.hex(C.dim)('Guides:')} ${chalk.hex(C.cyan)('wunderland help getting-started')}, ${chalk.hex(C.cyan)('wunderland help tui')}`,
        ],
      });

      outLines = stampOverlay({ screenLines: outLines, overlayLines: overlay, cols, rows });
    }

    if (this.tourActive) {
      const steps = getTourSteps({ ascii: ui.ascii });
      const step = steps[Math.max(0, Math.min(this.tourStep, steps.length - 1))];
      const overlayWidth = Math.min(Math.max(50, Math.min(78, cols - 8)), Math.max(24, cols - 4));
      const overlayLines = [
        ...step.lines,
        '',
        chalk.hex(C.dim)(getTourControlsLine({ ascii: ui.ascii })),
      ];
      const overlay = renderOverlayBox({
        title: `Tour: ${step.title} (${this.tourStep + 1}/${steps.length})`,
        width: overlayWidth,
        lines: overlayLines,
      });

      outLines = stampOverlay({ screenLines: outLines, overlayLines: overlay, cols, rows });
    }

    this.screen.render(outLines.map(fit).join('\n'));
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
    const filteredLen = this.getFilteredActions().length;
    this.cursor = Math.max(0, Math.min(Math.max(0, filteredLen - 1), this.cursor + delta));

    // When cursor is already at boundary, scroll the viewport instead
    if (this.cursor === prev && delta !== 0) {
      this.scrollOffset += delta;
    }

    this.renderDashboard();
  }

  private selectCurrent(): void {
    const filtered = this.getFilteredActions();
    const action = filtered[this.cursor]?.action;
    if (!action) return;
    if (action.command === 'tour') {
      this.openTour();
      return;
    }
    this.onSelect(action.command);
  }

  private selectIndex(index: number): void {
    if (index < 0 || index >= ACTIONS.length) return;
    this.searchMode = false;
    this.filter = '';
    this.cursor = index;
    this.selectCurrent();
  }

  private async refresh(): Promise<void> {
    await this.init();
    this.renderDashboard();
  }

  dispose(): void {
    this.keys.pop();
  }

  // ── Tour ───────────────────────────────────────────────────────────────

  private openTour(): void {
    if (this.tourActive) return;

    this.tourActive = true;
    this.tourStep = 0;
    this.showHelp = false;
    this.searchMode = false;
    this.filter = '';

    this.keys.push({
      name: 'dashboard-tour',
      bindings: {
        '__text__': () => { return true; },
        '__any__':  () => { return true; },
        'ctrl+c': () => { this.onQuit(); return true; },
        'escape': () => { this.closeTour('skipped'); return true; },
        'q':      () => { this.closeTour('skipped'); return true; },
        's':      () => { this.closeTour('skipped'); return true; },
        'x':      () => { this.closeTour('never'); return true; },
        'b':      () => {
          if (this.tourStep > 0) {
            this.tourStep -= 1;
            this.renderDashboard();
          }
          return true;
        },
        'return': () => {
          const steps = getTourSteps({ ascii: getUiRuntime().ascii });
          if (this.tourStep >= steps.length - 1) {
            this.closeTour('completed');
            return true;
          }
          this.tourStep += 1;
          this.renderDashboard();
          return true;
        },
      },
    });

    this.renderDashboard();
  }

  private closeTour(status: TourStatus): void {
    if (!this.tourActive) return;
    this.tourActive = false;
    this.tourStep = 0;
    this.keys.pop();
    this.persistTourStatus(status);
    this.renderDashboard();
  }

  private persistTourStatus(status: TourStatus): void {
    const when = new Date().toISOString();
    void (async () => {
      try {
        const existing = await loadConfig(this.configDir);
        const ui = existing.ui ?? {};
        const tour = { ...(ui.tour ?? {}), status, lastShownAt: when };
        await updateConfig({ ui: { ...ui, tour } }, this.configDir);
      } catch {
        // ignore persistence errors in TUI mode
      }
    })();
  }

  private enterSearch(): void {
    this.searchMode = true;
    this.showHelp = false;
    this.filter = '';
    this.cursor = 0;
    this.renderDashboard();
  }

  private exitSearch(): void {
    this.searchMode = false;
    this.filter = '';
    this.cursor = 0;
    this.renderDashboard();
  }

  private getFilteredActions(): Array<{ index: number; action: QuickAction }> {
    const q = this.filter.trim().toLowerCase();
    if (!q) return ACTIONS.map((action, index) => ({ index, action }));
    return ACTIONS
      .map((action, index) => ({ index, action }))
      .filter(({ action }) => {
        const hay = `${action.label} ${action.command} ${action.hint}`.toLowerCase();
        return hay.includes(q);
      });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build the tagline with individually colored segments, adapted to available width. */
function buildTagline(maxWidth: number): string {
  const g = glyphs();
  const sep = `  ${chalk.hex(C.dim)(g.dot)}  `;
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
  const g = glyphs();
  const titleStr = ` ${titleColor(title)} `;
  const titleLen = title.length + 2;
  const result: string[] = [];

  result.push(
    borderColor(g.boxHeavy.tl)
      + titleStr
      + borderColor(g.boxHeavy.h.repeat(Math.max(0, width - 2 - titleLen)))
      + borderColor(g.boxHeavy.tr),
  );

  for (const line of content) {
    const vLen = visibleLength(line);
    const pad = Math.max(0, width - 2 - vLen);
    result.push(borderColor(g.boxHeavy.v) + line + ' '.repeat(pad) + borderColor(g.boxHeavy.v));
  }

  result.push(borderColor(g.boxHeavy.bl) + borderColor(g.boxHeavy.h.repeat(Math.max(0, width - 2))) + borderColor(g.boxHeavy.br));
  return result;
}
