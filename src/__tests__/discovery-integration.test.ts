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

import { WunderlandDiscoveryManager, type WunderlandDiscoveryConfig, type WunderlandDiscoveryStats } from '../discovery/index.js';
import { derivePresetCoOccurrences } from '../discovery/preset-co-occurrence.js';
import { validateWunderlandAgentConfig } from '../config/schema.js';

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
        embeddingProvider: 'openai',
        embeddingModel: 'text-embedding-3-small',
        scanManifests: true,
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
});
