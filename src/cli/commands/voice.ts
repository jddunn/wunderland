/**
 * @fileoverview `wunderland voice` — voice call, TTS, and STT provider management.
 *
 * Subcommands:
 *   status  — Show telephony provider configuration (default)
 *   tts     — List TTS providers and their status
 *   stt     — List STT providers and their status
 *   test    — Synthesize test audio with configured TTS
 *   clone   — Interactive voice cloning wizard
 */

import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, warn as wColor, muted, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadEnv } from '../config/env-manager.js';
import { checkEnvSecrets } from '../config/secrets.js';

// ── Telephony providers ──

const VOICE_PROVIDERS = [
  { id: 'twilio', label: 'Twilio', envVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] },
  { id: 'telnyx', label: 'Telnyx', envVars: ['TELNYX_API_KEY', 'TELNYX_CONNECTION_ID'] },
  { id: 'plivo', label: 'Plivo', envVars: ['PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN'] },
] as const;

// ── TTS providers ──

const TTS_PROVIDERS = [
  { id: 'openai', label: 'OpenAI TTS', envVars: ['OPENAI_API_KEY'], local: false, streaming: true },
  { id: 'elevenlabs', label: 'ElevenLabs', envVars: ['ELEVENLABS_API_KEY'], local: false, streaming: true },
  { id: 'google-cloud', label: 'Google Cloud TTS', envVars: ['GOOGLE_TTS_CREDENTIALS'], local: false, streaming: false },
  { id: 'amazon-polly', label: 'Amazon Polly', envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], local: false, streaming: true },
  { id: 'azure', label: 'Azure Speech TTS', envVars: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'], local: false, streaming: true },
  { id: 'piper', label: 'Piper (Local)', envVars: [], local: true, streaming: false },
  { id: 'coqui', label: 'Coqui/XTTS (Local)', envVars: [], local: true, streaming: true },
  { id: 'bark', label: 'Bark (Local)', envVars: [], local: true, streaming: false },
  { id: 'styletts2', label: 'StyleTTS2 (Local)', envVars: [], local: true, streaming: false },
] as const;

// ── STT providers ──

