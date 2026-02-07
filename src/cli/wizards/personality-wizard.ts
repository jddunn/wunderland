/**
 * @fileoverview Personality wizard — HEXACO preset picker or custom sliders.
 * @module wunderland/cli/wizards/personality-wizard
 */

import * as p from '@clack/prompts';
import type { WizardState } from '../types.js';
import { PERSONALITY_PRESETS } from '../constants.js';
import { dim } from '../ui/theme.js';

const HEXACO_TRAITS = [
  { key: 'honesty_humility', label: 'Honesty-Humility', desc: 'sincerity, fairness, modesty' },
  { key: 'emotionality', label: 'Emotionality', desc: 'anxiety, sentimentality, dependence' },
  { key: 'extraversion', label: 'Extraversion', desc: 'expressiveness, social boldness, liveliness' },
  { key: 'agreeableness', label: 'Agreeableness', desc: 'patience, tolerance, gentleness' },
  { key: 'conscientiousness', label: 'Conscientiousness', desc: 'organization, perfectionism, diligence' },
  { key: 'openness', label: 'Openness to Experience', desc: 'creativity, unconventionality, curiosity' },
] as const;

export async function runPersonalityWizard(state: WizardState): Promise<void> {
  const presetOptions = [
    ...PERSONALITY_PRESETS.map((preset) => ({
      value: preset.id,
      label: preset.label,
      hint: preset.desc,
    })),
    { value: 'custom', label: 'Custom HEXACO...', hint: 'set each trait manually' },
  ];

  const selected = await p.select({
    message: 'Agent personality preset:',
    options: presetOptions,
  });

  if (p.isCancel(selected)) return;

  if (selected === 'custom') {
    state.personalityPreset = 'custom';
    state.customHexaco = {};

    for (const trait of HEXACO_TRAITS) {
      const value = await p.text({
        message: `${trait.label} (${dim(trait.desc)}):`,
        placeholder: '0.5',
        defaultValue: '0.5',
        validate: (val: string) => {
          const n = parseFloat(val);
          if (isNaN(n) || n < 0 || n > 1) return 'Must be a number between 0.0 and 1.0';
          return undefined;
        },
      });

      if (p.isCancel(value)) break;
      state.customHexaco[trait.key] = parseFloat(value);
    }
  } else {
    state.personalityPreset = selected as string;
  }
}
