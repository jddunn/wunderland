// @ts-nocheck
/**
 * @fileoverview Integration tests for Wunderland Capability Discovery.
 * @module wunderland/__tests__/discovery-integration
 *
 * Tests:
 *   - WunderlandDiscoveryManager initialization + graceful degradation
 *   - derivePresetCoOccurrences() from agent presets
 *   - Config validation for discovery field
 *   - WunderlandDiscoveryConfig → CapabilityDiscoveryConfig mapping
 */

import { describe, it, expect, vi } from 'vitest';

import { WunderlandDiscoveryManager, type WunderlandDiscoveryConfig, type WunderlandDiscoveryStats } from '../platform/discovery/discovery-index.js';
import { derivePresetCoOccurrences } from '../platform/discovery/preset-co-occurrence.js';
import { validateWunderlandAgentConfig } from '../platform/config/schema.js';

// ============================================================================
// WunderlandDiscoveryManager
// ============================================================================

describe('WunderlandDiscoveryManager', () => {
  it('creates with default config', () => {
    const manager = new WunderlandDiscoveryManager();
    expect(manager.engine).toBeNull();
    expect(manager.getMetaTool()).toBeNull();
  });

  it('creates with explicit config', () => {
    const config: WunderlandDiscoveryConfig = {
      enabled: true,
      registerMetaTool: false,
      scanManifestDirs: false,
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      config: {
        tier0TokenBudget: 100,
        tier1TopK: 3,
      },
    };
    const manager = new WunderlandDiscoveryManager(config);
    expect(manager.engine).toBeNull();
  });

  it('disabled when enabled=false', async () => {
    const manager = new WunderlandDiscoveryManager({ enabled: false });
    const toolMap = new Map();
    toolMap.set('test', {
      name: 'test',
      description: 'test tool',
      inputSchema: { type: 'object', properties: {} },
    });

    await manager.initialize({
      toolMap,
      llmConfig: { providerId: 'openai', apiKey: 'test-key' },
    });

    expect(manager.engine).toBeNull();
    expect(manager.getMetaTool()).toBeNull();
  });

  it('gracefully degrades when no embedding provider available', async () => {
    const manager = new WunderlandDiscoveryManager();
    const toolMap = new Map();
    toolMap.set('test', {
      name: 'test',
      description: 'test tool',
      inputSchema: { type: 'object', properties: {} },
    });

    // Use unknown provider ID — resolveEmbeddingConfig will return null
    await manager.initialize({
      toolMap,
      llmConfig: { providerId: 'unknown-provider', apiKey: 'test-key' },
    });

    expect(manager.engine).toBeNull();
    expect(manager.getMetaTool()).toBeNull();

    const result = await manager.discoverForTurn('hello');
    expect(result).toBeNull();
  });

  it('accepts promise-based API key inputs and still degrades gracefully when provider is unsupported', async () => {
    const manager = new WunderlandDiscoveryManager();
    const toolMap = new Map();
    toolMap.set('test', {
      name: 'test',
      description: 'test tool',
      inputSchema: { type: 'object', properties: {} },
    });

    await manager.initialize({
      toolMap,
      llmConfig: {
        providerId: 'unknown-provider',
        apiKey: Promise.resolve('test-key'),
      },
    });

    expect(manager.engine).toBeNull();
    expect(manager.getMetaTool()).toBeNull();
  });

  it('gracefully disables discovery when API key input is invalid', async () => {
    const manager = new WunderlandDiscoveryManager();
    const toolMap = new Map();
    toolMap.set('test', {
      name: 'test',
      description: 'test tool',
      inputSchema: { type: 'object', properties: {} },
    });

    await manager.initialize({
      toolMap,
      llmConfig: {
        providerId: 'openai',
        apiKey: {} as any,
      },
    });

    expect(manager.engine).toBeNull();
    expect(manager.getMetaTool()).toBeNull();
  });

  it('getStats returns correct defaults when not initialized', () => {
    const manager = new WunderlandDiscoveryManager();
    const stats: WunderlandDiscoveryStats = manager.getStats();

    expect(stats.enabled).toBe(false);
    expect(stats.initialized).toBe(false);
    expect(stats.capabilityCount).toBe(0);
    expect(stats.graphNodes).toBe(0);
    expect(stats.graphEdges).toBe(0);
    expect(stats.presetCoOccurrences).toBe(0);
    expect(stats.manifestDirs).toEqual([]);
  });

  it('close() is safe to call when not initialized', async () => {
    const manager = new WunderlandDiscoveryManager();
    // Should not throw
    await manager.close();
    expect(manager.engine).toBeNull();
    expect(manager.getMetaTool()).toBeNull();
  });

  it('close() is safe to call multiple times', async () => {
    const manager = new WunderlandDiscoveryManager();
    await manager.close();
    await manager.close();
    expect(manager.engine).toBeNull();
  });

  it('discoverForTurn returns null when not initialized', async () => {
    const manager = new WunderlandDiscoveryManager();
    const result = await manager.discoverForTurn('hello world');
    expect(result).toBeNull();
  });
});

