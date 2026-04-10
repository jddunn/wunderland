// @ts-nocheck
/**
 * @fileoverview `wunderland cloud` — list and inspect cloud hosting providers.
 * @module wunderland/cli/commands/cloud
 */

import type { GlobalFlags } from '../types.js';
import { CLOUD_PROVIDERS } from '../constants.js';
import { accent, dim, success as sColor, warn as wColor, info as iColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { getUiRuntime } from '../ui/runtime.js';
import { loadEnv } from '../config/env-manager.js';

// ── Provider tool catalogs ──────────────────────────────────────────────────

const PROVIDER_TOOLS: Record<string, string[]> = {
  vercel: ['vercel.create-project', 'vercel.deploy', 'vercel.set-env', 'vercel.list-deployments', 'vercel.add-domain', 'vercel.rollback'],
  cloudflare: ['cloudflare.create-project', 'cloudflare.deploy', 'cloudflare.set-env', 'cloudflare.list-deployments', 'cloudflare.add-domain', 'cloudflare.purge-cache'],
  netlify: ['netlify.create-site', 'netlify.deploy', 'netlify.set-env', 'netlify.list-deploys', 'netlify.add-domain'],
  digitalocean: ['digitalocean.create-app', 'digitalocean.deploy', 'digitalocean.set-env', 'digitalocean.list-deployments', 'digitalocean.add-domain'],
  railway: ['railway.create-project', 'railway.deploy', 'railway.set-env', 'railway.list-deployments', 'railway.add-domain'],
  fly: ['fly.create-app', 'fly.deploy', 'fly.set-env', 'fly.list-machines', 'fly.add-certificate'],
  aws: ['aws.create-bucket', 'aws.deploy-static', 'aws.configure-cdn', 'aws.invalidate-cache'],
  heroku: ['heroku.create-app', 'heroku.deploy', 'heroku.set-config', 'heroku.add-domain'],
  linode: ['linode.create-instance', 'linode.deploy', 'linode.configure-dns', 'linode.list-instances'],
};

const PROVIDER_DOCS: Record<string, string> = {
  vercel: 'https://docs.wunderland.sh/guides/cloud-providers#vercel',
  cloudflare: 'https://docs.wunderland.sh/guides/cloud-providers#cloudflare-pages',
  netlify: 'https://docs.wunderland.sh/guides/cloud-providers#netlify',
  digitalocean: 'https://docs.wunderland.sh/guides/cloud-providers#digitalocean-app-platform',
  railway: 'https://docs.wunderland.sh/guides/cloud-providers#railway',
  fly: 'https://docs.wunderland.sh/guides/cloud-providers#flyio',
  aws: 'https://docs.wunderland.sh/guides/cloud-providers#aws-s3--cloudfront',
  heroku: 'https://docs.wunderland.sh/guides/cloud-providers#heroku',
  linode: 'https://docs.wunderland.sh/guides/cloud-providers#linode-akamai',
};

// ── Tier labels ─────────────────────────────────────────────────────────────

function tierLabel(tier: string): string {
  switch (tier) {
    case 'p0': return sColor('core');
    case 'p1': return iColor('extended');
    case 'p2': return wColor('manual');
    default: return dim(tier);
  }
}

// ── Sub-commands ────────────────────────────────────────────────────────────

async function listProviders(globals: GlobalFlags): Promise<void> {
  const env = await loadEnv(globals.config);
  const ui = getUiRuntime();
  fmt.section('Cloud Hosting Providers');
  fmt.blank();

  for (const provider of CLOUD_PROVIDERS) {
    const label = `${ui.ascii ? '' : `${provider.icon}  `}${provider.label}`;
    const allSet = provider.secretEnv.every((s) => !!env[s]);
    const credStatus = allSet ? sColor('credentials set') : wColor('needs credentials');
    const tier = tierLabel(provider.tier);

    console.log(`    ${label.padEnd(30)} ${tier.padEnd(22)} ${credStatus}`);
    console.log(`    ${dim(provider.bestFor)}`);
    fmt.blank();
  }

  fmt.note(`Run ${accent('wunderland cloud info <provider>')} for tools, secrets, and docs.`);
  fmt.blank();
}

async function showProviderInfo(providerId: string | undefined, globals: GlobalFlags): Promise<void> {
  const g = glyphs();

  if (!providerId) {
    fmt.errorBlock('Missing provider', 'Usage: wunderland cloud info <provider>');
    process.exitCode = 1;
    return;
  }

  const normalized = providerId.trim().toLowerCase();
  const provider = CLOUD_PROVIDERS.find((p) => p.id === normalized);

  if (!provider) {
    fmt.errorBlock(
      'Unknown provider',
      `"${providerId}" is not a recognized cloud provider.\nAvailable: ${CLOUD_PROVIDERS.map((p) => p.id).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const env = await loadEnv(globals.config);
  const allSet = provider.secretEnv.every((s) => !!env[s]);

  fmt.section(`Cloud Provider: ${provider.label}`);
  fmt.kvPair('ID', provider.id);
  fmt.kvPair('Tier', provider.tier === 'p0' ? 'P0 (Core)' : provider.tier === 'p1' ? 'P1 (Extended)' : 'P2 (Manual)');
  fmt.kvPair('Best For', provider.bestFor);
  fmt.kvPair('Credentials', allSet ? `${g.ok} All set` : `${g.fail} Missing`);

  fmt.blank();
  fmt.note(accent('Required Secrets:'));
  for (const secret of provider.secretEnv) {
    const isSet = !!env[secret];
    const status = isSet ? g.ok : g.fail;
    console.log(`    ${status} ${secret}`);
  }

  const tools = PROVIDER_TOOLS[provider.id] || [];
  if (tools.length > 0) {
    fmt.blank();
    fmt.note(accent('Available Tools:'));
    for (const tool of tools) {
      console.log(`    ${dim(g.bullet)} ${tool}`);
    }
  }

  const docsUrl = PROVIDER_DOCS[provider.id];
  if (docsUrl) {
    fmt.blank();
    fmt.note(`Docs: ${fmt.link(docsUrl)}`);
  }

  fmt.blank();
}

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdCloud(
  args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const sub = args[0];

  if (sub === 'info') {
    await showProviderInfo(args[1], globals);
    return;
  }

  // Default: list all providers
  await listProviders(globals);
}
