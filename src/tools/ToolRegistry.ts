/**
 * @fileoverview Wunderland Tool Registry — uses the curated extensions registry
 * to load all available tools via a single `createCuratedManifest()` call.
 *
 * Instead of manually importing and wiring each extension, this delegates to
 * `@framers/agentos-extensions-registry` which handles lazy loading, secret
 * resolution, and factory invocation for all curated tools.
 *
 * @module wunderland/tools/ToolRegistry
 */

import type { ITool } from '@framers/agentos';
import { createCuratedManifest } from '@framers/agentos-extensions-registry';

export interface ToolRegistryConfig {
  serperApiKey?: string;
  serpApiKey?: string;
  braveApiKey?: string;
  giphyApiKey?: string;
  elevenLabsApiKey?: string;
  pexelsApiKey?: string;
  unsplashApiKey?: string;
  pixabayApiKey?: string;
  newsApiKey?: string;
}

/**
 * All tool IDs that can be registered in the Wunderland system.
 */
export const WUNDERLAND_TOOL_IDS = {
  WEB_SEARCH: 'web_search',
  RESEARCH_AGGREGATE: 'research_aggregate',
  FACT_CHECK: 'fact_check',
  NEWS_SEARCH: 'news_search',
  GIPHY_SEARCH: 'giphy_search',
  IMAGE_SEARCH: 'image_search',
  TEXT_TO_SPEECH: 'text_to_speech',
  SOCIAL_POST: 'social_post',
  FEED_READ: 'feed_read',
  MEMORY_READ: 'memory_read',
} as const;

/**
 * Build a secrets map from config values and environment variables.
 * Keys match the secret IDs expected by extension `getSecret()` resolvers.
 */
function buildSecretsMap(config?: ToolRegistryConfig): Record<string, string> {
  const secrets: Record<string, string> = {};

  const add = (key: string, configValue?: string, envKey?: string) => {
    const val = configValue || (envKey ? process.env[envKey] : undefined);
    if (val) secrets[key] = val;
  };

  add('serper.apiKey', config?.serperApiKey, 'SERPER_API_KEY');
  add('serpapi.apiKey', config?.serpApiKey, 'SERPAPI_API_KEY');
  add('brave.apiKey', config?.braveApiKey, 'BRAVE_API_KEY');
  add('giphy.apiKey', config?.giphyApiKey, 'GIPHY_API_KEY');
  add('elevenlabs.apiKey', config?.elevenLabsApiKey, 'ELEVENLABS_API_KEY');
  add('pexels.apiKey', config?.pexelsApiKey, 'PEXELS_API_KEY');
  add('unsplash.apiKey', config?.unsplashApiKey, 'UNSPLASH_ACCESS_KEY');
  add('pixabay.apiKey', config?.pixabayApiKey, 'PIXABAY_API_KEY');
  add('newsapi.apiKey', config?.newsApiKey, 'NEWSAPI_API_KEY');

  return secrets;
}

/**
 * Creates all available tools via the curated extensions registry.
 * Only tools whose packages are installed will be loaded (via dynamic import).
 * API keys resolve from config → secrets map → environment variables.
 */
export async function createWunderlandTools(config?: ToolRegistryConfig): Promise<ITool[]> {
  const secrets = buildSecretsMap(config);

  const manifest = await createCuratedManifest({
    tools: 'all',
    channels: 'none',
    secrets,
  });

  const tools: ITool[] = [];
  for (const pack of manifest.packs) {
    if (!('factory' in pack) || typeof pack.factory !== 'function') continue;
    try {
      const extensionPack = await pack.factory();
      for (const descriptor of (extensionPack as any).descriptors || []) {
        if (descriptor?.kind === 'tool' && descriptor.payload) {
          tools.push(descriptor.payload);
        }
      }
    } catch {
      // Extension pack failed to initialize — skip silently
    }
  }

  return tools;
}

/**
 * Returns a map of tool name → availability status for diagnostic purposes.
 */
export function getToolAvailability(config?: ToolRegistryConfig): Record<string, { available: boolean; reason?: string }> {
  const secrets = buildSecretsMap(config);

  const hasWebKey = !!(secrets['serper.apiKey'] || secrets['serpapi.apiKey'] || secrets['brave.apiKey']);

  return {
    [WUNDERLAND_TOOL_IDS.WEB_SEARCH]: {
      available: true,
      reason: hasWebKey ? undefined : 'No web-search API keys set (Serper/SerpAPI/Brave); using DuckDuckGo fallback',
    },
    [WUNDERLAND_TOOL_IDS.RESEARCH_AGGREGATE]: {
      available: true,
      reason: hasWebKey ? undefined : 'No web-search API keys set (Serper/SerpAPI/Brave); using DuckDuckGo fallback',
    },
    [WUNDERLAND_TOOL_IDS.FACT_CHECK]: {
      available: true,
      reason: hasWebKey ? undefined : 'No web-search API keys set (Serper/SerpAPI/Brave); using DuckDuckGo fallback',
    },
    [WUNDERLAND_TOOL_IDS.NEWS_SEARCH]: {
      available: !!secrets['newsapi.apiKey'],
      reason: secrets['newsapi.apiKey'] ? undefined : 'NEWSAPI_API_KEY not set',
    },
    [WUNDERLAND_TOOL_IDS.GIPHY_SEARCH]: {
      available: !!secrets['giphy.apiKey'],
      reason: secrets['giphy.apiKey'] ? undefined : 'GIPHY_API_KEY not set',
    },
    [WUNDERLAND_TOOL_IDS.IMAGE_SEARCH]: {
      available: !!(secrets['pexels.apiKey'] || secrets['unsplash.apiKey'] || secrets['pixabay.apiKey']),
      reason: (secrets['pexels.apiKey'] || secrets['unsplash.apiKey'] || secrets['pixabay.apiKey'])
        ? undefined
        : 'No image API keys set',
    },
    [WUNDERLAND_TOOL_IDS.TEXT_TO_SPEECH]: {
      available: !!secrets['elevenlabs.apiKey'],
      reason: secrets['elevenlabs.apiKey'] ? undefined : 'ELEVENLABS_API_KEY not set',
    },
  };
}

// Re-export extension tools for convenience (individual packages remain as deps)
export { SerperSearchTool } from './SerperSearchTool.js';
export { WebSearchTool, ResearchAggregatorTool, FactCheckTool } from '@framers/agentos-ext-web-search';
export { GiphySearchTool } from '@framers/agentos-ext-giphy';
export { ImageSearchTool } from '@framers/agentos-ext-image-search';
export { TextToSpeechTool } from '@framers/agentos-ext-voice-synthesis';
export { NewsSearchTool } from '@framers/agentos-ext-news-search';