// ============================================================================
// Preset Co-occurrence
// ============================================================================

describe('derivePresetCoOccurrences', () => {
  it('returns an array (may be empty if presets not loadable)', () => {
    const result = derivePresetCoOccurrences();
    expect(Array.isArray(result)).toBe(true);
  });

  it('entries have expected shape', () => {
    const result = derivePresetCoOccurrences();
    for (const entry of result) {
      expect(typeof entry.presetName).toBe('string');
      expect(entry.presetName.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.capabilityIds)).toBe(true);
      for (const id of entry.capabilityIds) {
        expect(typeof id).toBe('string');
        // IDs should follow the convention: tool:name, skill:name, or channel:name
        expect(id).toMatch(/^(tool|skill|channel):/);
      }
    }
  });

  it('is idempotent', () => {
    const a = derivePresetCoOccurrences();
    const b = derivePresetCoOccurrences();
    expect(a).toEqual(b);
  });
});

// ============================================================================
// Config Validation
// ============================================================================

describe('validateWunderlandAgentConfig — discovery field', () => {
  it('accepts valid discovery config', () => {
    const { issues } = validateWunderlandAgentConfig({
      seedId: 'test',
      discovery: {
        enabled: true,
        tier0Budget: 200,
        tier1Budget: 800,
        tier2Budget: 2000,
        tier1TopK: 5,
        tier2TopK: 2,
        recallProfile: 'aggressive',
        embeddingProvider: 'openai',
        embeddingModel: 'text-embedding-3-small',
        scanManifests: true,
        tier1MinRelevance: 0.25,
        graphBoostFactor: 1.2,
        config: { registerMetaTool: true },
      },
    });
    const discoveryIssues = issues.filter((i) => i.path.startsWith('discovery'));
    expect(discoveryIssues).toHaveLength(0);
  });

  it('accepts empty discovery config', () => {
    const { issues } = validateWunderlandAgentConfig({
      seedId: 'test',
      discovery: {},
    });
    const discoveryIssues = issues.filter((i) => i.path.startsWith('discovery'));
    expect(discoveryIssues).toHaveLength(0);
  });

  it('accepts config without discovery field', () => {
    const { issues } = validateWunderlandAgentConfig({
      seedId: 'test',
    });
    const discoveryIssues = issues.filter((i) => i.path.startsWith('discovery'));
    expect(discoveryIssues).toHaveLength(0);
  });

  it('reports issue when discovery.enabled is not boolean', () => {
    const { issues } = validateWunderlandAgentConfig({
      discovery: { enabled: 'yes' },
    });
    const discoveryIssues = issues.filter((i) => i.path === 'discovery.enabled');
    expect(discoveryIssues.length).toBeGreaterThan(0);
  });

  it('reports issue when discovery.tier0Budget is not number', () => {
    const { issues } = validateWunderlandAgentConfig({
      discovery: { tier0Budget: '200' },
    });
    const discoveryIssues = issues.filter((i) => i.path === 'discovery.tier0Budget');
    expect(discoveryIssues.length).toBeGreaterThan(0);
  });

  it('reports issue when discovery.embeddingProvider is not string', () => {
    const { issues } = validateWunderlandAgentConfig({
      discovery: { embeddingProvider: 42 },
    });
    const discoveryIssues = issues.filter((i) => i.path === 'discovery.embeddingProvider');
    expect(discoveryIssues.length).toBeGreaterThan(0);
  });

  it('reports issue when discovery is not an object', () => {
    const { issues } = validateWunderlandAgentConfig({
      discovery: 'enabled',
    });
    const discoveryIssues = issues.filter((i) => i.path === 'discovery');
    expect(discoveryIssues.length).toBeGreaterThan(0);
  });

  it('reports issue when discovery.scanManifests is not boolean', () => {
    const { issues } = validateWunderlandAgentConfig({
      discovery: { scanManifests: 1 },
    });
    const discoveryIssues = issues.filter((i) => i.path === 'discovery.scanManifests');
    expect(discoveryIssues.length).toBeGreaterThan(0);
  });

  it('reports issue when discovery.config is not an object', () => {
    const { issues } = validateWunderlandAgentConfig({
      discovery: { config: 'bad' },
    });
    const discoveryIssues = issues.filter((i) => i.path === 'discovery.config');
    expect(discoveryIssues.length).toBeGreaterThan(0);
  });

  it('accepts discovery.recallProfile enum values', () => {
    for (const recallProfile of ['aggressive', 'balanced', 'precision']) {
      const { issues } = validateWunderlandAgentConfig({
        discovery: { recallProfile },
      });
      const discoveryIssues = issues.filter((i) => i.path.startsWith('discovery'));
      expect(discoveryIssues).toHaveLength(0);
    }
  });

  it('reports issue for invalid discovery.recallProfile', () => {
    const { issues } = validateWunderlandAgentConfig({
      discovery: { recallProfile: 'ultra' },
    });
    const discoveryIssues = issues.filter((i) => i.path === 'discovery.recallProfile');
    expect(discoveryIssues.length).toBeGreaterThan(0);
  });

  it('accepts boolean toolCalling.strictToolNames', () => {
    const { issues } = validateWunderlandAgentConfig({
      toolCalling: { strictToolNames: true },
    });
    const toolCallingIssues = issues.filter((i) => i.path.startsWith('toolCalling'));
    expect(toolCallingIssues).toHaveLength(0);
  });

  it('reports issue when toolCalling.strictToolNames is not boolean', () => {
    const { issues } = validateWunderlandAgentConfig({
      toolCalling: { strictToolNames: 'yes' },
    });
    const toolCallingIssues = issues.filter((i) => i.path === 'toolCalling.strictToolNames');
    expect(toolCallingIssues.length).toBeGreaterThan(0);
  });
});

