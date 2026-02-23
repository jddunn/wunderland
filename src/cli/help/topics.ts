/**
 * @fileoverview `wunderland help <topic>` content.
 * @module wunderland/cli/help/topics
 */

import chalk from 'chalk';
import { URLS } from '../constants.js';
import { accent, bright, dim, info as iColor, muted, success as sColor, warn as wColor } from '../ui/theme.js';
import { glyphs } from '../ui/glyphs.js';
import { getUiRuntime } from '../ui/runtime.js';

export type HelpTopicId =
  | 'getting-started'
  | 'tui'
  | 'ui'
  | 'presets'
  | 'security'
  | 'export';

export const HELP_TOPICS: Array<{ id: HelpTopicId; title: string; summary: string }> = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    summary: 'First-run onboarding: setup, doctor, chat, start.',
  },
  {
    id: 'tui',
    title: 'TUI Dashboard',
    summary: 'Keyboard-driven dashboard (search, drilldowns, tour).',
  },
  {
    id: 'ui',
    title: 'UI / Themes',
    summary: 'Theme, color, and ASCII fallback options.',
  },
  {
    id: 'presets',
    title: 'Presets',
    summary: 'Quickly scaffold agents with personality + security defaults.',
  },
  {
    id: 'security',
    title: 'Security & Approvals',
    summary: 'Execution modes, tool permissions, and safe defaults.',
  },
  {
    id: 'export',
    title: 'Export (PNG)',
    summary: 'Export command output as a styled terminal screenshot.',
  },
];

function hr(): string {
  const g = glyphs();
  return dim(g.hr.repeat(56));
}

function printTitle(title: string): void {
  const g = glyphs();
  console.log();
  console.log(`  ${accent(g.bullet)} ${bright(title)}`);
  console.log(`  ${dim(URLS.website)}${dim(`  ${g.dot}  `)}${dim(URLS.docs)}`);
  console.log();
}

