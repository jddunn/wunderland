/**
 * @fileoverview `wunderland list-presets` — display personality, HEXACO, and agent presets.
 * @module wunderland/cli/commands/list-presets
 */

import type { GlobalFlags } from '../types.js';
import { PERSONALITY_PRESETS } from '../constants.js';
import { accent, muted, info, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { printTable } from '../ui/table.js';
import { HEXACO_PRESETS } from '../../core/WunderlandSeed.js';
import { PresetLoader } from '../../core/PresetLoader.js';

export default async function cmdListPresets(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  // Load agent presets
  let agentPresets: ReturnType<PresetLoader['listPresets']> = [];
  try {
    const loader = new PresetLoader();
    agentPresets = loader.listPresets();
  } catch {
    // Non-fatal — presets dir might not exist
  }

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
      agentPresets: agentPresets.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        securityTier: p.securityTier,
        suggestedSkills: p.suggestedSkills,
        suggestedChannels: p.suggestedChannels,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ── Agent Presets ────────────────────────────────────────────────────────
  if (agentPresets.length > 0) {
    printTable({
      title: 'Agent Presets',
      compact: true,
      columns: [
        { label: 'ID', width: 22 },
        { label: 'Name', width: 26 },
        { label: 'Security', width: 12 },
        { label: 'Skills' },
      ],
      rows: agentPresets.map((p) => [
        accent(p.id),
        p.name,
        muted(p.securityTier),
        p.suggestedSkills.length > 0 ? info(p.suggestedSkills.join(dim(', '))) : dim('none'),
      ]),
    });
    fmt.blank();
  }

  // ── Personality Presets ─────────────────────────────────────────────────
  printTable({
    title: 'Personality Presets',
    compact: true,
    columns: [
      { label: 'ID', width: 24 },
      { label: 'Label', width: 24 },
      { label: 'Description' },
    ],
    rows: PERSONALITY_PRESETS.map((p) => [
      accent(p.id),
      p.label,
      muted(p.desc),
    ]),
  });

  fmt.blank();

  // ── HEXACO Trait Presets ──────────────────────────────────────────────
  const hexacoKeys = Object.keys(HEXACO_PRESETS);
  if (hexacoKeys.length > 0) {
    printTable({
      title: 'HEXACO Trait Presets',
      compact: true,
      columns: [
        { label: 'ID', width: 24 },
        { label: 'H', width: 7, align: 'right' },
        { label: 'E', width: 7, align: 'right' },
        { label: 'X', width: 7, align: 'right' },
        { label: 'A', width: 7, align: 'right' },
        { label: 'C', width: 7, align: 'right' },
        { label: 'O', width: 7, align: 'right' },
      ],
      rows: Object.entries(HEXACO_PRESETS).map(([key, values]) => [
        accent(key),
        info(values.honesty_humility?.toFixed(1) ?? '-'),
        info(values.emotionality?.toFixed(1) ?? '-'),
        info(values.extraversion?.toFixed(1) ?? '-'),
        info(values.agreeableness?.toFixed(1) ?? '-'),
        info(values.conscientiousness?.toFixed(1) ?? '-'),
        info(values.openness?.toFixed(1) ?? '-'),
      ]),
    });
    fmt.blank();
  }

  fmt.note(`Use with: ${accent('wunderland init my-agent --preset research-assistant')}`);
  fmt.blank();
}
