/**
 * @fileoverview `wunderland import <manifest>` — import agent from a manifest file.
 * @module wunderland/cli/commands/import-agent
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { importAgent, validateManifest } from '../../core/AgentManifest.js';

export default async function cmdImport(
  args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const manifestPath = args[0];
  if (!manifestPath) {
    fmt.errorBlock('Missing manifest path', 'Usage: wunderland import <manifest.json> [--dir <target>]');
    process.exitCode = 1;
    return;
  }

  const resolvedPath = path.resolve(process.cwd(), manifestPath);
  if (!existsSync(resolvedPath)) {
    fmt.errorBlock('File not found', resolvedPath);
    process.exitCode = 1;
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
  } catch {
    fmt.errorBlock('Invalid JSON', `Could not parse ${resolvedPath}`);
    process.exitCode = 1;
    return;
  }

  if (!validateManifest(data)) {
    fmt.errorBlock('Invalid manifest', 'File does not match the AgentManifest format (missing required fields or wrong manifestVersion).');
    process.exitCode = 1;
    return;
  }

  const targetDir = typeof flags['dir'] === 'string'
    ? path.resolve(process.cwd(), flags['dir'])
    : path.resolve(path.dirname(resolvedPath), data.seedId || 'imported-agent');

  if (existsSync(path.join(targetDir, 'agent.config.json')) && flags['force'] !== true) {
    fmt.errorBlock(
      'Target already has an agent',
      `${targetDir}/agent.config.json already exists.\nRe-run with --force to overwrite.`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    importAgent(data, targetDir);

    fmt.section('Agent Imported');
    fmt.kvPair('Name', accent(data.name));
    fmt.kvPair('Seed ID', data.seedId);
    if (data.presetId) fmt.kvPair('Preset', data.presetId);
    if (data.skills.length > 0) fmt.kvPair('Skills', data.skills.join(', '));
    if (data.channels.length > 0) fmt.kvPair('Channels', data.channels.join(', '));
    if (data.sealed) {
      fmt.warning('This agent was sealed at export. The import is unsealed. Run `wunderland seal` to re-seal.');
    }
    fmt.kvPair('Directory', accent(targetDir));
    fmt.blank();
    fmt.note(`Next: ${sColor(`cd ${path.relative(process.cwd(), targetDir)}`)} && ${sColor('wunderland start')}`);
    fmt.blank();
  } catch (err) {
    fmt.errorBlock('Import failed', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
