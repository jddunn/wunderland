/**
 * @fileoverview First-run onboarding tour for the TUI dashboard.
 * @module wunderland/cli/tui/tour
 */

import type { CliConfig } from '../types.js';

export type TourStatus = 'unseen' | 'skipped' | 'completed' | 'never';

export interface TourStep {
  title: string;
  lines: string[];
}

export function shouldAutoLaunchTour(config: CliConfig): boolean {
  const status = config.ui?.tour?.status;
  return status === undefined || status === 'unseen';
}

export function getTourSteps(opts: { ascii: boolean }): TourStep[] {
  const upDown = opts.ascii ? 'Up/Down' : '↑/↓';
  const enter = opts.ascii ? 'Enter' : '⏎';
  const arrow = opts.ascii ? '->' : '→';

  return [
    {
      title: 'Welcome',
      lines: [
        'Wunderland dashboard: quick actions + status at a glance.',
        '',
        `Use ${'/'} to filter actions like a command palette.`,
        `Use ${'?'} for contextual help overlays.`,
        `Use ${'t'} to open this tour anytime.`,
      ],
    },
    {
      title: 'Navigation',
      lines: [
        `${upDown} move   ${enter} run   esc back/close   q quit`,
        '',
        'Shortcuts: 1-7 jump to common actions (setup/chat/start/etc).',
      ],
    },
    {
      title: 'Search / Palette',
      lines: [
        `Press ${'/'} to enter search.`,
        'Type to filter. Backspace deletes.',
        'Press esc to exit search.',
      ],
    },
    {
      title: 'Drilldowns',
      lines: [
        'Doctor / Models / Skills / Extensions open drilldown views.',
        '',
        `Inside drilldowns: ${'/'} search, ${enter} details, ${'?'} help, esc back.`,
      ],
    },
    {
      title: 'First Run Path',
      lines: [
        `Recommended: setup ${arrow} doctor ${arrow} chat ${arrow} start`,
        '',
        'Setup writes config + env keys under your Wunderland config dir.',
      ],
    },
    {
      title: 'Style & Accessibility',
      lines: [
        'Theme defaults to plain (no color).',
        'Try: wunderland --theme cyberpunk',
        '',
        'ASCII mode: wunderland --ascii',
        'Persist: wunderland config set ui.theme cyberpunk',
        'Persist: wunderland config set ui.ascii true',
      ],
    },
  ];
}

export function getTourControlsLine(opts: { ascii: boolean }): string {
  if (opts.ascii) {
    return '[Enter] next  [b] back  [s] skip  [x] never show  [esc] close';
  }
  return '[⏎] next  [b] back  [s] skip  [x] never show  [esc] close';
}

