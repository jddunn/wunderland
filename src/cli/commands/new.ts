// @ts-nocheck
/**
 * @fileoverview `wunderland new` — unified agent scaffold entry point.
 * Consolidates `init` and `create` into one command:
 *   wunderland new                         → interactive (asks preset vs NL description)
 *   wunderland new --preset research       → direct scaffold (like init)
 *   wunderland new "Build a twitter bot"   → NL creation (like create)
 *   wunderland new --from template.json    → import from manifest
 * @module wunderland/cli/commands/new
 */

import * as p from '@clack/prompts';
import type { GlobalFlags } from '../types.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

export default async function cmdNew(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  // ── Direct dispatch: --preset flag → init ────────────────────────────────
  if (typeof flags['preset'] === 'string') {
    const dirName = args[0] || flags['preset'];
    const cmdInit = (await import('./init.js')).default;
    await cmdInit([String(dirName)], flags, globals);
    return;
  }

  // ── Direct dispatch: --from flag → import ────────────────────────────────
  if (typeof flags['from'] === 'string') {
    const cmdImport = (await import('./import-agent.js')).default;
    await cmdImport([flags['from']], flags, globals);
    return;
  }

  // ── Direct dispatch: free-text args → create ─────────────────────────────
  const description = args.join(' ').trim();
  if (description.length >= 10) {
    const cmdCreate = (await import('./create.js')).default;
    await cmdCreate(args, flags, globals);
    return;
  }

  // ── Interactive: ask how user wants to create ─────────────────────────────
  fmt.section('Create a New Agent');
  fmt.blank();

  const mode = await p.select({
    message: 'How do you want to create your agent?',
    options: [
      { value: 'preset', label: 'From a preset', hint: 'research, social-media, operations, etc.' },
      { value: 'describe', label: 'Describe in plain English', hint: 'AI extracts full config from your description' },
      { value: 'blank', label: 'Blank agent', hint: 'minimal scaffold, configure later' },
      { value: 'import', label: 'Import manifest', hint: 'from a shared agent.manifest.json' },
    ],
  });

  if (p.isCancel(mode)) return;

  if (mode === 'preset') {
    // Show available presets and let user pick
    let presets: Array<{ id: string; name: string; description: string }> = [];
    try {
      const { PresetLoader } = await import('../../core/PresetLoader.js');
      const loader = new PresetLoader();
      presets = loader.listPresets().map((pre) => ({
        id: pre.id,
        name: pre.name,
        description: pre.description,
      }));
    } catch { /* fallback below */ }

    if (presets.length === 0) {
      fmt.note('No presets found. Falling back to blank agent scaffold.');
      const dirName = await promptDirName();
      if (!dirName) return;
      const cmdInit = (await import('./init.js')).default;
      await cmdInit([dirName], flags, globals);
      return;
    }

    const preset = await p.select({
      message: 'Choose a preset:',
      options: presets.map((pre) => ({
        value: pre.id,
        label: pre.name,
        hint: pre.description,
      })),
    });

    if (p.isCancel(preset)) return;

    const dirName = await promptDirName(String(preset));
    if (!dirName) return;

    const cmdInit = (await import('./init.js')).default;
    await cmdInit([dirName], { ...flags, preset: String(preset) }, globals);
    return;
  }

  if (mode === 'describe') {
    const cmdCreate = (await import('./create.js')).default;
    await cmdCreate([], flags, globals);
    return;
  }

  if (mode === 'blank') {
    const dirName = await promptDirName();
    if (!dirName) return;
    const cmdInit = (await import('./init.js')).default;
    await cmdInit([dirName], flags, globals);
    return;
  }

  if (mode === 'import') {
    const manifestPath = await p.text({
      message: 'Path to manifest file:',
      placeholder: './agent.manifest.json',
      validate: (val: string) => {
        if (!val.trim()) return 'Path is required';
        return undefined;
      },
    });

    if (p.isCancel(manifestPath)) return;

    const cmdImport = (await import('./import-agent.js')).default;
    await cmdImport([String(manifestPath)], flags, globals);
    return;
  }
}

async function promptDirName(defaultName?: string): Promise<string | null> {
  const dirName = await p.text({
    message: 'Agent directory name:',
    placeholder: defaultName || 'my-agent',
    defaultValue: defaultName,
    validate: (val: string) => {
      if (!val.trim()) return 'Directory name is required';
      if (/[<>:"|?*]/.test(val)) return 'Invalid characters in directory name';
      return undefined;
    },
  });

  if (p.isCancel(dirName)) return null;
  return String(dirName).trim();
}
