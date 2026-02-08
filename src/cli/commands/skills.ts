/**
 * @fileoverview `wunderland skills` — manage agent skills (list, info, enable, disable).
 * @module wunderland/cli/commands/skills
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import chalk from 'chalk';
import type { GlobalFlags } from '../types.js';
import { accent, dim, muted, success as sColor, warn as wColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';

// ── Fallback catalog when @framers/agentos-skills-registry is not installed ─

interface SkillEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  verified: boolean;
  keywords?: string[];
}

const BUILTIN_SKILLS: SkillEntry[] = [
  { id: 'web-search', name: 'Web Search', description: 'Search the web for current information', version: '1.0.0', verified: true, keywords: ['search', 'web'] },
  { id: 'code-interpreter', name: 'Code Interpreter', description: 'Execute code snippets in a sandboxed environment', version: '1.0.0', verified: true, keywords: ['code', 'exec'] },
  { id: 'file-manager', name: 'File Manager', description: 'Read, write, and manage local files', version: '1.0.0', verified: true, keywords: ['files', 'fs'] },
  { id: 'memory', name: 'Memory', description: 'Persistent memory across conversations', version: '1.0.0', verified: true, keywords: ['memory', 'context'] },
  { id: 'calendar', name: 'Calendar', description: 'Manage calendar events and scheduling', version: '1.0.0', verified: true, keywords: ['calendar', 'scheduling'] },
  { id: 'email', name: 'Email', description: 'Send and read emails', version: '1.0.0', verified: true, keywords: ['email', 'messaging'] },
  { id: 'image-generation', name: 'Image Generation', description: 'Generate images from text descriptions', version: '1.0.0', verified: true, keywords: ['image', 'ai'] },
  { id: 'data-analysis', name: 'Data Analysis', description: 'Analyze datasets and generate visualizations', version: '1.0.0', verified: true, keywords: ['data', 'analytics'] },
];

// ── Catalog loading ─────────────────────────────────────────────────────────

async function loadCatalog(): Promise<{ entries: SkillEntry[]; source: string }> {
  try {
    // Keep this optional without forcing TS to resolve the module at build time.
    const moduleName: string = '@framers/agentos-skills-registry';
    const registry: any = await import(moduleName);
    const catalog = await registry.getSkillsCatalog();
    const entries: SkillEntry[] = (catalog.skills.curated ?? []).map((s: any) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      version: s.version,
      verified: s.verified ?? false,
      keywords: s.keywords,
    }));
    return { entries, source: 'registry' };
  } catch {
    return { entries: BUILTIN_SKILLS, source: 'builtin' };
  }
}

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

// ── Sub-commands ────────────────────────────────────────────────────────────

async function listSkills(flags: Record<string, string | boolean>): Promise<void> {
  const { entries, source } = await loadCatalog();
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  if (format === 'json') {
    console.log(JSON.stringify({ source, skills: entries }, null, 2));
    return;
  }

  fmt.section('Available Skills');
  if (source === 'builtin') {
    fmt.note('Showing built-in catalog (install @framers/agentos-skills-registry for full list)');
  }
  fmt.blank();

  console.log(`    ${chalk.white('ID'.padEnd(22))} ${chalk.white('Name'.padEnd(22))} ${chalk.white('Ver'.padEnd(8))} ${chalk.white('Description')}`);
  console.log(`    ${dim('\u2500'.repeat(22))} ${dim('\u2500'.repeat(22))} ${dim('\u2500'.repeat(8))} ${dim('\u2500'.repeat(36))}`);

  for (const skill of entries) {
    const verified = skill.verified ? sColor('\u2713') : muted('\u25CB');
    console.log(`    ${accent(skill.id.padEnd(22))} ${skill.name.padEnd(22)} ${muted(skill.version.padEnd(8))} ${muted(skill.description)} ${verified}`);
  }

  fmt.blank();
  fmt.kvPair('Total', `${entries.length} skills`);
  fmt.blank();
}

async function infoSkill(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    fmt.errorBlock('Missing skill name', 'Usage: wunderland skills info <name>');
    process.exitCode = 1;
    return;
  }

  const { entries, source } = await loadCatalog();
  const skill = entries.find((s) => s.id === name);

  if (!skill) {
    fmt.errorBlock('Skill not found', `"${name}" is not in the ${source} catalog.\nRun ${accent('wunderland skills list')} to see available skills.`);
    process.exitCode = 1;
    return;
  }

  fmt.section(`Skill: ${skill.name}`);
  fmt.kvPair('ID', accent(skill.id));
  fmt.kvPair('Version', skill.version);
  fmt.kvPair('Description', skill.description);
  fmt.kvPair('Verified', skill.verified ? sColor('yes') : wColor('no'));
  if (skill.keywords?.length) {
    fmt.kvPair('Keywords', muted(skill.keywords.join(', ')));
  }
  fmt.kvPair('Source', muted(source));
  fmt.blank();
}

async function enableSkill(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    fmt.errorBlock('Missing skill name', 'Usage: wunderland skills enable <name>');
    process.exitCode = 1;
    return;
  }

  // Validate skill exists
  const { entries } = await loadCatalog();
  const skill = entries.find((s) => s.id === name);
  if (!skill) {
    fmt.errorBlock('Skill not found', `"${name}" is not in the catalog. Run ${accent('wunderland skills list')} to see available skills.`);
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
  const skills: string[] = Array.isArray(config.skills) ? [...config.skills] : [];

  if (skills.includes(name)) {
    fmt.warning(`Skill "${name}" is already enabled.`);
    return;
  }

  skills.push(name);
  config.skills = skills;
  await saveAgentConfig(configPath, config);

  fmt.ok(`Enabled skill ${accent(skill.name)} (${name})`);
  fmt.blank();
}

async function disableSkill(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    fmt.errorBlock('Missing skill name', 'Usage: wunderland skills disable <name>');
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
  const skills: string[] = Array.isArray(config.skills) ? [...config.skills] : [];

  const idx = skills.indexOf(name);
  if (idx === -1) {
    fmt.warning(`Skill "${name}" is not in the enabled list.`);
    return;
  }

  skills.splice(idx, 1);
  config.skills = skills;
  await saveAgentConfig(configPath, config);

  fmt.ok(`Disabled skill ${accent(name)}`);
  fmt.blank();
}

// ── Command ─────────────────────────────────────────────────────────────────

export default async function cmdSkills(
  args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const sub = args[0];

  if (sub === 'list' || !sub) {
    await listSkills(flags);
    return;
  }

  if (sub === 'info') {
    await infoSkill(args.slice(1));
    return;
  }

  if (sub === 'enable') {
    await enableSkill(args.slice(1));
    return;
  }

  if (sub === 'disable') {
    await disableSkill(args.slice(1));
    return;
  }

  fmt.errorBlock('Unknown subcommand', `"${sub}" is not a valid skills subcommand.\nUsage: wunderland skills <list|info|enable|disable> [options]`);
  process.exitCode = 1;
}
