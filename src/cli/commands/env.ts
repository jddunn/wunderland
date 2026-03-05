/**
 * @fileoverview `wunderland env` — manage API keys & secrets in ~/.wunderland/.env.
 *
 * Subcommands:
 *   (none) / list   List all secrets with status
 *   get <KEY>       Show masked value
 *   set <KEY> <VAL> Store a key
 *   delete <KEY>    Remove a key
 *   import          Bulk import from stdin or interactive paste
 *   path            Print .env file path
 *   edit            Open .env in $EDITOR
 *
 * @module wunderland/cli/commands/env
 */

import { spawn } from 'node:child_process';
import type { GlobalFlags } from '../types.js';
import {
  accent,
  dim,
  success as sColor,
  warn as wColor,
  muted,
} from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import {
  loadEnv,
  saveEnv,
  mergeEnv,
  getEnvPath,
  importEnvBlock,
  loadDotEnvIntoProcessUpward,
} from '../config/env-manager.js';
import {
  getAllSecrets,
  checkEnvSecrets,
  groupSecretsByProvider,
} from '../config/secrets.js';

export default async function cmdEnv(
  args: string[],
  _flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case 'get':
      return subGet(args.slice(1), globals);
    case 'set':
      return subSet(args.slice(1), globals);
    case 'delete':
    case 'rm':
    case 'remove':
    case 'unset':
      return subDelete(args.slice(1), globals);
    case 'import':
      return subImport(globals);
    case 'path':
      return subPath(globals);
    case 'edit':
      return subEdit(globals);
    case 'list':
    case undefined:
      return subList(globals);
    default:
      fmt.errorBlock(
        'Unknown subcommand',
        `"${sub}" is not a valid env subcommand. Run ${accent('wunderland env --help')} for usage.`,
      );
      process.exitCode = 1;
  }
}

// ── list (default) ──────────────────────────────────────────────────────────

async function subList(globals: GlobalFlags): Promise<void> {
  // Load env so process.env is populated for checkEnvSecrets().
  await loadDotEnvIntoProcessUpward({
    startDir: process.cwd(),
    configDirOverride: globals.config,
  });

  const byProvider = groupSecretsByProvider();
  const status = checkEnvSecrets();
  const statusMap = new Map(status.map((s) => [s.envVar, s]));

  fmt.section('Environment Secrets');
  fmt.kvPair('File', dim(getEnvPath(globals.config)));
  fmt.blank();

  if (byProvider.size === 0) {
    fmt.skip('No secret definitions found.');
    fmt.blank();
    return;
  }

  let setCount = 0;
  let missingCount = 0;

  for (const [provider, secrets] of byProvider) {
    console.log(`  ${accent(provider)}`);

    for (const secret of secrets) {
      const info = statusMap.get(secret.envVar);
      const isSet = info?.isSet ?? false;
      const masked = info?.maskedValue;
      const statusStr = isSet ? sColor('set') : wColor('missing');
      const valueStr = masked ? dim(masked) : '';

      if (isSet) setCount++;
      else missingCount++;

      console.log(
        `    ${secret.envVar.padEnd(30)} ${statusStr.padEnd(18)} ${valueStr}`,
      );
    }
    fmt.blank();
  }

  fmt.kvPair('Summary', `${sColor(String(setCount))} set, ${wColor(String(missingCount))} missing`);
  fmt.blank();
}

// ── get ─────────────────────────────────────────────────────────────────────

async function subGet(args: string[], globals: GlobalFlags): Promise<void> {
  const key = args[0];
  if (!key) {
    fmt.errorBlock('Missing key', 'Usage: wunderland env get <KEY>');
    process.exitCode = 1;
    return;
  }

  // Resolve secret id (e.g. "openai.apiKey") to env var name.
  const envVar = resolveEnvVar(key);

  await loadDotEnvIntoProcessUpward({
    startDir: process.cwd(),
    configDirOverride: globals.config,
  });

  const val = process.env[envVar];
  if (!val) {
    fmt.skip(`${envVar}: ${muted('not set')}`);
    return;
  }

  const masked =
    val.length > 4 ? '\u2022'.repeat(8) + val.slice(-4) : 'set';
  console.log(`  ${accent(envVar)}: ${dim(masked)}`);
}

// ── set ─────────────────────────────────────────────────────────────────────

