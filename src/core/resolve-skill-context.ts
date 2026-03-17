/**
 * @fileoverview Shared skill resolution for Wunderland runtime surfaces.
 * @module wunderland/core/resolve-skill-context
 */

import { SkillRegistry } from '../skills/index.js';
import type { DiscoverySkillEntry } from '../discovery/index.js';

type LoggerLike = {
  warn?: (msg: string, meta?: unknown) => void;
};

type SkillEntryLike = {
  skill?: {
    name?: string;
    description?: string;
    content?: string;
  };
  frontmatter?: Record<string, unknown>;
  metadata?: {
    primaryEnv?: string;
  };
};

type LoadedCatalogSkill = {
  name: string;
  description: string;
  content: string;
  frontmatter?: Record<string, unknown>;
  metadata?: {
    primaryEnv?: string;
  };
};

export interface ResolvedSkillContext {
  skillsPrompt: string;
  skillEntries: DiscoverySkillEntry[];
  skillNames: string[];
}

export interface ResolveSkillContextOptions {
  filesystemDirs?: string[];
  curatedSkills?: 'all' | string[];
  platform?: string;
  logger?: LoggerLike;
  warningPrefix?: string;
}

const EMPTY_RESULT: ResolvedSkillContext = {
  skillsPrompt: '',
  skillEntries: [],
  skillNames: [],
};

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function toDiscoveryEntryFromFilesystem(entry: SkillEntryLike): DiscoverySkillEntry | null {
  const skill =
    entry.skill ??
    (entry as {
      name?: string;
      description?: string;
      content?: string;
    });
  const name = typeof skill.name === 'string' ? skill.name.trim() : '';
  if (!name) return null;

  const frontmatter = entry.frontmatter ?? {};
  return {
    name,
    description:
      typeof skill.description === 'string' ? skill.description : '',
    content:
      typeof skill.content === 'string' ? skill.content : '',
    category:
      typeof frontmatter.category === 'string' ? frontmatter.category : undefined,
    tags: normalizeStringArray(frontmatter.tags),
    requiredSecrets: normalizeStringArray(frontmatter.requires_secrets),
    requiredTools: normalizeStringArray(frontmatter.requires_tools),
  };
}

function toDiscoveryEntryFromCatalog(skill: LoadedCatalogSkill): DiscoverySkillEntry {
  const frontmatter = skill.frontmatter ?? {};
  return {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    category:
      typeof frontmatter.category === 'string' ? frontmatter.category : undefined,
    tags: normalizeStringArray(frontmatter.tags),
    requiredSecrets: normalizeStringArray(frontmatter.requires_secrets),
    requiredTools: normalizeStringArray(frontmatter.requires_tools),
  };
}

function mergeSkillEntries(target: DiscoverySkillEntry[], source: DiscoverySkillEntry[]): DiscoverySkillEntry[] {
  const existing = new Map(target.map((entry) => [entry.name, entry]));

  for (const entry of source) {
    if (!existing.has(entry.name)) {
      existing.set(entry.name, entry);
      continue;
    }

    const current = existing.get(entry.name)!;
    existing.set(entry.name, {
      ...current,
      description: current.description || entry.description,
      content: current.content || entry.content,
      category: current.category ?? entry.category,
      tags: current.tags ?? entry.tags,
      requiredSecrets: current.requiredSecrets ?? entry.requiredSecrets,
      requiredTools: current.requiredTools ?? entry.requiredTools,
    });
  }

  return Array.from(existing.values());
}

