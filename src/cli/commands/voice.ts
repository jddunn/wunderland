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

import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createSpeechRuntimeFromEnv } from '@framers/agentos/speech';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, warn as wColor, muted, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadEnv } from '../config/env-manager.js';
import { checkEnvSecrets } from '../config/secrets.js';
import {
  fileExtensionForSpeechMimeType,
  getPreferredRuntimeTtsProviderId,
  getSpeechProviderEntry,
  getSpeechProviders,
  isSpeechProviderConfigured,
} from '../../voice/speech-catalog.js';

// ── Subcommand: status (telephony) ──

async function voiceStatus(globals: GlobalFlags): Promise<void> {
  fmt.section('Telephony Providers');
  fmt.blank();

  const env = await loadEnv(globals.config);
  const secretStatus = checkEnvSecrets();

  for (const provider of getSpeechProviders('telephony')) {
    const allSet = isSpeechProviderConfigured(provider, env);
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

  for (const provider of getSpeechProviders('tts')) {
    const isConfigured = isSpeechProviderConfigured(provider, env);
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

  for (const provider of getSpeechProviders('stt')) {
    const isConfigured = isSpeechProviderConfigured(provider, env);
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
  const runtimeEnv: Record<string, string | undefined> = {
    ...env,
    ...process.env,
  };
  const providerId = getPreferredRuntimeTtsProviderId(runtimeEnv);

  if (!providerId) {
    fmt.note(
      `No runtime-backed TTS provider is configured.\n` +
      `    Set ${accent('OPENAI_API_KEY')} or ${accent('ELEVENLABS_API_KEY')} and retry.`,
    );
    fmt.blank();
    return;
  }

  const runtime = createSpeechRuntimeFromEnv(runtimeEnv);
  const session = runtime.createSession({ ttsProviderId: providerId });
  const providerLabel =
    getSpeechProviders('tts').find((provider) => provider.id === providerId)?.label ??
    getSpeechProviderEntry(providerId).label;

  console.log(`    Provider:  ${accent(providerLabel)}`);
  console.log(`    Text:      ${dim(text.length > 80 ? text.slice(0, 80) + '...' : text)}`);
  fmt.blank();

  try {
    const result = await session.speak(text, { outputFormat: 'mp3' });
    const extension = fileExtensionForSpeechMimeType(result.mimeType);
    const outputPath = path.resolve(
      process.cwd(),
      `tts-output-${providerId}-${Date.now()}.${extension}`,
    );
    await writeFile(outputPath, result.audioBuffer);

    fmt.ok(`Synthesized ${accent(text.length.toString())} characters with ${accent(providerLabel)}.`);
    fmt.note(`Audio file: ${accent(outputPath)}`);
  } catch (error) {
    fmt.errorBlock(
      'Speech synthesis failed',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
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