async function subSet(args: string[], globals: GlobalFlags): Promise<void> {
  const key = args[0];
  const value = args.slice(1).join(' ');
  if (!key || !value) {
    fmt.errorBlock('Missing arguments', 'Usage: wunderland env set <KEY> <VALUE>');
    process.exitCode = 1;
    return;
  }

  const envVar = resolveEnvVar(key);

  // Warn if not a recognized secret (but still allow storage).
  const allSecrets = getAllSecrets();
  const known = allSecrets.some((s) => s.envVar === envVar);
  if (!known) {
    fmt.warning(`${envVar} is not a recognized secret. Storing anyway.`);
  }

  await mergeEnv({ [envVar]: value }, globals.config);
  fmt.ok(`${accent(envVar)} saved to ${dim(getEnvPath(globals.config))}`);
}

// ── delete ──────────────────────────────────────────────────────────────────

async function subDelete(args: string[], globals: GlobalFlags): Promise<void> {
  const key = args[0];
  if (!key) {
    fmt.errorBlock('Missing key', 'Usage: wunderland env delete <KEY>');
    process.exitCode = 1;
    return;
  }

  const envVar = resolveEnvVar(key);
  const env = await loadEnv(globals.config);

  if (!(envVar in env)) {
    fmt.skip(`${envVar}: ${muted('not set — nothing to delete')}`);
    return;
  }

  delete env[envVar];
  await saveEnv(env, globals.config);
  fmt.ok(`Deleted ${accent(envVar)}`);
}

// ── import ──────────────────────────────────────────────────────────────────

async function subImport(globals: GlobalFlags): Promise<void> {
  let text: string;

  if (!process.stdin.isTTY) {
    // Piped input — read from stdin.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    text = Buffer.concat(chunks).toString('utf-8').trim();
  } else {
    // Interactive — prompt for paste.
    const p = await import('@clack/prompts');
    const input = await p.text({
      message: 'Paste your .env block (KEY=VALUE lines):',
      placeholder: 'OPENAI_API_KEY=sk-...',
    });
    if (p.isCancel(input) || !input) {
      fmt.note('Cancelled.');
      return;
    }
    text = String(input).trim();
  }

  if (!text) {
    fmt.skip('No input provided.');
    return;
  }

  const result = await importEnvBlock(text);

  fmt.section('Import Results');
  fmt.kvPair('Total keys', String(result.total));
  fmt.kvPair('Imported', sColor(String(result.imported)));
  fmt.kvPair('Updated', accent(String(result.updated)));
  fmt.kvPair('Skipped', dim(String(result.skipped)));
  fmt.kvPair('Unrecognized', result.unrecognized > 0 ? wColor(String(result.unrecognized)) : dim('0'));
  fmt.blank();

  if (result.details.length > 0) {
    for (const d of result.details) {
      const actionColor =
        d.action === 'imported' ? sColor
        : d.action === 'updated' ? accent
        : d.action === 'unrecognized' ? wColor
        : dim;
      console.log(`  ${d.key.padEnd(30)} ${actionColor(d.action)}`);
    }
    fmt.blank();
  }

  fmt.kvPair('File', dim(getEnvPath(globals.config)));
  fmt.blank();
}

// ── path ────────────────────────────────────────────────────────────────────

function subPath(globals: GlobalFlags): void {
  console.log(getEnvPath(globals.config));
}

// ── edit ────────────────────────────────────────────────────────────────────

async function subEdit(globals: GlobalFlags): Promise<void> {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const filePath = getEnvPath(globals.config);

  fmt.note(`Opening ${dim(filePath)} in ${accent(editor)}...`);

  await new Promise<void>((resolve) => {
    const child = spawn(editor, [filePath], {
      stdio: 'inherit',
      env: { ...process.env },
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        fmt.errorBlock('Editor not found', `Could not find "${editor}". Set $EDITOR.`);
        process.exitCode = 1;
      }
      resolve();
    });

    child.on('close', () => {
      resolve();
    });
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a key to an env var name.
 * Accepts either the env var directly (OPENAI_API_KEY) or a secret id (openai.apiKey).
 */
function resolveEnvVar(input: string): string {
  // If it looks like an env var already (ALL_CAPS_WITH_UNDERSCORES), use it directly.
  if (/^[A-Z][A-Z0-9_]*$/.test(input)) return input;

  // Try to resolve from secret definitions by id.
  const secrets = getAllSecrets();
  const match = secrets.find((s) => s.id === input);
  if (match) return match.envVar;

  // Fallback: convert dot.camelCase to UPPER_SNAKE_CASE.
  return input
    .replace(/\./g, '_')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toUpperCase();
}
