/**
 * @fileoverview `wunderland channels` — list, add, remove channel configurations.
 * @module wunderland/cli/commands/channels
 */

import type { GlobalFlags } from '../types.js';
import { CHANNEL_PLATFORMS } from '../constants.js';
import { accent, success as sColor, channel as cColor, warn as wColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { getUiRuntime } from '../ui/runtime.js';
import { loadConfig, updateConfig } from '../config/config-manager.js';
import { loadEnv, mergeEnv } from '../config/env-manager.js';
import { getSecretsForPlatform } from '../config/secrets.js';

const CHANNEL_ALIASES: Record<string, string> = {
  'blog-publisher': 'devto',
  'blog publisher': 'devto',
  'dev.to': 'devto',
  hashnode: 'devto',
  medium: 'devto',
  wordpress: 'devto',
};

function normalizeChannelId(channelId: string): string {
  const normalized = channelId.trim().toLowerCase();
  return CHANNEL_ALIASES[normalized] ?? normalized;
}

// ── Sub-commands ────────────────────────────────────────────────────────────

async function listChannels(globals: GlobalFlags): Promise<void> {
  const config = await loadConfig(globals.config);
  const env = await loadEnv(globals.config);
  const ui = getUiRuntime();
  const activeChannels = config.channels || [];

  fmt.section('Channel Bindings');
  fmt.blank();

  if (activeChannels.length === 0) {
    fmt.skip('No channels configured.');
    fmt.blank();
    fmt.note(`Run ${accent('wunderland channels add')} or ${accent('wunderland setup')} to configure channels.`);
    fmt.blank();
    return;
  }

  for (const channelId of activeChannels) {
    const normalizedChannelId = normalizeChannelId(channelId);
    const platform = CHANNEL_PLATFORMS.find((p) => p.id === normalizedChannelId);
    const label = platform ? `${ui.ascii ? '' : `${platform.icon}  `}${platform.label}` : channelId;
    const secrets = getSecretsForPlatform(normalizedChannelId);
    const allSet = secrets.length === 0 || secrets.every((s) => !!env[s.envVar]);
    const status = allSet ? sColor('ready') : wColor('needs credentials');
    console.log(`    ${cColor(label.padEnd(24))} ${status}`);
  }
  fmt.blank();
}

async function addChannel(args: string[], globals: GlobalFlags): Promise<void> {
  const platformId = args[0];

  if (!platformId) {
    // Interactive mode — use @clack/prompts
    const ui = getUiRuntime();
    const p = await import('@clack/prompts');
    const options = CHANNEL_PLATFORMS.map((ch) => ({
      value: ch.id as string,
      label: `${ui.ascii ? '' : `${ch.icon}  `}${ch.label}`,
      hint: ch.tier === 'p0' ? 'recommended' : ch.tier === 'p1' ? 'beta' : 'experimental',
    }));

    const selected = await p.select({
      message: 'Which channel do you want to add?',
      options,
    });

    if (p.isCancel(selected)) {
      fmt.blank();
      fmt.note('Cancelled.');
      return;
    }

    await addChannelById(selected as string, globals);
    return;
  }

  await addChannelById(platformId, globals);
}

async function addChannelById(platformId: string, globals: GlobalFlags): Promise<void> {
  const normalizedPlatformId = normalizeChannelId(platformId);
  const platform = CHANNEL_PLATFORMS.find((p) => p.id === normalizedPlatformId);
  if (!platform) {
    fmt.errorBlock('Unknown platform', `"${platformId}" is not a recognized channel. Available: ${CHANNEL_PLATFORMS.map((p) => p.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(globals.config);
  const channels = config.channels || [];
  const normalizedChannels = channels.map((id) => normalizeChannelId(id));

  if (normalizedChannels.includes(normalizedPlatformId)) {
    fmt.warning(`${platform.label} is already configured.`);
    return;
  }

  // Login-assisted platforms — offer guided provider login before manual secret entry.
  const LOGIN_ASSISTED_PLATFORMS = new Set([
    'twitter',
    'instagram',
    'linkedin',
    'facebook',
    'bluesky',
    'mastodon',
    'farcaster',
  ]);
  if (LOGIN_ASSISTED_PLATFORMS.has(normalizedPlatformId) && !globals.yes) {
    const p = await import('@clack/prompts');
    const authMethod = await p.select({
      message: `How would you like to authenticate with ${platform.label}?`,
      options: [
        { value: 'oauth' as const, label: 'Guided login (recommended)', hint: 'OAuth or token setup via wunderland login' },
        { value: 'manual' as const, label: 'Manual tokens', hint: 'Paste pre-obtained tokens from developer portal' },
      ],
    });

    if (p.isCancel(authMethod)) { fmt.note('Cancelled.'); return; }

    if (authMethod === 'oauth') {
      try {
        const loginMod = await import('./login.js');
        const loginFlags: Record<string, string | boolean> = { provider: normalizedPlatformId };
        await loginMod.default([], loginFlags, globals);
      } catch (err) {
        fmt.errorBlock('OAuth failed', err instanceof Error ? err.message : String(err));
        return;
      }

      // Save channel to config even if OAuth was used (tokens stored in FileTokenStore)
      channels.push(normalizedPlatformId);
      await updateConfig({ channels }, globals.config);
      fmt.blank();
      fmt.ok(`Added ${cColor(platform.label)} channel with OAuth.`);
      fmt.blank();
      return;
    }
    // Fall through to manual token entry
  }

  // Prompt for secrets
  const secrets = getSecretsForPlatform(normalizedPlatformId);
  const env = await loadEnv(globals.config);
  const newKeys: Record<string, string> = {};

  if (secrets.length > 0 && !globals.yes) {
    const p = await import('@clack/prompts');

    for (const secret of secrets) {
      const existing = env[secret.envVar];
      if (existing) {
        fmt.ok(`${secret.label}: already set`);
        continue;
      }

      const value = await p.password({
        message: `${secret.label}:`,
        validate: (val: string) => (!val && !secret.optional ? `${secret.label} is required` : undefined),
      });

      if (p.isCancel(value)) {
        fmt.note('Cancelled.');
        return;
      }

      if (value) newKeys[secret.envVar] = value as string;
      if (secret.docsUrl) {
        fmt.note(`Get one at: ${fmt.link(secret.docsUrl)}`);
      }
    }
  }

  // Save
  channels.push(normalizedPlatformId);
  await updateConfig({ channels }, globals.config);
  if (Object.keys(newKeys).length > 0) {
    await mergeEnv(newKeys, globals.config);
  }

  fmt.blank();
  fmt.ok(`Added ${cColor(platform.label)} channel.`);
  fmt.blank();
}

async function removeChannel(args: string[], globals: GlobalFlags): Promise<void> {
  const platformId = args[0];
  if (!platformId) {
    fmt.errorBlock('Missing platform', 'Usage: wunderland channels remove <platform>');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(globals.config);
  const channels = config.channels || [];
  const normalizedPlatformId = normalizeChannelId(platformId);
  const kept = channels.filter((id) => normalizeChannelId(id) !== normalizedPlatformId);

  if (kept.length === channels.length) {
    fmt.warning(`${platformId} is not in the channel list.`);
    return;
  }

  await updateConfig({ channels: kept }, globals.config);
  fmt.ok(`Removed ${cColor(normalizedPlatformId)} channel.`);
  fmt.blank();
}

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdChannels(
  args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const sub = args[0];

  if (sub === 'add') {
    await addChannel(args.slice(1), globals);
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    await removeChannel(args.slice(1), globals);
    return;
  }

  // Default: list
  await listChannels(globals);
}
