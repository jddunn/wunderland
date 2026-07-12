import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * cli/index.ts is @ts-nocheck with lazy dynamic imports and top-level side
 * effects, so these guards parse the source rather than importing it. They pin
 * two failure classes seen in the wild:
 *   1. a command advertised in help that was never registered (falls through to
 *      the NL router, so `wunderland <cmd>` silently does the wrong thing);
 *   2. a registered command whose dynamic import target does not exist on disk
 *      (build stays green, runtime explodes) — the reorg drift class.
 */
const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(cliDir, 'index.ts'), 'utf8');

function extractBlock(declaration: string): string {
  const start = src.indexOf(declaration);
  expect(start, `${declaration} not found in cli/index.ts`).toBeGreaterThan(-1);
  // Anchor on the assignment brace: the type annotation itself can contain
  // braces (e.g. Record<string, () => Promise<{ default: ... }>>).
  const assign = src.indexOf('= {', start);
  expect(assign, `${declaration} assignment not found`).toBeGreaterThan(-1);
  const open = assign + 2;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in ${declaration}`);
}

function registeredCommands(): string[] {
  const body = extractBlock('const COMMANDS');
  return [...body.matchAll(/^\s*'?([A-Za-z0-9-]+)'?\s*:/gm)].map((m) => m[1]);
}

/**
 * Commands advertised on the help screen. Entries sit at 6-space indent
 * (`      ${w('name')}`); section headers sit at 4-space indent, so indentation
 * separates the two. This is the list users read as "things I can run".
 */
function advertisedCommands(): string[] {
  return [...src.matchAll(/^ {6}\$\{w\('([a-z][a-z0-9-]*)'\)\}/gm)].map((m) => m[1]);
}

describe('CLI command registry integrity', () => {
  it('every advertised command is runnable (registered, aliased, or a pre-dispatch builtin)', () => {
    const commands = new Set(registeredCommands());
    // Resolved before COMMANDS dispatch: `ls` -> agents (alias), and the
    // version/help builtins intercepted in main().
    const preDispatch = new Set(['ls', 'version', 'help']);
    const advertised = advertisedCommands();

    expect(advertised.length).toBeGreaterThan(20);
    expect(commands.size).toBeGreaterThan(30);

    const orphans = [...new Set(advertised)].filter(
      (name) => !commands.has(name) && !preDispatch.has(name),
    );
    expect(
      orphans,
      `commands advertised in --help but not runnable (they fall through to the NL router): ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('the dynamic import target of every registered command exists on disk', () => {
    const body = extractBlock('const COMMANDS');
    const targets = [...body.matchAll(/import\('\.\/(commands\/[^']+)'\)/g)].map((m) => m[1]);

    expect(targets.length).toBeGreaterThan(30);

    const missing = targets.filter((target) => {
      const base = join(cliDir, target.replace(/\.js$/, ''));
      return !existsSync(`${base}.ts`) && !existsSync(join(base, 'index.ts'));
    });

    expect(missing, `registered commands with no module on disk: ${missing.join(', ')}`).toEqual([]);
  });
});
