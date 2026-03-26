/**
 * @fileoverview `wunderland export <agent-name>` — export agent config to a shareable manifest.
 *
 * Supports multiple output formats (JSON, YAML) and can write to stdout or a file.
 * API keys are redacted by default for safe sharing unless `--include-secrets` is passed.
 *
 * @module wunderland/cli/commands/export-agent
 *
 * @example
 * ```sh
 * wunderland export my-agent                     # YAML to stdout
 * wunderland export my-agent --format json       # JSON to stdout
 * wunderland export my-agent -o agent.yaml       # Write to file
 * wunderland export my-agent --include-secrets   # Include API keys
 * ```
 */

import * as path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import YAML from 'yaml';
import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { exportAgent } from '../../core/AgentManifest.js';

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

/**
 * Regex that matches common API key patterns.
 * Covers OpenAI (sk-...), Anthropic (sk-ant-...), Google (AIzaSy...),
 * and generic long alphanumeric tokens.
 */
const API_KEY_PATTERN = /^(sk-|sk-ant-|AIzaSy|ghp_|ghr_|xai-|glpat-).+/;

/**
 * Known field names that typically contain secrets.
 * Checked case-insensitively during deep redaction.
 */
const SECRET_FIELD_NAMES = new Set([
  'apikey', 'api_key', 'apiKey',
  'secret', 'token', 'password',
  'accesstoken', 'access_token', 'accessToken',
  'refreshtoken', 'refresh_token', 'refreshToken',
  'authtoken', 'auth_token', 'authToken',
]);

/**
 * Recursively redacts secret values in an object.
 * Replaces API keys with `"***REDACTED***"` for safe sharing.
 *
 * @param obj - The object to redact (mutated in-place).
 * @returns The same object with secrets replaced.
 */
function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(obj)) {
    // Check if the field name looks like a secret
    const lowerKey = key.toLowerCase();
    const isSecretField = SECRET_FIELD_NAMES.has(lowerKey) || lowerKey.endsWith('key') || lowerKey.endsWith('secret');

    if (isSecretField && typeof value === 'string' && value.length > 0) {
      obj[key] = '***REDACTED***';
    } else if (typeof value === 'string' && API_KEY_PATTERN.test(value)) {
      // Catch API keys that slipped into non-obvious field names
      obj[key] = '***REDACTED***';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      redactSecrets(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          redactSecrets(item as Record<string, unknown>);
        }
      }
    }
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * CLI handler for `wunderland export <agent-name>`.
 *
 * Loads agent config from `~/.wunderland/agents/<name>/agent.config.json`,
 * converts to an AgentManifest, optionally redacts secrets, and outputs
 * as JSON or YAML to stdout or a file.
 *
 * @param args - Positional arguments. `args[0]` is the agent name.
 * @param flags - Named flags: `--format`, `--output`/`-o`, `--include-secrets`, `--dir`.
 * @param _globals - Global CLI flags (unused).
 * @returns Promise that resolves when export is complete.
 *
 * @throws Prints error and sets `process.exitCode = 1` on failure.
 */
export default async function cmdExport(
  args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const agentName = args[0];

  // Resolve the agent directory: either --dir override, or lookup by name
  // in ~/.wunderland/agents/<name>/
  let dir: string;
  if (typeof flags['dir'] === 'string') {
    dir = path.resolve(process.cwd(), flags['dir']);
  } else if (agentName) {
    // Standard agent location: ~/.wunderland/agents/<name>
    dir = path.join(homedir(), '.wunderland', 'agents', agentName);
    if (!existsSync(dir)) {
      // Fallback: try current directory (backwards compat)
      dir = process.cwd();
    }
  } else {
    // No agent name — use current directory (legacy behavior)
    dir = process.cwd();
  }

  // Determine output format: json or yaml (default: yaml)
  const format = typeof flags['format'] === 'string'
    ? flags['format'].toLowerCase()
    : 'yaml';

  if (format !== 'json' && format !== 'yaml') {
    fmt.errorBlock('Invalid format', `Expected "json" or "yaml", got "${format}".`);
    process.exitCode = 1;
    return;
  }

  // Whether to include secrets (default: false, redact them)
  const includeSecrets = flags['include-secrets'] === true;

  // Output destination: --output or -o flag, or stdout
  const outputFlag = typeof flags['output'] === 'string'
    ? flags['output']
    : typeof flags['o'] === 'string'
      ? flags['o']
      : undefined;

  try {
    const manifest = exportAgent(dir);

    // Deep clone before redaction to avoid mutating the original
    const exportData = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;

    if (!includeSecrets) {
      redactSecrets(exportData);
    }

    // Serialize to the requested format
    let serialized: string;
    if (format === 'json') {
      serialized = JSON.stringify(exportData, null, 2) + '\n';
    } else {
      serialized = YAML.stringify(exportData);
    }

    if (outputFlag) {
      // Write to file
      const outputPath = path.resolve(process.cwd(), outputFlag);
      writeFileSync(outputPath, serialized, 'utf-8');

      fmt.section('Agent Exported');
      fmt.kvPair('Name', accent(manifest.name));
      fmt.kvPair('Seed ID', manifest.seedId);
      if (manifest.presetId) fmt.kvPair('Preset', manifest.presetId);
      if (manifest.skills.length > 0) fmt.kvPair('Skills', manifest.skills.join(', '));
      if (manifest.channels.length > 0) fmt.kvPair('Channels', manifest.channels.join(', '));
      if (manifest.sealed) fmt.kvPair('Sealed', dim('yes (integrity hash included)'));
      fmt.kvPair('Format', format.toUpperCase());
      if (!includeSecrets) fmt.kvPair('Secrets', dim('redacted (use --include-secrets to include)'));
      fmt.kvPair('Output', accent(outputPath));
      fmt.blank();
    } else {
      // Write to stdout — no extra formatting, just the raw output
      process.stdout.write(serialized);
    }
  } catch (err) {
    fmt.errorBlock('Export failed', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
