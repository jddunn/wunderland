/**
 * @fileoverview `wunderland verify-seal` — verify sealed.json against agent.config.json.
 * @module wunderland/cli/commands/verify-seal
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor, warn as wColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { verifySealedConfig } from '../seal-utils.js';

export default async function cmdVerifySeal(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const dir =
    typeof flags['dir'] === 'string' ? path.resolve(process.cwd(), flags['dir']) : process.cwd();

  const configPath = path.join(dir, 'agent.config.json');
  const sealedPath = path.join(dir, 'sealed.json');

  if (!existsSync(configPath)) {
    fmt.errorBlock('Missing agent config', `${configPath}\nRun ${accent('wunderland init <dir>')} first.`);
    process.exitCode = 1;
    return;
  }

  if (!existsSync(sealedPath)) {
    fmt.errorBlock('Missing seal', `${sealedPath} not found.\nRun ${accent('wunderland seal')} first.`);
    process.exitCode = 1;
    return;
  }

  let configRaw = '';
  let sealedRaw = '';
  try {
    [configRaw, sealedRaw] = await Promise.all([readFile(configPath, 'utf8'), readFile(sealedPath, 'utf8')]);
  } catch (err) {
    fmt.errorBlock('Read failed', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const verification = verifySealedConfig({ configRaw, sealedRaw });

  // Output
  fmt.section('Seal Verification');
  fmt.kvPair('Config', accent(configPath));
  fmt.kvPair('Sealed File', accent(sealedPath));
  fmt.kvPair('Expected SHA-256', verification.expectedHashRaw || '[missing]');
  fmt.kvPair('Actual SHA-256', verification.actualHashHex || '[unknown]');
  if (verification.format !== 'wunderland.sealed.v2') {
    fmt.warning('Legacy seal format detected - re-run wunderland seal to upgrade.');
  }

  if (!verification.ok) {
    fmt.blank();
    fmt.fail(verification.error || 'Seal verification failed.');
    process.exitCode = 1;
    return;
  }

  fmt.blank();
  fmt.ok(`Config hash matches (${sColor(verification.actualHashHex)})`);
  if (verification.signaturePresent) {
    fmt.ok('Signature valid (ed25519)');
  } else {
    fmt.warning(`No signature present (${wColor('hash-only')} verification).`);
  }

  fmt.blank();
}
