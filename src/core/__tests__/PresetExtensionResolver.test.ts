/**
 * @fileoverview Unit tests for PresetExtensionResolver
 * @module wunderland/core/__tests__/PresetExtensionResolver
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolvePresetExtensions, resolveExtensionsByNames } from '../PresetExtensionResolver.js';

// Mock the extensions registry module
vi.mock('@framers/agentos-extensions-registry', () => ({
  getAvailableExtensions: vi.fn(async () => [
    {
      name: 'web-search',
      packageName: '@framers/agentos-ext-web-search',
      category: 'tool',
      available: true,
      displayName: 'Web Search',
      description: 'Search the web',
      requiredSecrets: [],
      defaultPriority: 10,
    },
    {
      name: 'web-browser',
      packageName: '@framers/agentos-ext-web-browser',
      category: 'tool',
      available: true,
      displayName: 'Web Browser',
      description: 'Browse the web',
      requiredSecrets: [],
      defaultPriority: 10,
    },
    {
      name: 'news-search',
      packageName: '@framers/agentos-ext-news-search',
      category: 'tool',
      available: true,
      displayName: 'News Search',
      description: 'Search news',
      requiredSecrets: ['newsapi'],
      defaultPriority: 5,
    },
    {
      name: 'voice-synthesis',
      packageName: '@framers/agentos-ext-voice-synthesis',
      category: 'voice',
      available: false, // Not available
      displayName: 'Voice Synthesis',
      description: 'Text to speech',
      requiredSecrets: ['elevenlabs'],
      defaultPriority: 15,
    },
  ]),
  createCuratedManifest: vi.fn(async (options) => ({
    packs: [
      ...(options?.tools !== 'none' && Array.isArray(options.tools)
        ? options.tools.map((name: string) => ({
            package: `@framers/agentos-ext-${name}`,
            priority: 10,
            options: {},
          }))
        : []),
      ...(options?.voice !== 'none' && Array.isArray(options.voice)
        ? options.voice.map((name: string) => ({
            package: `@framers/agentos-ext-${name}`,
            priority: 15,
            options: {},
          }))
        : []),
    ],
    overrides: options?.overrides || {},
  })),
}));

describe('PresetExtensionResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveExtensionsByNames', () => {
    it('should resolve available tool extensions', async () => {
      const result = await resolveExtensionsByNames(
        ['web-search', 'web-browser'],
        [],
        []
      );

      expect(result.manifest.packs).toHaveLength(2);
      expect(result.missing).toEqual([]);
      expect(result.blocked).toEqual([]);
    });

    it('should track missing extensions', async () => {
      const result = await resolveExtensionsByNames(
        ['web-search', 'nonexistent-tool'],
        [],
        []
      );

      expect(result.manifest.packs).toHaveLength(1);
      expect(result.missing).toContain('nonexistent-tool');
    });

    it('should skip unavailable extensions and track them as missing', async () => {
      const result = await resolveExtensionsByNames(
        [],
        ['voice-synthesis'], // Not available
        []
      );

      // Should skip because not available
      expect(result.manifest.packs).toHaveLength(0);
      expect(result.missing).toContain('voice-synthesis');
    });

    it('should handle mixed tool/voice/productivity extensions', async () => {
      const result = await resolveExtensionsByNames(
        ['web-search'],
        ['voice-synthesis'],
        []
      );

      // Only web-search should be in packs (voice-synthesis unavailable)
      expect(result.manifest.packs).toHaveLength(1);
      expect(result.missing).toContain('voice-synthesis');
    });

    it('should return empty manifest when no extensions specified', async () => {
      const result = await resolveExtensionsByNames([], [], []);

      expect(result.manifest.packs).toEqual([]);
      expect(result.missing).toEqual([]);
      expect(result.blocked).toEqual([]);
    });

    it('should apply overrides to extensions', async () => {
      const overrides = {
        'web-search': { priority: 25, enabled: true },
      };

      const result = await resolveExtensionsByNames(
        ['web-search'],
        [],
        [],
        overrides
      );

      // Manifest should be created with overrides passed through
      expect(result.manifest.packs).toHaveLength(1);
    });

    it('should handle registry errors gracefully', async () => {
      // Mock registry to throw error
      vi.mocked(await import('@framers/agentos-extensions-registry')).getAvailableExtensions.mockRejectedValueOnce(
        new Error('Registry unavailable')
      );

      const result = await resolveExtensionsByNames(['web-search'], [], []);

      // Should return empty manifest with all extensions marked as missing
      expect(result.manifest.packs).toEqual([]);
      expect(result.missing).toContain('web-search');
    });
  });

  describe('resolvePresetExtensions', () => {
    it('should resolve extensions for research-assistant preset', async () => {
      const result = await resolvePresetExtensions('research-assistant');

      // Research assistant has web-search, web-browser, news-search
      expect(result.manifest.packs.length).toBeGreaterThan(0);
      expect(result.missing).not.toContain('web-search');
      expect(result.missing).not.toContain('web-browser');
    });

    it('should handle preset with no extensions', async () => {
      // Personal assistant might have different extensions
      const result = await resolvePresetExtensions('personal-assistant');

      expect(result.manifest).toBeDefined();
      expect(Array.isArray(result.missing)).toBe(true);
      expect(Array.isArray(result.blocked)).toBe(true);
    });

    it('should throw error for invalid preset', async () => {
      await expect(resolvePresetExtensions('nonexistent-preset')).rejects.toThrow();
    });

    it('should pass options through to resolveExtensionsByNames', async () => {
      const options = {
        secrets: { 'newsapi': 'test-key' },
        basePriority: 20,
      };

      const result = await resolvePresetExtensions('research-assistant', options);

      // Should not throw and should return valid result
      expect(result.manifest).toBeDefined();
    });
  });
});
