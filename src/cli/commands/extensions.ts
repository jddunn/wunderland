/**
 * @fileoverview `wunderland extensions` — manage agent extensions.
 * @module wunderland/cli/commands/extensions
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

// ── Config helpers ──────────────────────────────────────────────────────────

async function loadAgentConfig(dir: string): Promise<{ config: Record<string, unknown>; configPath: string } | null> {
  const configPath = path.join(dir, 'agent.config.json');
  if (!existsSync(configPath)) return null;
  try {
    const raw = await readFile(configPath, 'utf8');
    return { config: JSON.parse(raw), configPath };
  } catch {
    return null;
  }
}

async function saveAgentConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * Command handler for `wunderland extensions <subcommand>`.
 */
export default async function cmdExtensions(
  args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'list') {
    return listExtensions(flags);
  }

  if (subcommand === 'info') {
    return showExtensionInfo(args[1], flags);
  }

  if (subcommand === 'enable' || subcommand === 'disable') {
    const name = args[1];
    if (!name) {
      fmt.errorBlock('Missing extension name', `Usage: wunderland extensions ${subcommand} <name>`);
      process.exitCode = 1;
      return;
    }
    if (subcommand === 'enable') {
      await enableExtension(name);
      return;
    }
    await disableExtension(name);
    return;
  }

  fmt.errorBlock('Unknown subcommand', `"${subcommand}" is not a valid extensions subcommand.`);
  process.exitCode = 1;
}

function ensureStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];
}

function resolveConfigBucketForCategory(category: string): 'tools' | 'voice' | 'productivity' | null {
  // NOTE: channel adapters are configured via `wunderland channels`, not agent.config.json.
  if (category === 'voice') return 'voice';
  if (category === 'productivity') return 'productivity';
  if (category === 'tool' || category === 'integration' || category === 'provenance') return 'tools';
  return 'tools'; // default bucket for unknown categories
}

async function getRegistryExtensionByName(name: string): Promise<any | null> {
  try {
    const { getAvailableExtensions } = await import('@framers/agentos-extensions-registry');
    const available = await getAvailableExtensions();
    const ext = available.find((e) => e.name === name);
    return ext || null;
  } catch {
    return null;
  }
}

async function enableExtension(name: string): Promise<void> {
  const ext = await getRegistryExtensionByName(name);
  if (!ext) {
    fmt.errorBlock('Extension not found', `No extension named "${name}" in the registry.\nRun ${accent('wunderland extensions list')} to see available extensions.`);
    process.exitCode = 1;
    return;
  }

  if (ext.category === 'channel') {
    fmt.errorBlock(
      'Channel extensions are configured separately',
      `Extension "${name}" is a channel adapter.\nUse ${accent('wunderland channels add')} to configure channels.`,
    );
    process.exitCode = 1;
    return;
  }

  const result = await loadAgentConfig(process.cwd());
  if (!result) {
    fmt.errorBlock('Missing agent config', `No agent.config.json in current directory.\nRun ${accent('wunderland init <dir>')} first.`);
    process.exitCode = 1;
    return;
  }

  const { config, configPath } = result;
  const extensions = (config.extensions && typeof config.extensions === 'object') ? (config.extensions as Record<string, unknown>) : {};

  const bucket = resolveConfigBucketForCategory(String(ext.category || 'tool'));
  if (!bucket) {
    fmt.errorBlock('Unsupported extension category', `Extension "${name}" has unsupported category "${ext.category}".`);
    process.exitCode = 1;
    return;
  }

  const current = ensureStringArray(extensions[bucket]);
  if (current.includes(name)) {
    fmt.warning(`Extension "${name}" is already enabled.`);
    return;
  }

  extensions[bucket] = [...current, name];
  config.extensions = extensions;
  await saveAgentConfig(configPath, config);

  fmt.ok(`Enabled extension ${accent(ext.displayName || name)} (${name})`);
  fmt.blank();
}

