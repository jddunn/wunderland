/**
 * @fileoverview `wunderland seal` — seal the agent configuration with an integrity hash.
 * Computes a deterministic SHA-256 hash of the canonical config JSON and writes a sealed.json file.
 * @module wunderland/cli/commands/seal
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { canonicalizeJsonString, sha256HexUtf8, signSealHashIfConfigured, type SealSignature } from '../seal-utils.js';

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdSeal(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const dir = typeof flags['dir'] === 'string'
    ? path.resolve(process.cwd(), flags['dir'])
    : process.cwd();

  const configPath = path.join(dir, 'agent.config.json');
  const sealedPath = path.join(dir, 'sealed.json');

  // Ensure agent config exists
  if (!existsSync(configPath)) {
    fmt.errorBlock('Missing agent config', `${configPath}\nRun ${accent('wunderland init <dir>')} first.`);
    process.exitCode = 1;
    return;
  }

  // Reject if already sealed
  if (existsSync(sealedPath)) {
    fmt.errorBlock('Already sealed', `${sealedPath} already exists.\nRemove it manually if you want to re-seal.`);
    process.exitCode = 1;
    return;
  }

  // Read and parse config
  let configRaw: string;
  let config: unknown;
  try {
    configRaw = await readFile(configPath, 'utf8');
    config = JSON.parse(configRaw);
  } catch (err) {
    fmt.errorBlock('Invalid config', `Failed to read ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  // Compute deterministic hash (deep key-sorted canonical JSON)
  let canonical: string;
  try {
    canonical = canonicalizeJsonString(configRaw).canonical;
  } catch (err) {
    fmt.errorBlock('Invalid config', `Failed to canonicalize ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  const configHash = sha256HexUtf8(canonical);

  // Optional signature (Ed25519) if configured.
  let signature: SealSignature | null = null;
  try {
    signature = signSealHashIfConfigured(configHash);
  } catch (err) {
    fmt.errorBlock(
      'Seal signing failed',
      err instanceof Error ? err.message : 'Invalid WUNDERLAND_SEAL_SIGNING_SEED_BASE64',
    );
    process.exitCode = 1;
    return;
  }

  const sealed = {
    format: 'wunderland.sealed.v2',
    sealedAt: new Date().toISOString(),
    configHash,
    signature,
    config,
  };

  await writeFile(sealedPath, JSON.stringify(sealed, null, 2) + '\n', 'utf8');

  // Output
  fmt.section('Agent Sealed');
  fmt.kvPair('Config', accent(configPath));
  fmt.kvPair('Sealed File', accent(sealedPath));
  fmt.kvPair('SHA-256', sColor(configHash));
  if (signature) fmt.kvPair('Signature', sColor('ed25519'));
  fmt.blank();
  fmt.note('Run wunderland verify-seal to verify integrity and signature.');
  fmt.blank();
}
