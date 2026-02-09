/**
 * @fileoverview Resolves preset skill suggestions into SkillSnapshots.
 * @module wunderland/core/PresetSkillResolver
 */

import { PresetLoader } from './PresetLoader.js';

// Use a local interface to avoid hard dependency on the registry types.
interface SkillSnapshot {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string }>;
  resolvedSkills?: unknown[];
  version?: number;
  createdAt: Date;
}

const EMPTY_SNAPSHOT: SkillSnapshot = {
  prompt: '',
  skills: [],
  resolvedSkills: [],
  version: 1,
  createdAt: new Date(),
};

/**
 * Given a preset ID, resolve its suggestedSkills into a SkillSnapshot.
 * Requires `@framers/agentos-skills-registry` at runtime.
 */
export async function resolvePresetSkills(presetId: string): Promise<SkillSnapshot> {
  const loader = new PresetLoader();
  const preset = loader.loadPreset(presetId);
  return resolveSkillsByNames(preset.suggestedSkills);
}

/**
 * Given an array of skill names, build a SkillSnapshot from the curated registry.
 * Unknown skills are warned and skipped.
 *
 * Requires `@framers/agentos-skills-registry` at runtime.
 * Returns an empty snapshot if the registry is not installed.
 */
export async function resolveSkillsByNames(skillNames: string[]): Promise<SkillSnapshot> {
  if (!skillNames.length) return { ...EMPTY_SNAPSHOT, createdAt: new Date() };

  try {
    // Keep these optional without forcing TS to resolve the modules at build time.
    const catalogModule: string = '@framers/agentos-skills-registry/catalog';
    const registryModule: string = '@framers/agentos-skills-registry';
    const catalog: any = await import(catalogModule);
    const registry: any = await import(registryModule);

    const valid = skillNames.filter((name) => {
      const entry = catalog.getSkillByName(name);
      if (!entry) {
        console.warn(`[skills] Unknown skill "${name}" — not found in curated catalog, skipping`);
        return false;
      }
      return true;
    });

    if (!valid.length) return { ...EMPTY_SNAPSHOT, createdAt: new Date() };

    const snapshot = await registry.createCuratedSkillSnapshot({ skills: valid });
    return snapshot as SkillSnapshot;
  } catch (err) {
    console.warn(
      '[skills] Could not resolve curated skills:',
      err instanceof Error ? err.message : String(err),
    );
    return { ...EMPTY_SNAPSHOT, createdAt: new Date() };
  }
}
