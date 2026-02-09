/**
 * @fileoverview `wunderland doctor` — health check: keys, tools, channels, connectivity.
 * @module wunderland/cli/commands/doctor
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { GlobalFlags, DiagnosticSection, DiagnosticCheck } from '../types.js';
import { success as sColor, error as eColor, muted, dim, accent, info as iColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { getConfigPath } from '../config/config-manager.js';
import { getEnvPath, loadDotEnvIntoProcessUpward } from '../config/env-manager.js';
import { checkEnvSecrets } from '../config/secrets.js';
import { URLS } from '../constants.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function checkLabel(c: DiagnosticCheck): string {
  const icon = c.status === 'pass' ? sColor('\u2713') : c.status === 'fail' ? eColor('\u2717') : muted('\u25CB');
  const label = c.status === 'fail' ? eColor(c.label) : c.status === 'skip' ? muted(c.label) : c.label;
  const detail = c.detail ? `  ${dim(c.detail)}` : '';
  return `  ${icon} ${label.padEnd(24)}${detail}`;
}

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

  const sections: DiagnosticSection[] = [];

  // 1. Configuration files
  const configChecks: DiagnosticCheck[] = [];
  const configPath = getConfigPath(globals.config);
  configChecks.push({
    label: configPath,
    status: existsSync(configPath) ? 'pass' : 'skip',
    detail: existsSync(configPath) ? undefined : 'not created yet (run wunderland setup)',
  });
  const envPath = getEnvPath(globals.config);
  configChecks.push({
    label: envPath,
    status: existsSync(envPath) ? 'pass' : 'skip',
    detail: existsSync(envPath) ? undefined : 'not created yet (run wunderland setup)',
  });
  const localConfig = path.resolve(process.cwd(), 'agent.config.json');
  configChecks.push({
    label: 'agent.config.json',
    status: existsSync(localConfig) ? 'pass' : 'skip',
    detail: existsSync(localConfig) ? 'project config found' : 'not in current directory',
  });
  sections.push({ title: 'Configuration', checks: configChecks });

  // 2. API Keys
  const secretStatus = checkEnvSecrets();
  const keyChecks: DiagnosticCheck[] = [];

  // Show important keys first
  const importantKeys = ['openai.apiKey', 'anthropic.apiKey', 'openrouter.apiKey', 'elevenlabs.apiKey'];
  for (const keyId of importantKeys) {
    const s = secretStatus.find((x) => x.id === keyId);
    if (!s) continue;
    keyChecks.push({
      label: s.envVar,
      status: s.isSet ? 'pass' : (s.optional ? 'skip' : 'fail'),
      detail: s.isSet ? `set (${s.maskedValue})` : (s.optional ? 'not set (optional)' : 'not set'),
    });
  }
  sections.push({ title: 'API Keys', checks: keyChecks });

  // 3. Channels
  const channelSecrets = secretStatus.filter((s) =>
    s.providers.some((p) => ['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'imessage'].includes(p))
  );
  const channelChecks: DiagnosticCheck[] = [];
  const seenPlatforms = new Set<string>();
  for (const s of channelSecrets) {
    const platform = s.providers[0];
    if (seenPlatforms.has(platform)) continue;
    seenPlatforms.add(platform);
    const platformSecrets = channelSecrets.filter((x) => x.providers.includes(platform));
    const allSet = platformSecrets.every((x) => x.isSet);
    const anySet = platformSecrets.some((x) => x.isSet);
    channelChecks.push({
      label: platform,
      status: allSet ? 'pass' : anySet ? 'pass' : 'skip',
      detail: allSet ? 'configured' : anySet ? 'partially configured' : 'not configured',
    });
  }
  sections.push({ title: 'Channels', checks: channelChecks });

  // 4. Connectivity
  const connectivityChecks: DiagnosticCheck[] = [];
  const endpoints = [
    { label: 'OpenAI API', url: 'https://api.openai.com/v1/models' },
    { label: URLS.website, url: URLS.website },
  ];
  for (const ep of endpoints) {
    const result = await checkReachable(ep.url);
    connectivityChecks.push({
      label: ep.label,
      status: result.ok ? 'pass' : 'fail',
      detail: result.ok ? `reachable (${result.latency}ms)` : `unreachable (${result.latency}ms)`,
    });
  }
  sections.push({ title: 'Connectivity', checks: connectivityChecks });

  // Render
  fmt.section('Wunderland Doctor');
  fmt.blank();

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const s of sections) {
    console.log(`  ${iColor('\u25C7')} ${s.title}`);
    for (const c of s.checks) {
      console.log(checkLabel(c));
      if (c.status === 'pass') passed++;
      else if (c.status === 'fail') failed++;
      else skipped++;
    }
    console.log();
  }

  // Summary
  const summary = [
    sColor(`${passed} passed`),
    skipped > 0 ? muted(`${skipped} optional skipped`) : '',
    failed > 0 ? eColor(`${failed} errors`) : '',
  ].filter(Boolean).join(dim(', '));

  console.log(`  ${accent('\u25C6')} ${summary}`);
  fmt.blank();

  if (failed > 0) process.exitCode = 1;
}