export function printHelpTopic(topicRaw: string): void {
  const g = glyphs();
  const ui = getUiRuntime();
  const upDown = ui.ascii ? 'Up/Down' : '↑/↓';
  const enter = ui.ascii ? 'Enter' : '⏎';

  const topic = String(topicRaw || '').trim().toLowerCase();

  const resolved: HelpTopicId | null = (() => {
    if (topic === 'getting-started' || topic === 'gettingstarted' || topic === 'quickstart') return 'getting-started';
    if (topic === 'tui' || topic === 'dashboard') return 'tui';
    if (topic === 'ui' || topic === 'theme' || topic === 'themes' || topic === 'style' || topic === 'ascii') return 'ui';
    if (topic === 'presets' || topic === 'preset') return 'presets';
    if (topic === 'security' || topic === 'approvals' || topic === 'hitl') return 'security';
    if (topic === 'export' || topic === 'png' || topic === 'screenshot') return 'export';
    return null;
  })();

  if (!resolved) {
    console.log();
    console.log(`  ${wColor(g.warn)} ${bright('Unknown help topic')} ${muted(topicRaw)}`);
    console.log(`  ${dim('Try:')} ${accent('wunderland help getting-started')}${dim(', ')}${accent('wunderland help tui')}${dim(', ')}${accent('wunderland help ui')}${dim(', ')}${accent('wunderland help presets')}`);
    console.log();
    return;
  }

  if (resolved === 'getting-started') {
    printTitle('Getting Started');
    console.log(`  ${iColor('0')} ${bright('Open the dashboard (recommended)')}`);
    console.log(`     ${muted('$')} ${accent('wunderland')}`);
    console.log(`     ${dim('Interactive TUI: search, drilldowns, and quick actions.')}`);
    console.log(`     ${dim('First run: a short onboarding tour appears (skip/disable, reopen with "t").')}`);
    console.log();
    console.log(`  ${iColor('1')} ${bright('Run setup (recommended)')}`);
    console.log(`     ${muted('$')} ${accent('wunderland setup')}`);
    console.log(`     ${dim('Interactive wizard: LLM provider, keys, channels, personality.')}`);
    console.log();
    console.log(`  ${iColor('2')} ${bright('Verify your environment')}`);
    console.log(`     ${muted('$')} ${accent('wunderland doctor')}`);
    console.log(`     ${dim('Checks config, keys, and connectivity.')}`);
    console.log();
    console.log(`  ${iColor('3')} ${bright('Chat locally (interactive)')}`);
    console.log(`     ${muted('$')} ${accent('wunderland chat')}`);
    console.log(`     ${dim('Tool calling + approvals. Type /help inside chat.')}`);
    console.log();
    console.log(`  ${iColor('4')} ${bright('Start the server')}`);
    console.log(`     ${muted('$')} ${accent('wunderland start')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${dim('Prefer scaffolding a project?')}`);
    console.log(`     ${muted('$')} ${accent('wunderland init my-agent --preset research-assistant')}`);
    console.log();
    return;
  }

  if (resolved === 'tui') {
    printTitle('TUI Dashboard');
    console.log(`  ${dim('Run with no args in a TTY:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland')}`);
    console.log();
    console.log(`  ${dim('Navigation:')}`);
    console.log(`     ${accent(upDown)} move   ${accent(enter)} select   ${accent('/')} search   ${accent('?')} help   ${accent('t')} tour`);
    console.log(`     ${accent('esc')} close/back   ${accent('q')} quit   ${accent('r')} refresh`);
    console.log();
    console.log(`  ${dim('Drilldowns:')}`);
    console.log(`     ${accent('/')} search lists   ${accent(enter)} details modal   ${accent('?')} help modal`);
    console.log();
    console.log(`  ${dim('Tip:')} Use ${accent('/')} to filter commands like a command palette.`);
    console.log();
    return;
  }

  if (resolved === 'ui') {
    printTitle('UI / Themes');
    console.log(`  ${dim('Defaults:')} ${bright('plain')} theme (no color), with auto ASCII fallback in limited terminals.`);
    console.log();
    console.log(`  ${dim('Theme:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland --theme cyberpunk')}`);
    console.log(`     ${muted('$')} ${accent('wunderland --theme plain')}`);
    console.log();
    console.log(`  ${dim('ASCII-only UI:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland --ascii')}`);
    console.log(`     ${muted('$')} ${accent('wunderland config set ui.ascii true')}`);
    console.log();
    console.log(`  ${dim('Persist theme:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland config set ui.theme cyberpunk')}`);
    console.log(`     ${muted('$')} ${accent('wunderland config set ui.theme plain')}`);
    console.log();
    console.log(`  ${dim('Notes:')}`);
    console.log(`   - ${accent('--no-color')} also disables colors (or set ${accent('NO_COLOR=1')}).`);
    console.log(`   - Tour is always available inside the dashboard: press ${accent('t')}.`);
    console.log(`   - Reset tour auto-launch: ${accent('wunderland config set ui.tour.status unseen')}`);
    console.log(`   - Disable tour auto-launch: ${accent('wunderland config set ui.tour.status never')}`);
    console.log();
    return;
  }

  if (resolved === 'presets') {
    printTitle('Presets');
    console.log(`  Presets are the fastest way to scaffold a coherent agent.`);
    console.log(`  They bundle personality (HEXACO), security tier, and suggested skills/channels.`);
    console.log();
    console.log(`  ${dim('List presets:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland list-presets')}`);
    console.log();
    console.log(`  ${dim('Scaffold a project with a preset:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland init my-agent --preset research-assistant')}`);
    console.log(`     ${muted('$')} ${accent('wunderland init my-agent --preset customer-support')}`);
    console.log();
    console.log(`  ${dim('Override security tier:')}`);
    console.log(`     ${muted('$')} ${accent('wunderland init my-agent --security-tier strict')}`);
    console.log();
    return;
  }

  if (resolved === 'security') {
    printTitle('Security & Approvals');
    console.log(`  Wunderland is safe-by-default: side-effect tools require approval unless you opt in.`);
    console.log();
    console.log(`  ${dim('Modes:')}`);
    console.log(`     ${bright('deny-side-effects')}  ${dim('default for library API')}`);
    console.log(`     ${bright('auto-all')}          ${dim('fully autonomous (dangerous)')}`);
    console.log(`     ${bright('custom')}            ${dim('your app decides per request')}`);
    console.log();
    console.log(`  ${dim('CLI shortcuts:')}`);
    console.log(`     ${accent('--auto-approve-tools')} ${dim('fully autonomous tool calls (CI / demos)')}`);
    console.log(`     ${accent('--yes')} ${dim('auto-confirm prompts (setup/init); does NOT auto-approve tools')}`);
    console.log(`     ${accent('--dangerously-skip-permissions')} ${dim('skip permission checks')}`);
    console.log(`     ${accent('--dangerously-skip-command-safety')} ${dim('disable shell safety checks')}`);
    console.log();
    console.log(`  ${hr()}`);
    console.log(`  ${dim('See also:')} ${accent(URLS.docs)}`);
    console.log();
    return;
  }

  // export
  printTitle('Export (PNG)');
  console.log(`  Export non-interactive command output as a styled PNG:`);
  console.log();
  console.log(`     ${muted('$')} ${accent('wunderland doctor --export-png doctor.png')}`);
  console.log(`     ${muted('$')} ${accent('wunderland --help --export-png help.png')}`);
  console.log();
  console.log(`  ${dim('Notes:')}`);
  console.log(`   - Interactive commands like ${bright('chat')} are not exportable.`);
  console.log(`   - Export forces truecolor ANSI for pixel-accurate screenshots.`);
  console.log();
  console.log(`  ${sColor(g.ok)} ${dim('Saved next to the path you specify.')}`);
  console.log();
}

export function printHelpTopicsList(): void {
  console.log();
  console.log(`  ${accent('Topics:')}`);
  for (const t of HELP_TOPICS) {
    console.log(`    ${chalk.white(t.id.padEnd(16))} ${dim(t.summary)}`);
  }
  console.log();
  console.log(`  ${dim('Try:')} ${accent('wunderland help getting-started')}${dim(', ')}${accent('wunderland help tui')}${dim(', ')}${accent('wunderland help ui')}${dim(', ')}${accent('wunderland help presets')}`);
  console.log();
}
