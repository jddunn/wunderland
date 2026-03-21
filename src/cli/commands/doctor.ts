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

  // 5. Connectivity (async checks with live spinners)
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

  // Summary
  progress.complete();
  fmt.blank();
}
