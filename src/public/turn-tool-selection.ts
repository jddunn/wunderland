import type { CapabilityDiscoveryResult } from '@framers/agentos/discovery';

import { buildToolDefs, type ToolInstance } from '../runtime/tool-calling.js';

export type TurnToolSelectionMode = 'all' | 'discovered';

const ALWAYS_INCLUDED_META_TOOLS = new Set([
  'discover_capabilities',
  'extensions_list',
  'extensions_enable',
  'extensions_status',
]);

function normalizeSelectionMode(raw: unknown): TurnToolSelectionMode | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'all') return 'all';
  if (value === 'discovered') return 'discovered';
  return null;
}

function collectDiscoveredToolNames(result: CapabilityDiscoveryResult | null | undefined): Set<string> {
  const names = new Set<string>();
  if (!result) return names;

  const collect = (capability: any) => {
    if (!capability || capability.kind !== 'tool') return;
    const rawId = typeof capability.id === 'string' ? capability.id : '';
    const rawName = typeof capability.name === 'string' ? capability.name : '';
    const normalized = rawId.startsWith('tool:') ? rawId.slice(5) : rawName;
    if (normalized) names.add(normalized);
  };

  for (const item of result.tier1 ?? []) collect(item?.capability);
  for (const item of result.tier2 ?? []) collect(item?.capability);
  return names;
}

export function planTurnToolDefinitions(opts: {
  toolMap: Map<string, ToolInstance>;
  discoveryResult?: CapabilityDiscoveryResult | null;
  requestedMode?: unknown;
  forceAllTools?: boolean;
}): {
  mode: TurnToolSelectionMode;
  reason: string;
  selectedToolNames: string[];
  toolDefs: Array<Record<string, unknown>>;
} {
  if (opts.forceAllTools) {
    const names = [...opts.toolMap.keys()].sort();
    return {
      mode: 'all',
      reason: 'forced_all_tools',
      selectedToolNames: names,
      toolDefs: buildToolDefs(opts.toolMap),
    };
  }

  const explicitMode = normalizeSelectionMode(opts.requestedMode);
  const discoveredNames = collectDiscoveredToolNames(opts.discoveryResult);
  for (const name of ALWAYS_INCLUDED_META_TOOLS) {
    if (opts.toolMap.has(name)) discoveredNames.add(name);
  }

  const targetMode: TurnToolSelectionMode =
    explicitMode ?? (opts.discoveryResult ? 'discovered' : 'all');
  if (targetMode === 'all') {
    const names = [...opts.toolMap.keys()].sort();
    return {
      mode: 'all',
      reason: explicitMode === 'all' ? 'requested_all_tools' : 'discovery_unavailable',
      selectedToolNames: names,
      toolDefs: buildToolDefs(opts.toolMap),
    };
  }

  if (discoveredNames.size === 0) {
    const names = [...opts.toolMap.keys()].sort();
    return {
      mode: 'all',
      reason: 'no_discovered_tools_fallback_all',
      selectedToolNames: names,
      toolDefs: buildToolDefs(opts.toolMap),
    };
  }

  const filteredMap = new Map<string, ToolInstance>();
  for (const [name, tool] of opts.toolMap.entries()) {
    if (discoveredNames.has(name)) filteredMap.set(name, tool);
  }
  if (filteredMap.size === 0) {
    const names = [...opts.toolMap.keys()].sort();
    return {
      mode: 'all',
      reason: 'discovered_tools_not_loaded_fallback_all',
      selectedToolNames: names,
      toolDefs: buildToolDefs(opts.toolMap),
    };
  }

  const selectedToolNames = [...filteredMap.keys()].sort();
  return {
    mode: 'discovered',
    reason: explicitMode === 'discovered'
      ? 'requested_discovered_tools'
      : 'auto_discovered_tools',
    selectedToolNames,
    toolDefs: buildToolDefs(filteredMap),
  };
}