describe('validateWunderlandAgentConfig — rag field', () => {
  it('accepts valid rag config', () => {
    const { issues } = validateWunderlandAgentConfig({
      rag: {
        enabled: true,
        backendUrl: 'http://localhost:3001',
        defaultTopK: 6,
        preset: 'accurate',
        collectionIds: ['docs'],
        includeGraphRag: true,
        includeAudit: true,
        includeDebug: false,
        queryVariants: ['agent memory'],
        filters: { category: 'knowledge_base' },
        strategy: 'hybrid_search',
        strategyParams: { mmrLambda: 0.7, mmrCandidateMultiplier: 5 },
        rewrite: { enabled: true, maxVariants: 2 },
        hyde: {
          enabled: true,
          initialThreshold: 0.8,
          minThreshold: 0.4,
          thresholdStep: 0.05,
          adaptiveThreshold: true,
          maxHypothesisTokens: 256,
          hypothesisSystemPrompt: 'Custom HyDE prompt',
          fullAnswerGranularity: false,
        },
      },
    });
    const ragIssues = issues.filter((i) => i.path.startsWith('rag'));
    expect(ragIssues).toHaveLength(0);
  });

  it('reports invalid rag enum fields', () => {
    const { issues } = validateWunderlandAgentConfig({
      rag: {
        preset: 'slow',
        strategy: 'semantic_magic',
      },
    });
    expect(issues.some((i) => i.path === 'rag.preset')).toBe(true);
    expect(issues.some((i) => i.path === 'rag.strategy')).toBe(true);
  });

  it('reports invalid rag nested field types', () => {
    const { issues } = validateWunderlandAgentConfig({
      rag: {
        collectionIds: 'docs',
        queryVariants: 'variant',
        filters: 'bad',
        strategyParams: { mmrLambda: '0.7' },
        rewrite: { enabled: 'yes' },
        hyde: { enabled: 'yes', maxHypothesisTokens: '256' },
      },
    });
    expect(issues.some((i) => i.path === 'rag.collectionIds')).toBe(true);
    expect(issues.some((i) => i.path === 'rag.queryVariants')).toBe(true);
    expect(issues.some((i) => i.path === 'rag.filters')).toBe(true);
    expect(issues.some((i) => i.path === 'rag.strategyParams.mmrLambda')).toBe(true);
    expect(issues.some((i) => i.path === 'rag.rewrite.enabled')).toBe(true);
    expect(issues.some((i) => i.path === 'rag.hyde.enabled')).toBe(true);
    expect(issues.some((i) => i.path === 'rag.hyde.maxHypothesisTokens')).toBe(true);
  });
});

