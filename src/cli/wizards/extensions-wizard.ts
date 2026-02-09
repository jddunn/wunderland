/**
 * @fileoverview Extensions wizard — categorized, paginated selection for tools, voice, productivity.
 * @module wunderland/cli/wizards/extensions-wizard
 */

import * as p from '@clack/prompts';
import type { WizardState } from '../types.js';
import * as fmt from '../ui/format.js';
import { accent, muted } from '../ui/theme.js';

// ============================================================================
// Types
// ============================================================================

export interface CatalogItem {
  id: string;
  label: string;
  category: 'tool' | 'voice' | 'productivity' | 'skill';
  hint?: string;
  required?: boolean;
  blocked?: boolean;
}

export type CategoryFilter = 'all' | 'tools' | 'voice' | 'productivity' | 'skills';

// ============================================================================
// Constants
// ============================================================================

const ITEMS_PER_PAGE = 10;

// ============================================================================
// Main Wizard
// ============================================================================

/**
 * Run the extensions wizard — allows user to select tools, voice, productivity, and skills.
 * Updates state.extensions with selected items.
 *
 * @param state - Wizard state to update
 */
export async function runExtensionsWizard(state: WizardState): Promise<void> {
  fmt.section('Extensions & Skills');

  // Fetch catalog from registry
  const catalog = await fetchCatalog();

  if (catalog.length === 0) {
    fmt.warning('No extensions available. Skipping extensions wizard.');
    return;
  }

  // Run interactive selection
  const selected = await selectFromCatalog(
    catalog,
    'Select extensions and skills:',
    [],
    new Set(),
    new Set(),
  );

  if (!selected || selected.length === 0) {
    fmt.note('No extensions selected.');
    return;
  }

  // Categorize selections
  const tools: string[] = [];
  const voice: string[] = [];
  const productivity: string[] = [];
  const skills: string[] = [];

  for (const id of selected) {
    const item = catalog.find((c) => c.id === id);
    if (!item) continue;

    switch (item.category) {
      case 'tool':
        tools.push(id);
        break;
      case 'voice':
        voice.push(id);
        break;
      case 'productivity':
        productivity.push(id);
        break;
      case 'skill':
        skills.push(id);
        break;
    }
  }

  // Update state
  if (!state.extensions) {
    state.extensions = {};
  }
  state.extensions.tools = tools;
  state.extensions.voice = voice;
  state.extensions.productivity = productivity;

  if (!state.skills) {
    state.skills = [];
  }
  state.skills = skills;

  // Summary
  const summary = [
    tools.length > 0 ? `Tools: ${accent(tools.join(', '))}` : null,
    voice.length > 0 ? `Voice: ${accent(voice.join(', '))}` : null,
    productivity.length > 0 ? `Productivity: ${accent(productivity.join(', '))}` : null,
    skills.length > 0 ? `Skills: ${accent(skills.join(', '))}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  fmt.blank();
  fmt.note(`Selected extensions:\n${summary}`);
}

// ============================================================================
// Catalog Selector
// ============================================================================

/**
 * Interactive, paginated, categorized multi-select for catalog items.
 *
 * @param items - All available catalog items
 * @param title - Prompt title
 * @param selectedIds - Initially selected IDs
 * @param requiredIds - IDs that must remain selected (pre-selected, can't deselect)
 * @param blockedIds - IDs that are unavailable (grayed out)
 * @returns Selected item IDs
 */
export async function selectFromCatalog(
  items: CatalogItem[],
  title: string,
  selectedIds: string[],
  requiredIds?: Set<string>,
  blockedIds?: Set<string>,
): Promise<string[]> {
  const required = requiredIds ?? new Set<string>();
  const blocked = blockedIds ?? new Set<string>();
  const selected = new Set<string>(selectedIds);

  let category: CategoryFilter = 'all';
  let page = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Filter items by category
    const filtered = filterByCategory(items, category);

    // Paginate
    const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE);
    page = Math.max(0, Math.min(page, totalPages - 1));
    const startIdx = page * ITEMS_PER_PAGE;
    const endIdx = Math.min(startIdx + ITEMS_PER_PAGE, filtered.length);
    const pageItems = filtered.slice(startIdx, endIdx);

    // Build options
    const options = pageItems.map((item) => {
      const isBlocked = blocked.has(item.id);
      const isRequired = required.has(item.id);

      let label = item.label;
      let hint = item.hint ?? '';

      if (isBlocked) {
        label = muted(label);
        hint = hint ? `${hint} (unavailable)` : 'unavailable';
      } else if (isRequired) {
        hint = hint ? `${hint} (required)` : 'required';
      }

      return {
        value: item.id,
        label,
        hint,
        disabled: isBlocked,
      };
    });

    // Add navigation options
    const navOptions: any[] = [];

    if (totalPages > 1) {
      if (page > 0) {
        navOptions.push({
          value: '__prev__',
          label: muted('← Previous Page'),
          hint: `page ${page} of ${totalPages}`,
        });
      }
      if (page < totalPages - 1) {
        navOptions.push({
          value: '__next__',
          label: muted('→ Next Page'),
          hint: `page ${page + 2} of ${totalPages}`,
        });
      }
    }

    navOptions.push({
      value: '__filter__',
      label: muted('⊙ Change Category'),
      hint: `current: ${category}`,
    });

    navOptions.push({
      value: '__done__',
      label: accent('✓ Done'),
      hint: `${selected.size} selected`,
    });

    const allOptions = [...options, ...navOptions];

    // Get initial values for this page
    const initialValues = pageItems
      .filter((item) => selected.has(item.id) || required.has(item.id))
      .map((item) => item.id);

    // Prompt
    const result = await p.multiselect({
      message: `${title} (${category}, page ${page + 1}/${totalPages})`,
      options: allOptions,
      required: false,
      initialValues,
    });

    if (p.isCancel(result)) {
      return Array.from(selected);
    }

    const resultArray = result as string[];

    // Handle navigation
    if (resultArray.includes('__prev__')) {
      page--;
      continue;
    }
    if (resultArray.includes('__next__')) {
      page++;
      continue;
    }
    if (resultArray.includes('__filter__')) {
      const newCategory = await selectCategory(category);
      if (newCategory && newCategory !== category) {
        category = newCategory;
        page = 0;
      }
      continue;
    }
    if (resultArray.includes('__done__')) {
      break;
    }

    // Update selections for this page
    for (const item of pageItems) {
      if (required.has(item.id)) continue; // Can't deselect required items
      if (blocked.has(item.id)) continue; // Can't select blocked items

      if (resultArray.includes(item.id)) {
        selected.add(item.id);
      } else {
        selected.delete(item.id);
      }
    }
  }

  return Array.from(selected);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Filter catalog items by category.
 */
function filterByCategory(items: CatalogItem[], category: CategoryFilter): CatalogItem[] {
  if (category === 'all') return items;
  if (category === 'tools') return items.filter((i) => i.category === 'tool');
  if (category === 'voice') return items.filter((i) => i.category === 'voice');
  if (category === 'productivity') return items.filter((i) => i.category === 'productivity');
  if (category === 'skills') return items.filter((i) => i.category === 'skill');
  return items;
}

/**
 * Prompt user to select a category filter.
 */
async function selectCategory(current: CategoryFilter): Promise<CategoryFilter | null> {
  const result = await p.select<CategoryFilter>({
    message: 'Filter by category:',
    options: [
      { value: 'all', label: 'All', hint: current === 'all' ? 'current' : '' },
      { value: 'tools', label: 'Tools', hint: current === 'tools' ? 'current' : '' },
      { value: 'voice', label: 'Voice', hint: current === 'voice' ? 'current' : '' },
      { value: 'productivity', label: 'Productivity', hint: current === 'productivity' ? 'current' : '' },
      { value: 'skills', label: 'Skills', hint: current === 'skills' ? 'current' : '' },
    ],
  });

  if (p.isCancel(result)) return null;
  return result;
}

/**
 * Fetch catalog from extensions registry and skills registry.
 * Gracefully handles missing registries.
 */
async function fetchCatalog(): Promise<CatalogItem[]> {
  const catalog: CatalogItem[] = [];

  // Try to load extensions registry
  try {
    const { getAvailableExtensions } = await import('@framers/agentos-extensions-registry');
    const available = await getAvailableExtensions();

    for (const ext of available) {
      // Only include if package is available (installed)
      if (!ext.available) continue;

      let category: 'tool' | 'voice' | 'productivity' = 'tool';
      if (ext.category === 'voice') category = 'voice';
      else if (ext.category === 'productivity') category = 'productivity';

      catalog.push({
        id: ext.name,
        label: ext.displayName,
        category,
        hint: ext.description ? ext.description.slice(0, 50) : undefined,
      });
    }
  } catch (err) {
    fmt.warning('Extensions registry not available. Skipping extensions.');
  }

  // Try to load skills registry
  try {
    const skillsRegistry = await import('@framers/agentos-skills-registry');
    const allSkills = await skillsRegistry.getAllSkills();

    for (const skill of allSkills) {
      catalog.push({
        id: skill.name,
        label: skill.displayName,
        category: 'skill',
        hint: skill.description ? skill.description.slice(0, 50) : undefined,
      });
    }
  } catch (err) {
    fmt.warning('Skills registry not available. Skipping skills.');
  }

  return catalog;
}
