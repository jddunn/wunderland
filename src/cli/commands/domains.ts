// @ts-nocheck
/**
 * @fileoverview `wunderland domains` — list and inspect domain registrars.
 * @module wunderland/cli/commands/domains
 */

import type { GlobalFlags } from '../types.js';
import { DOMAIN_REGISTRARS } from '../constants.js';
import { accent, dim, success as sColor, warn as wColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { getUiRuntime } from '../ui/runtime.js';
import { loadEnv } from '../config/env-manager.js';

// ── Registrar tool catalogs ─────────────────────────────────────────────────

const REGISTRAR_TOOLS: Record<string, string[]> = {
  porkbun: ['porkbun.search-domain', 'porkbun.register-domain', 'porkbun.set-dns', 'porkbun.list-dns', 'porkbun.delete-dns'],
  namecheap: ['namecheap.search-domain', 'namecheap.register-domain', 'namecheap.set-dns', 'namecheap.list-dns', 'namecheap.get-nameservers'],
  godaddy: ['godaddy.search-domain', 'godaddy.register-domain', 'godaddy.set-dns', 'godaddy.list-dns'],
  cloudflare: ['cloudflare.search-domain', 'cloudflare.register-domain', 'cloudflare.set-dns', 'cloudflare.list-dns', 'cloudflare.configure-ssl'],
};

const REGISTRAR_DOCS: Record<string, string> = {
  porkbun: 'https://docs.wunderland.sh/guides/domain-registrars#porkbun',
  namecheap: 'https://docs.wunderland.sh/guides/domain-registrars#namecheap',
  godaddy: 'https://docs.wunderland.sh/guides/domain-registrars#godaddy',
  cloudflare: 'https://docs.wunderland.sh/guides/domain-registrars#cloudflare-registrar',
};

// ── Sub-commands ────────────────────────────────────────────────────────────

async function listRegistrars(globals: GlobalFlags): Promise<void> {
  const env = await loadEnv(globals.config);
  const ui = getUiRuntime();
  fmt.section('Domain Registrars');
  fmt.blank();

  for (const registrar of DOMAIN_REGISTRARS) {
    const label = `${ui.ascii ? '' : `${registrar.icon}  `}${registrar.label}`;
    const allSet = registrar.secretEnv.every((s) => !!env[s]);
    const credStatus = allSet ? sColor('credentials set') : wColor('needs credentials');
    const dnsSupport = dim(`DNS: ${registrar.dnsRecords.join(', ')}`);

    console.log(`    ${label.padEnd(28)} ${credStatus}`);
    console.log(`    ${dnsSupport}`);
    fmt.blank();
  }

  fmt.note(`Run ${accent('wunderland domains info <registrar>')} for tools, secrets, and docs.`);
  fmt.blank();
}

async function showRegistrarInfo(registrarId: string | undefined, globals: GlobalFlags): Promise<void> {
  const g = glyphs();

  if (!registrarId) {
    fmt.errorBlock('Missing registrar', 'Usage: wunderland domains info <registrar>');
    process.exitCode = 1;
    return;
  }

  const normalized = registrarId.trim().toLowerCase();
  const registrar = DOMAIN_REGISTRARS.find((r) => r.id === normalized);

  if (!registrar) {
    fmt.errorBlock(
      'Unknown registrar',
      `"${registrarId}" is not a recognized domain registrar.\nAvailable: ${DOMAIN_REGISTRARS.map((r) => r.id).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const env = await loadEnv(globals.config);
  const allSet = registrar.secretEnv.every((s) => !!env[s]);

  fmt.section(`Domain Registrar: ${registrar.label}`);
  fmt.kvPair('ID', registrar.id);
  fmt.kvPair('Tools', String(registrar.toolCount));
  fmt.kvPair('DNS Records', registrar.dnsRecords.join(', '));
  fmt.kvPair('Credentials', allSet ? `${g.ok} All set` : `${g.fail} Missing`);

  fmt.blank();
  fmt.note(accent('Required Secrets:'));
  for (const secret of registrar.secretEnv) {
    const isSet = !!env[secret];
    const status = isSet ? g.ok : g.fail;
    console.log(`    ${status} ${secret}`);
  }

  const tools = REGISTRAR_TOOLS[registrar.id] || [];
  if (tools.length > 0) {
    fmt.blank();
    fmt.note(accent('Available Tools:'));
    for (const tool of tools) {
      console.log(`    ${dim(g.bullet)} ${tool}`);
    }
  }

  const docsUrl = REGISTRAR_DOCS[registrar.id];
  if (docsUrl) {
    fmt.blank();
    fmt.note(`Docs: ${fmt.link(docsUrl)}`);
  }

  fmt.blank();
}

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdDomains(
  args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const sub = args[0];

  if (sub === 'info') {
    await showRegistrarInfo(args[1], globals);
    return;
  }

  // Default: list all registrars
  await listRegistrars(globals);
}
