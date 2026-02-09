/**
 * @fileoverview Voice wizard — ElevenLabs / TTS configuration.
 * @module wunderland/cli/wizards/voice-wizard
 */

import * as p from '@clack/prompts';
import type { WizardState } from '../types.js';
import * as fmt from '../ui/format.js';

export async function runVoiceWizard(state: WizardState): Promise<void> {
  const wantVoice = await p.confirm({
    message: 'Configure voice synthesis (ElevenLabs)?',
    initialValue: false,
  });

  if (p.isCancel(wantVoice) || !wantVoice) return;

  // Check env first
  const existing = process.env['ELEVENLABS_API_KEY'];
  let apiKey: string;

  if (existing) {
    fmt.ok('ElevenLabs API Key: already set in environment');
    apiKey = existing;
  } else {
    const keyInput = await p.password({
      message: 'ElevenLabs API Key:',
      validate: (val: string) => {
        if (!val.trim()) return 'API key is required';
        return undefined;
      },
    });

    if (p.isCancel(keyInput)) return;
    apiKey = keyInput as string;
    fmt.note('Get one at: https://elevenlabs.io/docs/api-reference/authentication');
  }

  const model = await p.select({
    message: 'Voice model:',
    options: [
      { value: 'eleven_turbo_v2_5', label: 'Turbo v2.5', hint: 'fast, recommended' },
      { value: 'eleven_multilingual_v2', label: 'Multilingual v2', hint: '29 languages' },
      { value: 'eleven_monolingual_v1', label: 'Monolingual v1', hint: 'English only' },
    ],
  });

  if (p.isCancel(model)) return;

  state.voice = {
    provider: 'elevenlabs',
    apiKey,
    model: model as string,
  };
}
