// @ts-nocheck
/**
 * @fileoverview `wunderland import <file>` — import agent from a manifest file.
 *
 * Supports both JSON and YAML input (auto-detected from extension or content).
 * Validates the manifest structure before creating the agent directory.
 * Supports `--name` to override the agent name and `--dry-run` to validate
 * without creating any files.
 *
 * @module wunderland/cli/commands/import-agent
 *
 * @example
 * ```sh
 * wunderland import agent.yaml                    # Import from YAML
 * wunderland import agent.json --name my-agent    # Override agent name
 * wunderland import agent.yaml --dry-run          # Validate only
 * ```
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';
import type { GlobalFlags } from '../types.js';
import { accent, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { importAgent, validateManifest } from '../../core/AgentManifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detects whether a file contains JSON or YAML content.
 *
 * First checks the file extension (`.json`, `.yaml`, `.yml`).
 * If ambiguous, attempts JSON.parse — if it succeeds, it's JSON;
 * otherwise assumes YAML.
 *
 * @param filePath - Path to the file being imported.
 * @param content - Raw file content as a string.
 * @returns `'json'` or `'yaml'`.
 */
function detectFormat(filePath: string, content: string): 'json' | 'yaml' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';

  // Ambiguous extension — try to parse as JSON first
  try {
    JSON.parse(content);
    return 'json';
  } catch {
    return 'yaml';
  }
}

/**
 * Parses file content as either JSON or YAML based on detected format.
 *
 * @param content - Raw file content string.
 * @param format - Detected format ('json' or 'yaml').
 * @returns Parsed data as unknown (needs validation).
 * @throws {Error} If parsing fails.
 */
function parseContent(content: string, format: 'json' | 'yaml'): unknown {
  if (format === 'json') {
    return JSON.parse(content);
  }
  return YAML.parse(content);
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * CLI handler for `wunderland import <file>`.
 *
 * Reads a manifest file (JSON or YAML), validates its structure, and creates
 * an agent directory at `~/.wunderland/agents/<name>/` with `agent.config.json`
 * and optional `PERSONA.md`.
 *
 * @param args - Positional arguments. `args[0]` is the file path to import.
 * @param flags - Named flags: `--name`, `--dry-run`, `--dir`, `--force`.
 * @param _globals - Global CLI flags (unused).
 * @returns Promise that resolves when import is complete.
 *
 * @throws Prints error and sets `process.exitCode = 1` on failure.
 */
export default async function cmdImport(
  args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const manifestPath = args[0];
  if (!manifestPath) {
    fmt.errorBlock(
      'Missing file path',
      'Usage: wunderland import <file> [--name <name>] [--dry-run]',
    );
    process.exitCode = 1;
    return;
  }

  const resolvedPath = path.resolve(process.cwd(), manifestPath);
  if (!existsSync(resolvedPath)) {
    fmt.errorBlock('File not found', resolvedPath);
    process.exitCode = 1;
    return;
  }

  // Read and detect format
  const content = readFileSync(resolvedPath, 'utf-8');
  const format = detectFormat(resolvedPath, content);

  // Parse the file
  let data: unknown;
  try {
    data = parseContent(content, format);
  } catch (parseErr) {
    const formatLabel = format === 'json' ? 'JSON' : 'YAML';
    fmt.errorBlock(`Invalid ${formatLabel}`, `Could not parse ${resolvedPath}`);
    process.exitCode = 1;
    return;
  }

  // Validate the manifest structure
  if (!validateManifest(data)) {
    fmt.errorBlock(
      'Invalid manifest',
      'File does not match the AgentManifest format (missing required fields or wrong manifestVersion).',
    );
    process.exitCode = 1;
    return;
  }

  // Apply --name override if provided
  const nameOverride = typeof flags['name'] === 'string' ? flags['name'] : undefined;
  if (nameOverride) {
    data.name = nameOverride;
    // Also update seedId to match the new name for directory naming
    data.seedId = nameOverride;
  }

  // Determine target directory: --dir override, or ~/.wunderland/agents/<name>
  const targetDir = typeof flags['dir'] === 'string'
    ? path.resolve(process.cwd(), flags['dir'])
    : path.join(homedir(), '.wunderland', 'agents', data.seedId || 'imported-agent');

  // Check for dry-run mode
  const isDryRun = flags['dry-run'] === true;

  if (isDryRun) {
    // Dry run: just validate and report, don't create files
    fmt.section('Dry Run — Validation Passed');
    fmt.kvPair('Name', accent(data.name));
    fmt.kvPair('Seed ID', data.seedId);
    if (data.presetId) fmt.kvPair('Preset', data.presetId);
    if (data.skills.length > 0) fmt.kvPair('Skills', data.skills.join(', '));
    if (data.channels.length > 0) fmt.kvPair('Channels', data.channels.join(', '));
    fmt.kvPair('Format', format.toUpperCase());
    fmt.kvPair('Target', accent(targetDir));
    fmt.note('No files were created (dry-run mode).');
    fmt.blank();
    return;
  }

  // Guard: refuse to overwrite sealed agents
  const sealedPath = path.join(targetDir, 'sealed.json');
  if (existsSync(sealedPath)) {
    fmt.errorBlock(
      'Refusing to overwrite sealed agent',
      `${sealedPath} exists.\nThis agent is sealed and should be treated as immutable.`,
    );
    process.exitCode = 1;
    return;
  }

  // Guard: refuse to overwrite existing agent without --force
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
    fmt.kvPair('Format', format.toUpperCase());
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
