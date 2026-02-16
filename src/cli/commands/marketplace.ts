/**
 * @fileoverview `wunderland marketplace` — search skills, tools, channels, and providers.
 *
 * Aggregates results from @framers/agentos-skills-registry and
 * @framers/agentos-extensions-registry into a unified search experience.
 *
 * @module wunderland/cli/commands/marketplace
 */

import type { GlobalFlags } from '../types.js';
import { accent, dim, muted, success as sColor } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { loadDotEnvIntoProcessUpward } from '../config/env-manager.js';

interface MarketplaceItem {
  id: string;
  name: string;
  category: string;
  description: string;
  installed: boolean;
  source: 'skills' | 'tools' | 'channels' | 'providers';
}

async function loadAllItems(): Promise<MarketplaceItem[]> {
  const items: MarketplaceItem[] = [];

  // Load skills catalog
  try {
    const skillsRegistryModule = '@framers/agentos-skills-registry';
    const skillsMod: any = await import(skillsRegistryModule);
    if (skillsMod.SKILLS_CATALOG) {
      for (const skill of skillsMod.SKILLS_CATALOG) {
        items.push({
          id: skill.name,
          name: skill.displayName,
          category: skill.category || 'skill',
          description: skill.description,
          installed: true, // Skills are always available as SKILL.md
          source: 'skills',
        });
      }
    }
  } catch {
    // Skills registry not available
  }

  // Load extensions catalog (tools, channels, providers)
  try {
    const registryModule = '@framers/agentos-extensions-registry';
    const registry: any = await import(registryModule);
    if (registry.getAvailableExtensions) {
      const extensions = await registry.getAvailableExtensions();
      for (const ext of extensions) {
        const source: MarketplaceItem['source'] =
          ext.category === 'channel' ? 'channels' :
          ext.category === 'provider' ? 'providers' : 'tools';
        items.push({
          id: ext.name,
          name: ext.displayName,
          category: ext.category,
          description: ext.description,
          installed: ext.available,
          source,
        });
      }
    }
  } catch {
    // Extensions registry not available
  }

  return items;
}

function fuzzyMatch(query: string, item: MarketplaceItem): boolean {
  const q = query.toLowerCase();
  return (
    item.id.toLowerCase().includes(q) ||
    item.name.toLowerCase().includes(q) ||
    item.description.toLowerCase().includes(q) ||
    item.category.toLowerCase().includes(q) ||
    item.source.toLowerCase().includes(q)
  );
}

export default async function cmdMarketplace(
  args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  await loadDotEnvIntoProcessUpward({ startDir: process.cwd(), configDirOverride: globals.config });

  const sub = args[0];
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';

  if (!sub || sub === 'help') {
    fmt.section('wunderland marketplace');
    console.log(`
  ${accent('Subcommands:')}
    ${dim('search <query>')}         Search skills, tools, channels & providers
    ${dim('info <id>')}              Show item details
    ${dim('install <id>')}           Install an extension (npm)

  ${accent('Flags:')}
    ${dim('--format json|table')}    Output format
    ${dim('--source skills|tools|channels|providers')}  Filter by source
`);
    return;
  }

  try {
    if (sub === 'search') {
      const query = args.slice(1).join(' ');
      if (!query) { fmt.errorBlock('Missing query', 'Usage: wunderland marketplace search <query>'); process.exitCode = 1; return; }

      const allItems = await loadAllItems();
      const sourceFilter = typeof flags['source'] === 'string' ? flags['source'] : undefined;
      let results = allItems.filter((item) => fuzzyMatch(query, item));
      if (sourceFilter) {
        results = results.filter((item) => item.source === sourceFilter);
      }

      if (format === 'json') { console.log(JSON.stringify(results, null, 2)); return; }

      fmt.section(`Marketplace: "${query}"`);

      if (results.length === 0) {
        fmt.note(`No results for "${query}". Try a broader search.`);
        fmt.blank();
        return;
      }

      // Group by source
      const grouped = new Map<string, MarketplaceItem[]>();
      for (const item of results) {
        const group = grouped.get(item.source) || [];
        group.push(item);
        grouped.set(item.source, group);
      }

      const sourceLabels: Record<string, string> = {
        skills: 'Skills',
        tools: 'Tool Extensions',
        channels: 'Channel Adapters',
        providers: 'LLM Providers',
      };

      for (const [source, items] of grouped) {
        console.log(`\n  ${accent(sourceLabels[source] || source)}`);
        for (const item of items) {
          const icon = item.installed ? sColor('\u2713') : muted('\u25CB');
          const status = item.installed ? '' : dim(' (not installed)');
          console.log(`    ${icon} ${accent(item.id.padEnd(22))} ${item.description.slice(0, 60)}${status}`);
        }
      }

      fmt.blank();
      fmt.kvPair('Results', `${results.length} of ${allItems.length} items`);
      fmt.blank();

    } else if (sub === 'info') {
      const id = args[1];
      if (!id) { fmt.errorBlock('Missing ID', 'Usage: wunderland marketplace info <id>'); process.exitCode = 1; return; }

      const allItems = await loadAllItems();
      const item = allItems.find((i) => i.id === id || i.name.toLowerCase() === id.toLowerCase());

      if (!item) {
        fmt.errorBlock('Not found', `"${id}" is not in the marketplace.\nRun ${accent('wunderland marketplace search <query>')} to browse.`);
        process.exitCode = 1;
        return;
      }

      if (format === 'json') { console.log(JSON.stringify(item, null, 2)); return; }

      fmt.section(`${item.name}`);
      fmt.kvPair('ID', accent(item.id));
      fmt.kvPair('Type', item.source);
      fmt.kvPair('Category', item.category);
      fmt.kvPair('Description', item.description);
      fmt.kvPair('Installed', item.installed ? sColor('yes') : muted('no'));
      fmt.blank();

    } else if (sub === 'install') {
      const id = args[1];
      if (!id) { fmt.errorBlock('Missing ID', 'Usage: wunderland marketplace install <id>'); process.exitCode = 1; return; }

      const allItems = await loadAllItems();
      const item = allItems.find((i) => i.id === id);

      if (!item) {
        fmt.errorBlock('Not found', `"${id}" is not in the marketplace.`);
        process.exitCode = 1;
        return;
      }

      if (item.installed) {
        fmt.ok(`${accent(item.name)} is already installed.`);
        fmt.blank();
        return;
      }

      fmt.note(`Extension "${item.name}" is not yet installed.\nTo add it, install the npm package: ${accent(`pnpm add @framers/agentos-ext-${item.id}`)}`);
      fmt.blank();

    } else {
      fmt.errorBlock('Unknown subcommand', `"${sub}". Run ${accent('wunderland marketplace')} for help.`);
      process.exitCode = 1;
    }
  } catch (err) {
    fmt.errorBlock('Marketplace Error', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
