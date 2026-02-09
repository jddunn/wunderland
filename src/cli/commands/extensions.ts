/**
 * @fileoverview `wunderland extensions` — manage agent extensions.
 * @module wunderland/cli/commands/extensions
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

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
    fmt.warning(`${subcommand} subcommand not yet implemented. Coming soon!`);
    return;
  }

  fmt.errorBlock('Unknown subcommand', `"${subcommand}" is not a valid extensions subcommand.`);
  process.exitCode = 1;
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
    const tools = available.filter((e) => e.category === 'tool' || e.category === 'integration');
    const voice = available.filter((e) => e.category === 'voice');
    const productivity = available.filter((e) => e.category === 'productivity');
    const channels = available.filter((e) => e.category === 'channel');

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
