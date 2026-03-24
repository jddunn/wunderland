/**
 * @fileoverview `wunderland doctor` — health check: keys, tools, channels, connectivity.
 * Uses animated step progress with spinners for each diagnostic check.
 * @module wunderland/cli/commands/doctor
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { info as iColor, bright, dim, muted, accent, success as sColor, warn as wColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { createStepProgress } from '../ui/progress.js';
import { getConfigPath } from '../config/config-manager.js';
import { getEnvPath, loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { checkEnvSecrets } from '../config/secrets.js';
import { loadConfig } from '../config/config-manager.js';
import { execFile } from 'node:child_process';
import { URLS, LLM_PROVIDERS, TOOL_KEY_PROVIDERS } from '../constants.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function checkReachable(url: string, timeoutMs = 5000): Promise<{ ok: boolean; latency: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.ok || res.status < 500, latency: Date.now() - start };
  } catch {
    return { ok: false, latency: Date.now() - start };
  }
}

async function whichBinary(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [name], (err) => resolve(!err));
  });
}

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdDoctor(
  _args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  // Load env files so secrets are available
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const format = typeof _flags['format'] === 'string' ? _flags['format'] : 'table';

  // Build all step labels
  const configPath = getConfigPath(globals.config);
  const envPath = getEnvPath(globals.config);
  const localConfig = path.resolve(process.cwd(), 'agent.config.json');

  const secretStatus = checkEnvSecrets();
  const importantKeys = ['openai.apiKey', 'anthropic.apiKey', 'openrouter.apiKey', 'elevenlabs.apiKey'];
  const keyEntries = importantKeys.map((id) => secretStatus.find((x) => x.id === id)).filter(Boolean) as Array<(typeof secretStatus)[number]>;

  const channelSecrets = secretStatus.filter((s) =>
    s.providers.some((p) => ['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'imessage'].includes(p))
  );
  const seenPlatforms = new Set<string>();
  const platformChecks: { platform: string; allSet: boolean; anySet: boolean }[] = [];
  for (const s of channelSecrets) {
    const platform = s.providers[0];
    if (seenPlatforms.has(platform)) continue;
    seenPlatforms.add(platform);
    const platformSecrets = channelSecrets.filter((x) => x.providers.includes(platform));
    platformChecks.push({
      platform,
      allSet: platformSecrets.every((x) => x.isSet),
      anySet: platformSecrets.some((x) => x.isSet),
    });
  }

  const endpoints = [
    { label: 'OpenAI API', url: 'https://api.openai.com/v1/models' },
    { label: URLS.website, url: URLS.website },
  ];

  // ── JSON output ──────────────────────────────────────────────────────────
  if (format === 'json') {
    const connectivity: Array<{ label: string; url: string; ok: boolean; latency: number }> = [];
    for (const ep of endpoints) {
      const result = await checkReachable(ep.url);
      connectivity.push({ label: ep.label, url: ep.url, ok: result.ok, latency: result.latency });
    }

    const jsonConfig = await loadConfig();
    const gmailConnected = !!(process.env['GOOGLE_REFRESH_TOKEN'] || jsonConfig?.google?.refreshToken);

    const voiceChecks = [
      { name: 'OpenAI TTS/STT',      envVars: ['OPENAI_API_KEY'],                                  configured: Boolean(process.env['OPENAI_API_KEY']) },
      { name: 'ElevenLabs TTS',      envVars: ['ELEVENLABS_API_KEY'],                               configured: Boolean(process.env['ELEVENLABS_API_KEY']) },
      { name: 'Deepgram STT',        envVars: ['DEEPGRAM_API_KEY'],                                 configured: Boolean(process.env['DEEPGRAM_API_KEY']) },
      { name: 'AssemblyAI STT',      envVars: ['ASSEMBLYAI_API_KEY'],                               configured: Boolean(process.env['ASSEMBLYAI_API_KEY']) },
      { name: 'Azure Speech',        envVars: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'],          configured: Boolean(process.env['AZURE_SPEECH_KEY'] && process.env['AZURE_SPEECH_REGION']) },
      { name: 'Google Cloud STT',    envVars: ['GOOGLE_STT_CREDENTIALS'],                           configured: Boolean(process.env['GOOGLE_STT_CREDENTIALS']) },
      { name: 'Google Cloud TTS',    envVars: ['GOOGLE_TTS_CREDENTIALS'],                           configured: Boolean(process.env['GOOGLE_TTS_CREDENTIALS']) },
      { name: 'Amazon Polly',        envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],       configured: Boolean(process.env['AWS_ACCESS_KEY_ID'] && process.env['AWS_SECRET_ACCESS_KEY']) },
      { name: 'Twilio',              envVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],          configured: Boolean(process.env['TWILIO_ACCOUNT_SID'] && process.env['TWILIO_AUTH_TOKEN']) },
      { name: 'Telnyx',              envVars: ['TELNYX_API_KEY', 'TELNYX_CONNECTION_ID'],           configured: Boolean(process.env['TELNYX_API_KEY'] && process.env['TELNYX_CONNECTION_ID']) },
      { name: 'Plivo',               envVars: ['PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN'],                configured: Boolean(process.env['PLIVO_AUTH_ID'] && process.env['PLIVO_AUTH_TOKEN']) },
      { name: 'Porcupine Wake-Word', envVars: ['PICOVOICE_ACCESS_KEY'],                             configured: Boolean(process.env['PICOVOICE_ACCESS_KEY']) },
    ];

    const output = {
      configuration: {
        configJson: { path: configPath, exists: existsSync(configPath) },
        envFile: { path: envPath, exists: existsSync(envPath) },
        agentConfig: { path: localConfig, exists: existsSync(localConfig) },
      },
      apiKeys: keyEntries.map((k) => ({
        envVar: k.envVar,
        isSet: k.isSet,
        optional: k.optional,
        maskedValue: k.maskedValue,
      })),
      channels: platformChecks.map((pc) => ({
        platform: pc.platform,
        status: pc.allSet ? 'configured' : pc.anySet ? 'partial' : 'not_configured',
      })),
      email: {
        gmail: {
          connected: gmailConnected,
          email: jsonConfig?.google?.email || null,
        },
      },
      connectivity,
      voiceProviders: voiceChecks.map((vc) => ({
        name: vc.name,
        envVars: vc.envVars,
        configured: vc.configured,
      })),
    };

    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ── Table output ─────────────────────────────────────────────────────────
  fmt.section('Wunderland Doctor');
  fmt.blank();

  // Build step labels
  const stepLabels: string[] = [
    // Configuration
    `Config: ${path.basename(configPath)}`,
    `Config: .env`,
    `Config: agent.config.json`,
    // API Keys
    ...keyEntries.map((k) => `Key: ${k.envVar}`),
    // Channels
    ...platformChecks.map((p) => `Channel: ${p.platform}`),
    // Connectivity
    ...endpoints.map((ep) => `Connectivity: ${ep.label}`),
  ];

  const progress = createStepProgress(stepLabels);
  let stepIdx = 0;
  const g = glyphs();

  // 1. Configuration files
  console.log(`  ${iColor(g.bulletHollow)} ${bright('Configuration')}`);
  progress.start(stepIdx);
  if (existsSync(configPath)) {
    progress.pass(stepIdx);
  } else {
    progress.skip(stepIdx, 'not created yet (run wunderland setup)');
  }
  stepIdx++;

  progress.start(stepIdx);
  if (existsSync(envPath)) {
    progress.pass(stepIdx);
  } else {
    progress.skip(stepIdx, 'not created yet (run wunderland setup)');
  }
  stepIdx++;

  progress.start(stepIdx);
  if (existsSync(localConfig)) {
    progress.pass(stepIdx, 'project config found');
  } else {
    progress.skip(stepIdx, 'not in current directory');
  }
  stepIdx++;
  console.log();

  // 2. API Keys
  console.log(`  ${iColor(g.bulletHollow)} ${bright('API Keys')}`);
  for (const k of keyEntries) {
    progress.start(stepIdx);
    if (k.isSet) {
      progress.pass(stepIdx, `set (${k.maskedValue})`);
    } else if (k.optional) {
      progress.skip(stepIdx, 'not set (optional)');
    } else {
      progress.fail(stepIdx, 'not set');
      // Show signup URL hint
      const provider = LLM_PROVIDERS.find((p) => p.envVar === k.envVar);
      const toolProvider = TOOL_KEY_PROVIDERS.find((p) => p.envVar === k.envVar);
      const signupUrl = provider?.signupUrl || toolProvider?.signupUrl;
      if (signupUrl) {
        console.log(`       ${dim('→')} ${muted(signupUrl)}`);
      }
    }
    stepIdx++;
  }
  console.log();

  // 3. Channels
  console.log(`  ${iColor(g.bulletHollow)} ${bright('Channels')}`);
  for (const pc of platformChecks) {
    progress.start(stepIdx);
    if (pc.allSet) {
      progress.pass(stepIdx, 'configured');
    } else if (pc.anySet) {
      progress.pass(stepIdx, 'partially configured');
    } else {
      progress.skip(stepIdx, 'not configured');
    }
    stepIdx++;
  }
  console.log();

  // 4. Gmail / Email Intelligence
  console.log(`  ${iColor(g.bulletHollow)} ${bright('Email Intelligence')}`);
  {
    const config = await loadConfig();
    const hasRefreshToken = !!(process.env['GOOGLE_REFRESH_TOKEN'] || config?.google?.refreshToken);
    const gmailEmail = config?.google?.email;
    if (hasRefreshToken) {
      console.log(`    ${sColor(g.ok)} Gmail: connected${gmailEmail ? ` (${gmailEmail})` : ''}`);
    } else {
      console.log(`    ${wColor(g.warn)} Gmail: not connected — run ${accent("'wunderland connect gmail'")}`);
    }
  }
  console.log();

  // 5. WhatsApp
  console.log(`  ${iColor(g.bulletHollow)} ${bright('WhatsApp')}`);
  {
    const config = await loadConfig();
    const hasTwilio = !!(process.env['TWILIO_ACCOUNT_SID'] && process.env['TWILIO_AUTH_TOKEN']);
    const hasMeta = !!(process.env['META_WHATSAPP_TOKEN'] && process.env['META_WHATSAPP_PHONE_ID']);
    const hasConfig = !!(config as any)?.whatsapp;
    const twilioPhone = process.env['TWILIO_WHATSAPP_FROM'] || '';
    if (hasTwilio) {
      console.log(`    ${sColor(g.ok)} WhatsApp: connected via Twilio${twilioPhone ? ` (${twilioPhone})` : ''}`);
    } else if (hasMeta) {
      console.log(`    ${sColor(g.ok)} WhatsApp: connected via Meta Cloud API`);
    } else if (hasConfig) {
      console.log(`    ${sColor(g.ok)} WhatsApp: configured`);
    } else {
      console.log(`    ${wColor(g.warn)} WhatsApp: not connected — run ${accent("'wunderland connect whatsapp'")}`);
    }
  }
  console.log();

  // 6. Slack
  console.log(`  ${iColor(g.bulletHollow)} ${bright('Slack')}`);
  {
    const config = await loadConfig();
    const hasOAuth = !!process.env['SLACK_OAUTH_CLIENT_ID'];
    const hasBotToken = !!process.env['SLACK_BOT_TOKEN'];
    const hasConfig = !!(config as any)?.slack;
    const workspace = (config as any)?.slack?.workspace || '';
    if (hasBotToken || hasOAuth) {
      console.log(`    ${sColor(g.ok)} Slack: connected${workspace ? ` (${workspace})` : ''}`);
    } else if (hasConfig) {
      console.log(`    ${sColor(g.ok)} Slack: configured${workspace ? ` (${workspace})` : ''}`);
    } else {
      console.log(`    ${wColor(g.warn)} Slack: not connected — run ${accent("'wunderland connect slack'")}`);
    }
  }
  console.log();

  // 7. Signal
  console.log(`  ${iColor(g.bulletHollow)} ${bright('Signal')}`);
  {
    const config = await loadConfig();
    const hasSignalCli = await whichBinary('signal-cli');
    const phoneNumber = (config as any)?.signal?.phoneNumber || '';
    if (hasSignalCli && phoneNumber) {
      console.log(`    ${sColor(g.ok)} Signal: connected (${phoneNumber})`);
    } else if (hasSignalCli) {
      console.log(`    ${wColor(g.warn)} Signal: signal-cli found but not registered — run ${accent("'wunderland connect signal'")}`);
    } else {
      console.log(`    ${wColor(g.warn)} Signal: signal-cli not found — install with ${accent("'brew install signal-cli'")}`);
    }
  }
  console.log();

  // 8. Connectivity (async checks with live spinners)
  console.log(`  ${iColor(g.bulletHollow)} ${bright('Connectivity')}`);
  for (const ep of endpoints) {
    progress.start(stepIdx);
    const result = await checkReachable(ep.url);
    if (result.ok) {
      progress.pass(stepIdx, `reachable (${result.latency}ms)`);
    } else {
      progress.fail(stepIdx, `unreachable (${result.latency}ms)`);
    }
    stepIdx++;
  }

  // 9. Voice & Telephony Providers
  console.log();
  console.log(`  ${iColor(g.bulletHollow)} ${bright('Voice & Telephony Providers')}`);
  {
    const env = process.env;

    /** @type {Array<{ name: string; envVars: string[]; configured: boolean }>} */
    const voiceChecks = [
      { name: 'OpenAI TTS/STT',      envVars: ['OPENAI_API_KEY'],                                  configured: Boolean(env['OPENAI_API_KEY']) },
      { name: 'ElevenLabs TTS',      envVars: ['ELEVENLABS_API_KEY'],                               configured: Boolean(env['ELEVENLABS_API_KEY']) },
      { name: 'Deepgram STT',        envVars: ['DEEPGRAM_API_KEY'],                                 configured: Boolean(env['DEEPGRAM_API_KEY']) },
      { name: 'AssemblyAI STT',      envVars: ['ASSEMBLYAI_API_KEY'],                               configured: Boolean(env['ASSEMBLYAI_API_KEY']) },
      { name: 'Azure Speech',        envVars: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'],          configured: Boolean(env['AZURE_SPEECH_KEY'] && env['AZURE_SPEECH_REGION']) },
      { name: 'Google Cloud STT',    envVars: ['GOOGLE_STT_CREDENTIALS'],                           configured: Boolean(env['GOOGLE_STT_CREDENTIALS']) },
      { name: 'Google Cloud TTS',    envVars: ['GOOGLE_TTS_CREDENTIALS'],                           configured: Boolean(env['GOOGLE_TTS_CREDENTIALS']) },
      { name: 'Amazon Polly',        envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],       configured: Boolean(env['AWS_ACCESS_KEY_ID'] && env['AWS_SECRET_ACCESS_KEY']) },
      { name: 'Twilio',              envVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],          configured: Boolean(env['TWILIO_ACCOUNT_SID'] && env['TWILIO_AUTH_TOKEN']) },
      { name: 'Telnyx',              envVars: ['TELNYX_API_KEY', 'TELNYX_CONNECTION_ID'],           configured: Boolean(env['TELNYX_API_KEY'] && env['TELNYX_CONNECTION_ID']) },
      { name: 'Plivo',               envVars: ['PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN'],                configured: Boolean(env['PLIVO_AUTH_ID'] && env['PLIVO_AUTH_TOKEN']) },
      { name: 'Porcupine Wake-Word', envVars: ['PICOVOICE_ACCESS_KEY'],                             configured: Boolean(env['PICOVOICE_ACCESS_KEY']) },
    ];

    for (const vc of voiceChecks) {
      const envLabel = vc.envVars.join(', ');
      if (vc.configured) {
        console.log(`    ${sColor(g.ok)} ${vc.name.padEnd(24)} ${dim(envLabel)}`);
      } else {
        console.log(`    ${wColor(g.warn)} ${vc.name.padEnd(24)} ${muted(envLabel + ' (not set)')}`);
      }
    }
  }
  console.log();

  // Summary
  progress.complete();
  fmt.blank();
}
