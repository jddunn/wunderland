// @ts-nocheck
/**
 * @fileoverview `wunderland skills` — manage agent skills (list, info, enable, disable).
 * @module wunderland/cli/commands/skills
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as p from '@clack/prompts';
import type { GlobalFlags } from '../types.js';
import { accent, dim, muted, success as sColor, warn as wColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { glyphs } from '../ui/glyphs.js';
import { printTable } from '../ui/table.js';
import { PresetLoader } from '../../core/PresetLoader.js';

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

// ── Skill categories (inferred from keywords) ────────────────────────────────

const SKILL_CATEGORIES: Record<string, string[]> = {
  'Social Media': ['twitter', 'linkedin', 'instagram', 'facebook', 'threads', 'bluesky', 'mastodon', 'tiktok', 'pinterest', 'reddit', 'youtube', 'social-media', 'social', 'farcaster'],
  'Research': ['search', 'research', 'web', 'news', 'investigation', 'fact-checking', 'summarization'],
  'DevOps & Code': ['coding', 'git', 'github', 'deploy', 'cloud', 'devops', 'infrastructure', 'ci-cd'],
  'Content': ['content', 'writing', 'blog', 'seo', 'copywriting', 'publishing'],
  'Productivity': ['notes', 'reminders', 'calendar', 'tasks', 'notion', 'trello', 'obsidian'],
  'Media': ['image', 'audio', 'video', 'transcription', 'voice', 'music'],
  'Automation': ['scraping', 'browser', 'automation', 'accounts', 'credentials'],
};

function categorizeSkill(skill: SkillEntry): string {
  const tokens = [...(skill.keywords || []), ...skill.id.split('-'), ...skill.name.toLowerCase().split(/\s+/)];
  for (const [category, keywords] of Object.entries(SKILL_CATEGORIES)) {
    if (tokens.some((t) => keywords.includes(t.toLowerCase()))) return category;
  }
  return 'Other';
}

import { scoreSearch } from '../utils/search-scoring.js';

// ── Sub-commands ────────────────────────────────────────────────────────────

async function listSkills(flags: Record<string, string | boolean>): Promise<void> {
  const { entries, source } = await loadCatalog();
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';
  const categoryFilter = typeof flags['category'] === 'string' ? flags['category'].toLowerCase() : null;

  if (format === 'json') {
    const output = categoryFilter
      ? entries.filter((s) => categorizeSkill(s).toLowerCase().includes(categoryFilter))
      : entries;
    console.log(JSON.stringify({ source, skills: output }, null, 2));
    return;
  }

  if (source === 'builtin') {
    fmt.note('Showing built-in catalog (install @framers/agentos-skills-registry for full list)');
  }

  // Group by category
  const grouped = new Map<string, SkillEntry[]>();
  for (const skill of entries) {
    const cat = categorizeSkill(skill);
    if (categoryFilter && !cat.toLowerCase().includes(categoryFilter)) continue;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(skill);
  }

  // Category summary line
  const g = glyphs();
  const catSummary = [...grouped.entries()].map(([cat, skills]) => `${cat} (${skills.length})`).join('  |  ');
  fmt.blank();
  fmt.note(catSummary);
  fmt.blank();

  // Print each category
  for (const [category, skills] of grouped) {
    printTable({
      title: category,
      compact: true,
      columns: [
        { label: 'ID', width: 24 },
        { label: 'Description' },
        { label: g.ok, width: 4, align: 'center' },
      ],
      rows: skills.map((skill) => [
        accent(skill.id),
        muted(skill.description.length > 70 ? skill.description.slice(0, 67) + '...' : skill.description),
        skill.verified ? sColor(g.ok) : muted(g.circle),
      ]),
    });
    fmt.blank();
  }

  const totalShown = [...grouped.values()].reduce((sum, arr) => sum + arr.length, 0);
  fmt.kvPair('Total', `${totalShown} skills${categoryFilter ? ` (filtered by "${categoryFilter}")` : ''}`);
  fmt.note(`Search: ${accent('wunderland skills search <query>')}`);
  fmt.blank();
}

async function searchSkills(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const query = args.join(' ').trim();
  if (!query) {
    fmt.errorBlock('Missing search query', 'Usage: wunderland skills search <query>\n\nExamples:\n  wunderland skills search "social media"\n  wunderland skills search twitter\n  wunderland skills search research');
    process.exitCode = 1;
    return;
  }

  const { entries } = await loadCatalog();
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  const scored = scoreSearch(entries, query, 10)
    .map(r => ({ skill: r.item, score: r.score }));

  if (format === 'json') {
    console.log(JSON.stringify({ query, results: scored.map((r) => ({ ...r.skill, relevance: r.score })) }, null, 2));
    return;
  }

  if (scored.length === 0) {
    fmt.warning(`No skills match "${query}".`);
    fmt.note(`Try: ${accent('wunderland skills list')} to see all available skills.`);
    return;
  }

  const g = glyphs();
  const maxScore = scored[0].score;
  fmt.section(`Skills matching "${query}"`);
  fmt.blank();

  for (const { skill, score } of scored) {
    const pct = Math.min(100, Math.round((score / maxScore) * 100));
    const bar = pct >= 80 ? sColor(`(${pct}%)`) : pct >= 50 ? wColor(`(${pct}%)`) : dim(`(${pct}%)`);
    const verified = skill.verified ? sColor(g.ok) : ' ';
    console.log(`  ${verified} ${accent(skill.id.padEnd(24))} ${bar}  ${muted(skill.description)}`);
  }
  fmt.blank();
  fmt.note(`Enable: ${accent('wunderland skills enable <id>')}`);
  fmt.blank();
}

async function recommendSkills(_args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const result = await loadAgentConfig(process.cwd());
  if (!result) {
    fmt.errorBlock('Missing agent config', `No agent.config.json in current directory.\nRun ${accent('wunderland init <dir>')} first.`);
    process.exitCode = 1;
    return;
  }

  const { config, configPath } = result;
  const presetId = (config.preset as string) || '';
  const enabledSkills: string[] = Array.isArray(config.skills) ? config.skills : [];

  // Load preset to get suggestions
  const presetLoader = new PresetLoader();
  const presets = presetLoader.listPresets();
  const preset = presets.find((p: { id: string }) => p.id === presetId);

  const { entries } = await loadCatalog();
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  const suggested: string[] = [...(preset?.suggestedSkills ?? [])];
  if (suggested.length === 0 && !presetId) {
    fmt.warning('No preset configured — cannot generate recommendations.');
    fmt.note(`Set a preset with ${accent('wunderland init <dir> --preset <name>')} or ${accent('wunderland create')}.`);
    return;
  }

  if (format === 'json') {
    const recs = suggested.map((id) => ({
      id,
      enabled: enabledSkills.includes(id),
      skill: entries.find((e) => e.id === id) || null,
    }));
    console.log(JSON.stringify({ preset: presetId, recommendations: recs }, null, 2));
    return;
  }

  const g = glyphs();
  fmt.section(`Recommendations for "${preset?.name || presetId}"`);
  fmt.blank();

  const toEnable: string[] = [];
  for (const skillId of suggested) {
    const skill = entries.find((e) => e.id === skillId);
    const desc = skill ? muted(skill.description) : muted('(not in catalog)');
    if (enabledSkills.includes(skillId)) {
      console.log(`  ${sColor(g.ok)} ${accent(skillId.padEnd(24))} ${dim('already enabled')}`);
    } else {
      console.log(`  ${muted(g.circle)} ${accent(skillId.padEnd(24))} ${desc}`);
      toEnable.push(skillId);
    }
  }
  fmt.blank();

  if (toEnable.length === 0) {
    fmt.ok('All recommended skills are already enabled!');
    fmt.blank();
    return;
  }

  // Interactive: offer to enable all
  if (process.stdout.isTTY) {
    const confirm = await p.confirm({
      message: `Enable ${toEnable.length} recommended skill${toEnable.length > 1 ? 's' : ''}?`,
      initialValue: true,
    });

    if (!p.isCancel(confirm) && confirm) {
      const skills = [...enabledSkills, ...toEnable];
      config.skills = skills;
      await saveAgentConfig(configPath, config);
      for (const id of toEnable) {
        fmt.ok(`Enabled ${accent(id)}`);
      }
      fmt.blank();
    }
  } else {
    fmt.note(`Enable with: ${toEnable.map((id) => `wunderland skills enable ${id}`).join(' && ')}`);
    fmt.blank();
  }
}

async function infoSkill(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    fmt.errorBlock('Missing skill name', 'Usage: wunderland skills info <name>');
    process.exitCode = 1;
    return;
  }

  const { entries, source } = await loadCatalog();
  const skill = entries.find((s) => s.id === name || s.name === name);

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

  const sealedPath = path.join(process.cwd(), 'sealed.json');
  if (existsSync(sealedPath)) {
    fmt.errorBlock(
      'Agent is sealed',
      `Refusing to modify agent.config.json because ${sealedPath} exists.\nUse ${accent('wunderland verify-seal')} to verify integrity.`,
    );
    process.exitCode = 1;
    return;
  }

  // Validate skill exists (match by id or short name)
  const { entries } = await loadCatalog();
  const skill = entries.find((s) => s.id === name || s.name === name);
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

  const sealedPath = path.join(process.cwd(), 'sealed.json');
  if (existsSync(sealedPath)) {
    fmt.errorBlock(
      'Agent is sealed',
      `Refusing to modify agent.config.json because ${sealedPath} exists.\nUse ${accent('wunderland verify-seal')} to verify integrity.`,
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

  if (sub === 'search') {
    await searchSkills(args.slice(1), flags);
    return;
  }

  if (sub === 'recommend') {
    await recommendSkills(args.slice(1), flags);
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

  fmt.errorBlock('Unknown subcommand', `"${sub}" is not a valid skills subcommand.\nUsage: wunderland skills <list|info|search|recommend|enable|disable> [options]`);
  process.exitCode = 1;
}
