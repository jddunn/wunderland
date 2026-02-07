/**
 * @fileoverview `wunderland list-presets` — display HEXACO personality and agent template presets.
 * @module wunderland/cli/commands/list-presets
 */

import chalk from 'chalk';
import type { GlobalFlags } from '../types.js';
import { PERSONALITY_PRESETS } from '../constants.js';
import { accent, dim, muted } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { HEXACO_PRESETS } from '../../core/WunderlandSeed.js';

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdListPresets(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  if (format === 'json') {
    const output = {
      personalityPresets: PERSONALITY_PRESETS.map((p) => ({
        id: p.id,
        label: p.label,
        description: p.desc,
      })),
      hexacoPresets: Object.entries(HEXACO_PRESETS).map(([key, values]) => ({
        id: key,
        ...values,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Table format
  fmt.section('Personality Presets');
  fmt.blank();
  console.log(`    ${chalk.white('ID'.padEnd(26))} ${chalk.white('Label'.padEnd(24))} ${chalk.white('Description')}`);
  console.log(`    ${dim('\u2500'.repeat(26))} ${dim('\u2500'.repeat(24))} ${dim('\u2500'.repeat(36))}`);

  for (const preset of PERSONALITY_PRESETS) {
    console.log(`    ${accent(preset.id.padEnd(26))} ${preset.label.padEnd(24)} ${muted(preset.desc)}`);
  }

  fmt.blank();

  // HEXACO raw presets
  const hexacoKeys = Object.keys(HEXACO_PRESETS);
  if (hexacoKeys.length > 0) {
    fmt.section('HEXACO Trait Presets');
    fmt.blank();
    console.log(`    ${chalk.white('ID'.padEnd(26))} ${chalk.white('H'.padEnd(6))} ${chalk.white('E'.padEnd(6))} ${chalk.white('X'.padEnd(6))} ${chalk.white('A'.padEnd(6))} ${chalk.white('C'.padEnd(6))} ${chalk.white('O')}`);
    console.log(`    ${dim('\u2500'.repeat(26))} ${dim('\u2500'.repeat(6))} ${dim('\u2500'.repeat(6))} ${dim('\u2500'.repeat(6))} ${dim('\u2500'.repeat(6))} ${dim('\u2500'.repeat(6))} ${dim('\u2500'.repeat(6))}`);

    for (const [key, values] of Object.entries(HEXACO_PRESETS)) {
      const h = values.honesty_humility?.toFixed(1) ?? '—';
      const e = values.emotionality?.toFixed(1) ?? '—';
      const x = values.extraversion?.toFixed(1) ?? '—';
      const a = values.agreeableness?.toFixed(1) ?? '—';
      const c = values.conscientiousness?.toFixed(1) ?? '—';
      const o = values.openness?.toFixed(1) ?? '—';
      console.log(`    ${accent(key.padEnd(26))} ${muted(h.padEnd(6))} ${muted(e.padEnd(6))} ${muted(x.padEnd(6))} ${muted(a.padEnd(6))} ${muted(c.padEnd(6))} ${muted(o)}`);
    }
    fmt.blank();
  }

  fmt.note(`Use with: ${accent('wunderland init my-agent --preset HELPFUL_ASSISTANT')}`);
  fmt.blank();
}
