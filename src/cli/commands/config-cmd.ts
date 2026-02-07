/**
 * @fileoverview `wunderland config` — view/get/set CLI configuration.
 * @module wunderland/cli/commands/config-cmd
 */

import type { GlobalFlags } from '../types.js';
import { accent, muted, dim } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadConfig, getConfigValue, setConfigValue, getConfigPath } from '../config/config-manager.js';

export default async function cmdConfig(
  args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const sub = args[0];

  // wunderland config get <key>
  if (sub === 'get') {
    const key = args[1];
    if (!key) {
      fmt.errorBlock('Missing key', 'Usage: wunderland config get <key>');
      process.exitCode = 1;
      return;
    }
    const value = await getConfigValue(key, globals.config);
    if (value === undefined) {
      fmt.skip(`${key}: ${muted('not set')}`);
    } else {
      console.log(`  ${accent(key)}: ${typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}`);
    }
    return;
  }

  // wunderland config set <key> <value>
  if (sub === 'set') {
    const key = args[1];
    const rawValue = args.slice(2).join(' ');
    if (!key || !rawValue) {
      fmt.errorBlock('Missing arguments', 'Usage: wunderland config set <key> <value>');
      process.exitCode = 1;
      return;
    }

    // Try to parse as JSON, otherwise store as string
    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }

    await setConfigValue(key, value, globals.config);
    fmt.ok(`${accent(key)} = ${dim(String(value))}`);
    return;
  }

  // Default: show full config
  const config = await loadConfig(globals.config);
  const configPath = getConfigPath(globals.config);

  fmt.section('Configuration');
  fmt.kvPair('File', configPath);
  fmt.blank();

  const entries = Object.entries(config);
  if (entries.length === 0) {
    fmt.skip('No configuration set. Run wunderland setup to get started.');
    fmt.blank();
    return;
  }

  for (const [key, value] of entries) {
    const display = typeof value === 'object'
      ? dim(JSON.stringify(value))
      : String(value);
    fmt.kvPair(key, display);
  }
  fmt.blank();
}
