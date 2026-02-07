/**
 * @fileoverview `wunderland seal` — seal the agent configuration with an integrity hash.
 * Computes a SHA-256 hash of the config JSON and writes a sealed.json file.
 * @module wunderland/cli/commands/seal
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

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

  // Compute deterministic hash (sorted keys)
  const canonical = JSON.stringify(config, Object.keys(config as Record<string, unknown>).sort(), 0);
  const configHash = createHash('sha256').update(canonical, 'utf8').digest('hex');

  const sealed = {
    sealedAt: new Date().toISOString(),
    configHash,
    config,
  };

  await writeFile(sealedPath, JSON.stringify(sealed, null, 2) + '\n', 'utf8');

  // Output
  fmt.section('Agent Sealed');
  fmt.kvPair('Config', accent(configPath));
  fmt.kvPair('Sealed File', accent(sealedPath));
  fmt.kvPair('SHA-256', sColor(configHash));
  fmt.blank();
  fmt.note('The sealed.json file can be used to verify agent integrity at deploy time.');
  fmt.blank();
}