async function disableExtension(name: string): Promise<void> {
  const result = await loadAgentConfig(process.cwd());
  if (!result) {
    fmt.errorBlock('Missing agent config', `No agent.config.json in current directory.\nRun ${accent('wunderland init <dir>')} first.`);
    process.exitCode = 1;
    return;
  }

  const { config, configPath } = result;
  const extensions = (config.extensions && typeof config.extensions === 'object') ? (config.extensions as Record<string, unknown>) : {};

  let changed = false;
  for (const bucket of ['tools', 'voice', 'productivity'] as const) {
    const arr = ensureStringArray(extensions[bucket]);
    const next = arr.filter((x) => x !== name);
    if (next.length !== arr.length) {
      extensions[bucket] = next;
      changed = true;
    }
  }

  if (!changed) {
    fmt.warning(`Extension "${name}" is not enabled in this agent.`);
    return;
  }

  config.extensions = extensions;
  await saveAgentConfig(configPath, config);

  fmt.ok(`Disabled extension ${accent(name)}`);
  fmt.blank();
}

/**
 * List all available extensions.
 */
async function listExtensions(flags: Record<string, string | boolean>): Promise<void> {
  fmt.section('Available Extensions');

  try {
    const { getAvailableExtensions } = await import('@framers/agentos-extensions-registry');
    const available = await getAvailableExtensions();

    // Group by category
    const cat = (e: { category: string }) => e.category;
    const tools = available.filter((e) => cat(e) === 'tool' || cat(e) === 'integration');
    const voice = available.filter((e) => cat(e) === 'voice');
    const productivity = available.filter((e) => cat(e) === 'productivity');
    const channels = available.filter((e) => cat(e) === 'channel');

    const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

    if (format === 'json') {
      console.log(JSON.stringify({ tools, voice, productivity, channels }, null, 2));
      return;
    }

    // Table format
    if (tools.length > 0) {
      fmt.blank();
      fmt.note(accent('Tools:'));
      for (const ext of tools) {
        const status = ext.available ? '✓' : dim('✗');
        fmt.kvPair(`  ${status} ${ext.displayName}`, dim(ext.description));
      }
    }

    if (voice.length > 0) {
      fmt.blank();
      fmt.note(accent('Voice:'));
      for (const ext of voice) {
        const status = ext.available ? '✓' : dim('✗');
        fmt.kvPair(`  ${status} ${ext.displayName}`, dim(ext.description));
      }
    }

    if (productivity.length > 0) {
      fmt.blank();
      fmt.note(accent('Productivity:'));
      for (const ext of productivity) {
        const status = ext.available ? '✓' : dim('✗');
        fmt.kvPair(`  ${status} ${ext.displayName}`, dim(ext.description));
      }
    }

    if (channels.length > 0) {
      fmt.blank();
      fmt.note(accent('Channels:'));
      for (const ext of channels.slice(0, 10)) {
        const status = ext.available ? '✓' : dim('✗');
        fmt.kvPair(`  ${status} ${ext.displayName}`, dim(ext.description));
      }
      if (channels.length > 10) {
        fmt.note(dim(`  ... and ${channels.length - 10} more channels`));
      }
    }

    fmt.blank();
    fmt.note(`Total: ${available.length} extensions (${available.filter((e) => e.available).length} installed)`);
  } catch (err) {
    fmt.errorBlock('Extensions registry not available', 'Install @framers/agentos-extensions-registry to use this command.');
    process.exitCode = 1;
  }
}

/**
 * Show details for a specific extension.
 */
async function showExtensionInfo(
  name: string | undefined,
  _flags: Record<string, string | boolean>,
): Promise<void> {
  if (!name) {
    fmt.errorBlock('Missing extension name', 'Usage: wunderland extensions info <name>');
    process.exitCode = 1;
    return;
  }

  try {
    const { getAvailableExtensions } = await import('@framers/agentos-extensions-registry');
    const available = await getAvailableExtensions();
    const ext = available.find((e) => e.name === name);

    if (!ext) {
      fmt.errorBlock('Extension not found', `No extension named "${name}" in the registry.`);
      process.exitCode = 1;
      return;
    }

    fmt.section(`Extension: ${ext.displayName}`);
    fmt.kvPair('Name', ext.name);
    fmt.kvPair('Category', ext.category);
    fmt.kvPair('Package', ext.packageName);
    fmt.kvPair('Description', ext.description);
    fmt.kvPair('Status', ext.available ? '✓ Installed' : '✗ Not installed');
    fmt.kvPair('Default Priority', String(ext.defaultPriority));

    if (ext.requiredSecrets.length > 0) {
      fmt.kvPair('Required Secrets', ext.requiredSecrets.join(', '));
    }

    fmt.blank();
  } catch (err) {
    fmt.errorBlock('Extensions registry not available', 'Install @framers/agentos-extensions-registry to use this command.');
    process.exitCode = 1;
  }
}
