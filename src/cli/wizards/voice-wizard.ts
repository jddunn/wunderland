/**
 * @fileoverview Voice wizard — multi-provider TTS and STT configuration.
 * @module wunderland/cli/wizards/voice-wizard
 */

import * as p from '@clack/prompts';
import type { WizardState } from '../types.js';
import * as fmt from '../ui/format.js';

// ── TTS Provider Setup ──

async function configureTtsProvider(state: WizardState): Promise<void> {
  const ttsChoice = await p.select({
    message: 'Select a TTS (Text-to-Speech) provider:',
    options: [
      { value: 'openai', label: 'OpenAI TTS', hint: 'tts-1, streaming, 6 voices' },
      { value: 'elevenlabs', label: 'ElevenLabs', hint: 'turbo v2.5, voice cloning' },
      { value: 'piper', label: 'Piper (Local)', hint: 'free, offline, ONNX models' },
      { value: 'skip', label: 'Skip TTS setup' },
    ],
  });

  if (p.isCancel(ttsChoice) || ttsChoice === 'skip') return;

  if (ttsChoice === 'openai') {
    const existing = process.env['OPENAI_API_KEY'];
    let apiKey: string;

    if (existing) {
      fmt.ok('OpenAI API Key: already set in environment');
      apiKey = existing;
    } else {
      const keyInput = await p.password({
        message: 'OpenAI API Key:',
        validate: (val: string) => {
          if (!val.trim()) return 'API key is required';
          return undefined;
        },
      });
      if (p.isCancel(keyInput)) return;
      apiKey = keyInput as string;
      fmt.note('Get one at: https://platform.openai.com/api-keys');
    }

    const model = await p.select({
      message: 'TTS model:',
      options: [
        { value: 'tts-1', label: 'TTS-1', hint: 'fast, good quality' },
        { value: 'tts-1-hd', label: 'TTS-1 HD', hint: 'higher quality, slower' },
        { value: 'gpt-4o-mini-tts', label: 'GPT-4o Mini TTS', hint: 'newest, expressive' },
      ],
    });
    if (p.isCancel(model)) return;

    const voice = await p.select({
      message: 'Default voice:',
      options: [
        { value: 'nova', label: 'Nova', hint: 'female, clear and friendly' },
        { value: 'alloy', label: 'Alloy', hint: 'neutral, balanced' },
        { value: 'echo', label: 'Echo', hint: 'male, warm' },
        { value: 'onyx', label: 'Onyx', hint: 'male, deep and authoritative' },
        { value: 'fable', label: 'Fable', hint: 'neutral, storytelling' },
        { value: 'shimmer', label: 'Shimmer', hint: 'female, soft and gentle' },
      ],
    });
    if (p.isCancel(voice)) return;

    state.voice = {
      provider: 'openai',
      apiKey,
      model: model as string,
      voice: voice as string,
    };
  }

  if (ttsChoice === 'elevenlabs') {
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

  if (ttsChoice === 'piper') {
    fmt.note(
      'Piper runs locally - no API key required.\n' +
      '    Install: https://github.com/rhasspy/piper\n' +
      '    Ensure the `piper` binary is on your PATH.',
    );

    const voiceModel = await p.select({
      message: 'Piper voice model:',
      options: [
        { value: 'en_US-lessac-medium', label: 'Lessac (Medium)', hint: 'US English, recommended' },
        { value: 'en_US-amy-medium', label: 'Amy (Medium)', hint: 'US English, female' },
        { value: 'en_GB-alan-medium', label: 'Alan (Medium)', hint: 'British English, male' },
      ],
    });
    if (p.isCancel(voiceModel)) return;

    state.voice = {
      provider: 'piper',
      model: voiceModel as string,
    };
  }
}

// ── STT Provider Setup ──

async function configureSttProvider(state: WizardState): Promise<void> {
  const sttChoice = await p.select({
    message: 'Select an STT (Speech-to-Text) provider:',
    options: [
      { value: 'openai', label: 'OpenAI Whisper', hint: 'batch, word timestamps' },
      { value: 'deepgram', label: 'Deepgram', hint: 'real-time streaming, nova-2' },
      { value: 'whisper-local', label: 'Whisper.cpp (Local)', hint: 'free, offline' },
      { value: 'skip', label: 'Skip STT setup' },
    ],
  });

  if (p.isCancel(sttChoice) || sttChoice === 'skip') return;

  if (sttChoice === 'openai') {
    const existing = process.env['OPENAI_API_KEY'];
    if (existing || state.voice?.provider === 'openai') {
      fmt.ok('OpenAI API Key: already configured');
    } else {
      const keyInput = await p.password({
        message: 'OpenAI API Key:',
        validate: (val: string) => {
          if (!val.trim()) return 'API key is required';
          return undefined;
        },
      });
      if (p.isCancel(keyInput)) return;
    }

    state.stt = { provider: 'openai-whisper', model: 'whisper-1' };
  }

  if (sttChoice === 'deepgram') {
    const existing = process.env['DEEPGRAM_API_KEY'];
    let apiKey: string;

    if (existing) {
      fmt.ok('Deepgram API Key: already set in environment');
      apiKey = existing;
    } else {
      const keyInput = await p.password({
        message: 'Deepgram API Key:',
        validate: (val: string) => {
          if (!val.trim()) return 'API key is required';
          return undefined;
        },
      });
      if (p.isCancel(keyInput)) return;
      apiKey = keyInput as string;
      fmt.note('Get one at: https://console.deepgram.com/');
    }

    state.stt = { provider: 'deepgram', apiKey, model: 'nova-2' };
  }

  if (sttChoice === 'whisper-local') {
    fmt.note(
      'Whisper.cpp runs locally - no API key required.\n' +
      '    Install: https://github.com/ggerganov/whisper.cpp\n' +
      '    Ensure the `whisper` binary is on your PATH.',
    );

    const model = await p.select({
      message: 'Whisper model size:',
      options: [
        { value: 'base', label: 'Base', hint: '~150MB, fast, decent accuracy' },
        { value: 'small', label: 'Small', hint: '~500MB, good balance' },
        { value: 'medium', label: 'Medium', hint: '~1.5GB, better accuracy' },
        { value: 'large-v3', label: 'Large v3', hint: '~3GB, best accuracy' },
      ],
    });
    if (p.isCancel(model)) return;

    state.stt = { provider: 'whisper-local', model: model as string };
  }
}

// ── Main Wizard Entry ──

export async function runVoiceWizard(state: WizardState): Promise<void> {
  const wantVoice = await p.confirm({
    message: 'Configure voice synthesis (TTS) and transcription (STT)?',
    initialValue: false,
  });

  if (p.isCancel(wantVoice) || !wantVoice) return;

  await configureTtsProvider(state);
  await configureSttProvider(state);
}
