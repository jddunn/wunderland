/**
 * @fileoverview `wunderland export` — export agent config to a shareable manifest.
 * @module wunderland/cli/commands/export-agent
 */

import * as path from 'node:path';
import { writeFileSync } from 'node:fs';
import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { exportAgent } from '../../core/AgentManifest.js';

export default async function cmdExport(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const dir = typeof flags['dir'] === 'string'
    ? path.resolve(process.cwd(), flags['dir'])
    : process.cwd();

  const outputPath = typeof flags['o'] === 'string'
    ? path.resolve(process.cwd(), flags['o'])
    : path.join(dir, 'agent.manifest.json');

  try {
    const manifest = exportAgent(dir);

    writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

    fmt.section('Agent Exported');
    fmt.kvPair('Name', accent(manifest.name));
    fmt.kvPair('Seed ID', manifest.seedId);
    if (manifest.presetId) fmt.kvPair('Preset', manifest.presetId);
    if (manifest.skills.length > 0) fmt.kvPair('Skills', manifest.skills.join(', '));
    if (manifest.channels.length > 0) fmt.kvPair('Channels', manifest.channels.join(', '));
    if (manifest.sealed) fmt.kvPair('Sealed', dim('yes (integrity hash included)'));
    fmt.kvPair('Output', accent(outputPath));
    fmt.blank();
  } catch (err) {
    fmt.errorBlock('Export failed', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