describe('validateWunderlandAgentConfig — research field', () => {
  it('accepts valid research config', () => {
    const { issues } = validateWunderlandAgentConfig({
      research: {
        autoClassify: true,
        minDepthToInject: 'moderate',
      },
    });
    expect(issues.filter((i) => i.path.startsWith('research'))).toHaveLength(0);
  });

  it('reports invalid research field types', () => {
    const { issues } = validateWunderlandAgentConfig({
      research: {
        autoClassify: 'yes',
        minDepthToInject: 'aggressive',
      },
    });
    expect(issues.some((i) => i.path === 'research.autoClassify')).toBe(true);
    expect(issues.some((i) => i.path === 'research.minDepthToInject')).toBe(true);
  });

  it('reports issue when research is not an object', () => {
    const { issues } = validateWunderlandAgentConfig({
      research: 'deep',
    });
    expect(issues.some((i) => i.path === 'research')).toBe(true);
  });
});

describe('validateWunderlandAgentConfig — personaRegistry field', () => {
  it('accepts valid persona registry config', () => {
    const { issues } = validateWunderlandAgentConfig({
      selectedPersonaId: 'voice_assistant_persona',
      personaRegistry: {
        enabled: true,
        includeBuiltIns: true,
        paths: ['./personas'],
        recursive: true,
        fileExtension: '.json',
        selectedPersonaId: 'voice_assistant_persona',
      },
    });
    expect(issues.filter((issue) => issue.path.startsWith('personaRegistry'))).toHaveLength(0);
    expect(issues.filter((issue) => issue.path === 'selectedPersonaId')).toHaveLength(0);
  });

  it('reports invalid persona registry field types', () => {
    const { issues } = validateWunderlandAgentConfig({
      selectedPersonaId: 123,
      personaRegistry: {
        enabled: 'yes',
        paths: './personas',
        recursive: 'sometimes',
      },
    });
    expect(issues.some((issue) => issue.path === 'selectedPersonaId')).toBe(true);
    expect(issues.some((issue) => issue.path === 'personaRegistry.enabled')).toBe(true);
    expect(issues.some((issue) => issue.path === 'personaRegistry.paths')).toBe(true);
    expect(issues.some((issue) => issue.path === 'personaRegistry.recursive')).toBe(true);
  });
});
