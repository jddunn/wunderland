import { describe, expect, it } from 'vitest';

import type { CapabilityDiscoveryResult } from '@framers/agentos/discovery';

import type { ToolInstance } from '../../runtime/tool-calling.js';
import { planTurnToolDefinitions } from '../turn-tool-selection.js';

function makeTool(name: string): ToolInstance {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    execute: async () => ({ success: true, output: { ok: true } }),
  };
}

function makeDiscoveryResult(toolNames: string[]): CapabilityDiscoveryResult {
  return {
    tier0: 'tier0',
    tier1: toolNames.map((name) => ({
      capability: {
        id: `tool:${name}`,
        kind: 'tool',
        name,
        displayName: name,
        description: `${name} capability`,
        category: 'productivity',
        tags: [],
        requiredSecrets: [],
        requiredTools: [],
        available: true,
        sourceRef: { type: 'tool', toolName: name },
      },
      relevanceScore: 0.9,
      summaryText: `${name} summary`,
    })),
    tier2: [],
    tokenEstimate: {
      tier0Tokens: 10,
      tier1Tokens: 20,
      tier2Tokens: 0,
      totalTokens: 30,
    },
    diagnostics: {
      queryTimeMs: 1,
      embeddingTimeMs: 1,
      graphTraversalTimeMs: 1,
      candidatesScanned: 2,
      capabilitiesRetrieved: toolNames.length,
    },
  };
}

describe('planTurnToolDefinitions', () => {
  it('defaults to discovered mode when discovery result is present', () => {
    const toolMap = new Map<string, ToolInstance>([
      ['web_search', makeTool('web_search')],
      ['news_search', makeTool('news_search')],
      ['extensions_enable', makeTool('extensions_enable')],
    ]);
    const discoveryResult = makeDiscoveryResult(['web_search']);

    const plan = planTurnToolDefinitions({
      toolMap,
      discoveryResult,
    });

    expect(plan.mode).toBe('discovered');
    expect(plan.selectedToolNames).toEqual(['extensions_enable', 'web_search']);
    const names = plan.toolDefs.map((t: any) => t?.function?.name).filter(Boolean).sort();
    expect(names).toEqual(['extensions_enable', 'web_search']);
  });

  it('falls back to all tools when discovery has no loaded tool hits', () => {
    const toolMap = new Map<string, ToolInstance>([
      ['web_search', makeTool('web_search')],
      ['news_search', makeTool('news_search')],
    ]);
    const discoveryResult = makeDiscoveryResult(['nonexistent_tool']);

    const plan = planTurnToolDefinitions({
      toolMap,
      discoveryResult,
    });

    expect(plan.mode).toBe('all');
    expect(plan.reason).toBe('discovered_tools_not_loaded_fallback_all');
    expect(plan.selectedToolNames).toEqual(['news_search', 'web_search']);
  });

  it('honors explicit all mode', () => {
    const toolMap = new Map<string, ToolInstance>([
      ['web_search', makeTool('web_search')],
      ['news_search', makeTool('news_search')],
    ]);
    const discoveryResult = makeDiscoveryResult(['web_search']);

    const plan = planTurnToolDefinitions({
      toolMap,
      discoveryResult,
      requestedMode: 'all',
    });

    expect(plan.mode).toBe('all');
    expect(plan.reason).toBe('requested_all_tools');
    expect(plan.selectedToolNames).toEqual(['news_search', 'web_search']);
  });

  it('forces all tools when runtime recovery is active', () => {
    const toolMap = new Map<string, ToolInstance>([
      ['web_search', makeTool('web_search')],
      ['news_search', makeTool('news_search')],
    ]);
    const discoveryResult = makeDiscoveryResult(['web_search']);

    const plan = planTurnToolDefinitions({
      toolMap,
      discoveryResult,
      forceAllTools: true,
    });

    expect(plan.mode).toBe('all');
    expect(plan.reason).toBe('forced_all_tools');
    expect(plan.selectedToolNames).toEqual(['news_search', 'web_search']);
  });
});

