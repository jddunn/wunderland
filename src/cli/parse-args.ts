/**
 * @fileoverview Argument parser for the Wunderland CLI.
 * Ported from bin/wunderland.js parseArgs() to TypeScript with global flag support.
 * @module wunderland/cli/parse-args
 */

import type { ParsedArgs, GlobalFlags } from './types.js';

/**
 * Parse process.argv-style arguments into positional args and flags.
 *
 * Supports:
 *  - `--key value` and `--key=value`
 *  - `--flag` (boolean true)
 *  - `-h`, `-v`, `-q`, `-y` short flags
 *  - Positional arguments (anything not a flag)
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  const SHORT_MAP: Record<string, string> = {
    '-h': 'help',
    '-v': 'version',
    '-q': 'quiet',
    '-y': 'yes',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg) continue;

    // Short flags
    if (SHORT_MAP[arg]) {
      flags[SHORT_MAP[arg]] = true;
      continue;
    }

    // Long flags
    if (arg.startsWith('--')) {
      const raw = arg.slice(2);
      const eq = raw.indexOf('=');
      if (eq !== -1) {
        const k = raw.slice(0, eq).trim();
        const v = raw.slice(eq + 1);
        if (k) flags[k] = v;
        continue;
      }

      const key = raw.trim();
      if (!key) continue;

      // Boolean flags that never take a value
      const BOOL_FLAGS = new Set([
        'help',
        'version',
        'quiet',
        'yes',
        'no-color',
        'dry-run',
        'force',
        'no-skills',
        'dangerously-skip-permissions',
        'dangerously-skip-command-safety',
      ]);
      if (BOOL_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }

      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }

    positional.push(arg);
  }

  return { positional, flags };
}

/** Extract global flags from parsed args. */
export function extractGlobalFlags(flags: Record<string, string | boolean>): GlobalFlags {
  return {
    help: flags['help'] === true,
    version: flags['version'] === true,
    quiet: flags['quiet'] === true,
    yes: flags['yes'] === true,
    noColor: flags['no-color'] === true || !!process.env['NO_COLOR'],
    dryRun: flags['dry-run'] === true,
    config: typeof flags['config'] === 'string' ? flags['config'] : undefined,
  };
}