async function resolveFilesystemSkillContext(args: {
  dirs: string[];
  platform: string;
  logger?: LoggerLike;
  warningPrefix: string;
}): Promise<ResolvedSkillContext> {
  const dirs = Array.from(new Set(args.dirs.map((dir) => dir.trim()).filter(Boolean)));
  if (dirs.length === 0) return EMPTY_RESULT;

  try {
    const registry = new SkillRegistry();
    await registry.loadFromDirs(dirs);

    const snapshot = registry.buildSnapshot({ platform: args.platform, strict: true });
    const entries =
      typeof registry.listAll === 'function'
        ? (registry.listAll() as SkillEntryLike[])
            .map(toDiscoveryEntryFromFilesystem)
            .filter((entry): entry is DiscoverySkillEntry => entry !== null)
        : [];

    return {
      skillsPrompt: snapshot.prompt || '',
      skillEntries: entries,
      skillNames: entries.map((entry) => entry.name),
    };
  } catch (error) {
    args.logger?.warn?.(`${args.warningPrefix} Failed to load skills from directories (continuing without)`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_RESULT;
  }
}

async function resolveCuratedSkillNames(selection: 'all' | string[]): Promise<string[]> {
  if (selection !== 'all') {
    return Array.from(new Set(selection.map((name) => name.trim()).filter(Boolean)));
  }

  const catalogModule: any = await import('@framers/agentos-skills-registry/catalog');
  if (typeof catalogModule.getSkillEntries === 'function') {
    return catalogModule.getSkillEntries('all').map((entry: { name: string }) => entry.name);
  }

  if (typeof catalogModule.searchSkills === 'function') {
    return catalogModule.searchSkills('').map((entry: { name: string }) => entry.name);
  }

  return [];
}

async function resolveCuratedSkillContext(args: {
  selection: 'all' | string[];
  logger?: LoggerLike;
  warningPrefix: string;
}): Promise<ResolvedSkillContext> {
  try {
    const [{ resolveSkillsByNames }, catalogModule] = await Promise.all([
      import('./PresetSkillResolver.js'),
      import('@framers/agentos-skills-registry/catalog'),
    ]);

    const selectedNames = await resolveCuratedSkillNames(args.selection);
    if (selectedNames.length === 0) return EMPTY_RESULT;

    const snapshot = await resolveSkillsByNames(selectedNames);
    const resolvedNames = Array.isArray(snapshot?.skills)
      ? snapshot.skills
          .map((skill: string | { name?: string }) =>
            typeof skill === 'string' ? skill : skill?.name ?? '',
          )
          .filter(Boolean)
      : [];

    const loadedSkills =
      resolvedNames.length > 0 && typeof catalogModule.loadSkillsByNames === 'function'
        ? await catalogModule.loadSkillsByNames(resolvedNames)
        : [];

    const entries = Array.isArray(loadedSkills)
      ? loadedSkills.map((skill: LoadedCatalogSkill) => toDiscoveryEntryFromCatalog(skill))
      : resolvedNames.map((name: string) => ({ name, description: '', content: '' }));

    return {
      skillsPrompt: snapshot?.prompt || '',
      skillEntries: entries,
      skillNames: resolvedNames,
    };
  } catch (error) {
    args.logger?.warn?.(`${args.warningPrefix} Failed to load curated skills (continuing without)`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_RESULT;
  }
}

export async function resolveSkillContext(
  options: ResolveSkillContextOptions,
): Promise<ResolvedSkillContext> {
  const platform = options.platform ?? process.platform;
  const warningPrefix = options.warningPrefix ?? '[skills]';

  const filesystem = await resolveFilesystemSkillContext({
    dirs: options.filesystemDirs ?? [],
    platform,
    logger: options.logger,
    warningPrefix,
  });

  const curated =
    options.curatedSkills && (options.curatedSkills === 'all' || options.curatedSkills.length > 0)
      ? await resolveCuratedSkillContext({
          selection: options.curatedSkills,
          logger: options.logger,
          warningPrefix,
        })
      : EMPTY_RESULT;

  return {
    skillsPrompt: [filesystem.skillsPrompt, curated.skillsPrompt].filter(Boolean).join('\n\n'),
    skillEntries: mergeSkillEntries(filesystem.skillEntries, curated.skillEntries),
    skillNames: Array.from(new Set([...filesystem.skillNames, ...curated.skillNames])),
  };
}