const STT_PROVIDERS = [
  { id: 'openai-whisper', label: 'OpenAI Whisper', envVars: ['OPENAI_API_KEY'], local: false, streaming: false },
  { id: 'deepgram', label: 'Deepgram', envVars: ['DEEPGRAM_API_KEY'], local: false, streaming: true },
  { id: 'assemblyai', label: 'AssemblyAI', envVars: ['ASSEMBLYAI_API_KEY'], local: false, streaming: true },
  { id: 'google-cloud', label: 'Google Cloud STT', envVars: ['GOOGLE_STT_CREDENTIALS'], local: false, streaming: true },
  { id: 'azure', label: 'Azure Speech STT', envVars: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'], local: false, streaming: true },
  { id: 'whisper-local', label: 'Whisper.cpp (Local)', envVars: [], local: true, streaming: false },
  { id: 'vosk', label: 'Vosk (Local)', envVars: [], local: true, streaming: true },
  { id: 'nvidia-nemo', label: 'NVIDIA NeMo (Local)', envVars: [], local: true, streaming: false },
] as const;

// ── Subcommand: status (telephony) ──

async function voiceStatus(globals: GlobalFlags): Promise<void> {
  fmt.section('Telephony Providers');
  fmt.blank();

  const env = await loadEnv(globals.config);
  const secretStatus = checkEnvSecrets();

  for (const provider of VOICE_PROVIDERS) {
    const allSet = provider.envVars.every(v => !!(env[v] || process.env[v]));
    const status = allSet ? sColor('configured') : wColor('not configured');
    console.log(`    ${accent(provider.label.padEnd(20))} ${status}`);

    for (const envVar of provider.envVars) {
      const secret = secretStatus.find(s => s.envVar === envVar);
      const isSet = !!(env[envVar] || process.env[envVar]);
      const val = isSet ? dim(secret?.maskedValue || 'set') : muted('not set');
      console.log(`      ${dim(envVar.padEnd(28))} ${val}`);
    }
  }
  fmt.blank();
  fmt.note(`Configure voice providers via ${accent('wunderland setup')} or by setting environment variables.`);
  fmt.blank();
}

// ── Subcommand: tts ──

async function voiceTts(globals: GlobalFlags): Promise<void> {
  fmt.section('TTS (Text-to-Speech) Providers');
  fmt.blank();

  const env = await loadEnv(globals.config);

  for (const provider of TTS_PROVIDERS) {
    const isConfigured = provider.local || provider.envVars.every(v => !!(env[v] || process.env[v]));
    const status = isConfigured
      ? provider.local ? sColor('available (local)') : sColor('configured')
      : wColor('not configured');
    const streaming = provider.streaming ? dim(' [streaming]') : '';
    console.log(`    ${accent(provider.label.padEnd(24))} ${status}${streaming}`);

    if (!provider.local) {
      for (const envVar of provider.envVars) {
        const isSet = !!(env[envVar] || process.env[envVar]);
        const val = isSet ? dim('set') : muted('not set');
        console.log(`      ${dim(envVar.padEnd(28))} ${val}`);
      }
    }
  }

  fmt.blank();
  fmt.note(`Local providers require their binaries installed. Cloud providers need API keys.`);
  fmt.note(`See ${accent('wunderland voice test <text>')} to test TTS output.`);
  fmt.blank();
}

// ── Subcommand: stt ──

async function voiceStt(globals: GlobalFlags): Promise<void> {
  fmt.section('STT (Speech-to-Text) Providers');
  fmt.blank();

  const env = await loadEnv(globals.config);

  for (const provider of STT_PROVIDERS) {
    const isConfigured = provider.local || provider.envVars.every(v => !!(env[v] || process.env[v]));
    const status = isConfigured
      ? provider.local ? sColor('available (local)') : sColor('configured')
      : wColor('not configured');
    const streaming = provider.streaming ? dim(' [streaming]') : '';
    console.log(`    ${accent(provider.label.padEnd(24))} ${status}${streaming}`);

    if (!provider.local) {
      for (const envVar of provider.envVars) {
        const isSet = !!(env[envVar] || process.env[envVar]);
        const val = isSet ? dim('set') : muted('not set');
        console.log(`      ${dim(envVar.padEnd(28))} ${val}`);
      }
    }
  }

  fmt.blank();
  fmt.note(`Local providers require their binaries/models installed.`);
  fmt.blank();
}

// ── Subcommand: test ──

async function voiceTest(args: string[], globals: GlobalFlags): Promise<void> {
  const text = args.join(' ').trim();
  if (!text) {
    fmt.errorBlock('Missing text', 'Usage: wunderland voice test <text to synthesize>');
    process.exitCode = 1;
    return;
  }

  fmt.section('TTS Test');
  fmt.blank();

  const env = await loadEnv(globals.config);

  // Try providers in priority order: OpenAI → ElevenLabs → Piper
  let providerLabel: string | null = null;

  if (env['OPENAI_API_KEY'] || process.env['OPENAI_API_KEY']) {
    providerLabel = 'OpenAI TTS';
  } else if (env['ELEVENLABS_API_KEY'] || process.env['ELEVENLABS_API_KEY']) {
    providerLabel = 'ElevenLabs';
  } else {
    providerLabel = 'Piper (local)';
  }

  console.log(`    Provider:  ${accent(providerLabel)}`);
  console.log(`    Text:      ${dim(text.length > 80 ? text.slice(0, 80) + '...' : text)}`);
  fmt.blank();

  // Note: Actual synthesis requires the extension packs to be loaded at runtime.
  // This CLI command verifies configuration and provider availability.
  fmt.note(
    `To synthesize audio at runtime, ensure the TTS extension pack is installed.\n` +
    `    Example: ${accent('@framers/agentos-ext-tts-openai')} for OpenAI TTS.\n` +
    `    The synthesized audio file will be written to ${dim('./tts-output.mp3')} when run via the agent runtime.`,
  );
  fmt.blank();
}

// ── Subcommand: clone ──

async function voiceClone(): Promise<void> {
  fmt.section('Voice Cloning');
  fmt.blank();

  fmt.note(
    `Voice cloning requires explicit consent from the voice owner.\n` +
    `    Supported providers:\n` +
    `      ${accent('ElevenLabs')}  - Instant voice cloning via API (cloud)\n` +
    `      ${accent('XTTS v2')}     - Local voice cloning via Coqui TTS (offline)\n`,
  );
  fmt.blank();

  // Note: Interactive cloning wizard will be wired when the cloning
  // extension packs (Sprint 5) are complete.
  fmt.note(
    `The interactive cloning wizard will be available after installing a cloning extension.\n` +
    `    Use ${accent('wunderland setup')} to configure voice cloning providers.`,
  );
  fmt.blank();
}

// ── Main command router ──

const SUBCOMMANDS = ['status', 'tts', 'stt', 'test', 'clone'] as const;

export default async function cmdVoice(
  args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const sub = args[0];

  if (sub === 'status' || !sub) {
    await voiceStatus(globals);
    return;
  }

  if (sub === 'tts') {
    await voiceTts(globals);
    return;
  }

  if (sub === 'stt') {
    await voiceStt(globals);
    return;
  }

  if (sub === 'test') {
    await voiceTest(args.slice(1), globals);
    return;
  }

  if (sub === 'clone') {
    await voiceClone();
    return;
  }

  fmt.errorBlock(
    'Unknown subcommand',
    `"${sub}" is not a voice subcommand. Available: ${SUBCOMMANDS.join(', ')}`,
  );
  process.exitCode = 1;
}
