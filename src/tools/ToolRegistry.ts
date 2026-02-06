/**
 * @fileoverview Wunderland Tool Registry — instantiates tools from agentos-extensions.
 *
 * This is the convenience layer that pulls ITool implementations from
 * @framers/agentos-extensions and assembles them for NewsroomAgency use.
 * Tools are created lazily based on available environment variables / API keys.
 *
 * @module @framers/wunderland/tools/ToolRegistry
 */

import type { ITool } from '../../../agentos/src/core/tools/ITool.js';

// Import tool implementations from agentos-extensions (canonical source)
import { GiphySearchTool } from '../../../agentos-extensions/registry/curated/media/giphy/src/tools/giphySearch.js';
import { ImageSearchTool } from '../../../agentos-extensions/registry/curated/media/image-search/src/tools/imageSearch.js';
import { TextToSpeechTool } from '../../../agentos-extensions/registry/curated/media/voice-synthesis/src/tools/textToSpeech.js';
import { NewsSearchTool } from '../../../agentos-extensions/registry/curated/research/news-search/src/tools/newsSearch.js';

// SerperSearchTool stays local — the existing web-search extension has its own
// multi-provider SearchProviderService; our Serper tool is a simpler direct integration
import { SerperSearchTool } from './SerperSearchTool.js';

export interface ToolRegistryConfig {
  serperApiKey?: string;
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
  NEWS_SEARCH: 'news_search',
  GIPHY_SEARCH: 'giphy_search',
  IMAGE_SEARCH: 'image_search',
  TEXT_TO_SPEECH: 'text_to_speech',
  SOCIAL_POST: 'social_post',
  FEED_READ: 'feed_read',
  MEMORY_READ: 'memory_read',
} as const;

/**
 * Creates all available tools based on provided or environment API keys.
 * Only creates tools for which API keys are available.
 *
 * Tools are sourced from @framers/agentos-extensions where possible.
 */
export function createWunderlandTools(config?: ToolRegistryConfig): ITool[] {
  const tools: ITool[] = [];

  // Serper Web Search (local — simple direct Serper integration)
  const serperKey = config?.serperApiKey || process.env.SERPER_API_KEY;
  if (serperKey) {
    tools.push(new SerperSearchTool(serperKey));
  }

  // News Search (from agentos-extensions/research/news-search)
  const newsKey = config?.newsApiKey || process.env.NEWSAPI_API_KEY;
  if (newsKey) {
    tools.push(new NewsSearchTool(newsKey));
  }

  // Giphy (from agentos-extensions/media/giphy)
  const giphyKey = config?.giphyApiKey || process.env.GIPHY_API_KEY;
  if (giphyKey) {
    tools.push(new GiphySearchTool(giphyKey));
  }

  // Media Search (from agentos-extensions/media/image-search)
  const pexelsKey = config?.pexelsApiKey || process.env.PEXELS_API_KEY;
  const unsplashKey = config?.unsplashApiKey || process.env.UNSPLASH_ACCESS_KEY;
  const pixabayKey = config?.pixabayApiKey || process.env.PIXABAY_API_KEY;
  if (pexelsKey || unsplashKey || pixabayKey) {
    tools.push(new ImageSearchTool({ pexels: pexelsKey, unsplash: unsplashKey, pixabay: pixabayKey }));
  }

  // ElevenLabs TTS (from agentos-extensions/media/voice-synthesis)
  const elevenLabsKey = config?.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY;
  if (elevenLabsKey) {
    tools.push(new TextToSpeechTool(elevenLabsKey));
  }

  return tools;
}

/**
 * Returns a map of tool name → availability status for diagnostic purposes.
 */
export function getToolAvailability(config?: ToolRegistryConfig): Record<string, { available: boolean; reason?: string }> {
  return {
    [WUNDERLAND_TOOL_IDS.WEB_SEARCH]: {
      available: !!(config?.serperApiKey || process.env.SERPER_API_KEY),
      reason: config?.serperApiKey || process.env.SERPER_API_KEY ? undefined : 'SERPER_API_KEY not set',
    },
    [WUNDERLAND_TOOL_IDS.NEWS_SEARCH]: {
      available: !!(config?.newsApiKey || process.env.NEWSAPI_API_KEY),
      reason: config?.newsApiKey || process.env.NEWSAPI_API_KEY ? undefined : 'NEWSAPI_API_KEY not set',
    },
    [WUNDERLAND_TOOL_IDS.GIPHY_SEARCH]: {
      available: !!(config?.giphyApiKey || process.env.GIPHY_API_KEY),
      reason: config?.giphyApiKey || process.env.GIPHY_API_KEY ? undefined : 'GIPHY_API_KEY not set',
    },
    [WUNDERLAND_TOOL_IDS.IMAGE_SEARCH]: {
      available: !!(config?.pexelsApiKey || process.env.PEXELS_API_KEY ||
        config?.unsplashApiKey || process.env.UNSPLASH_ACCESS_KEY ||
        config?.pixabayApiKey || process.env.PIXABAY_API_KEY),
      reason: (config?.pexelsApiKey || process.env.PEXELS_API_KEY ||
        config?.unsplashApiKey || process.env.UNSPLASH_ACCESS_KEY ||
        config?.pixabayApiKey || process.env.PIXABAY_API_KEY) ? undefined : 'No image API keys set',
    },
    [WUNDERLAND_TOOL_IDS.TEXT_TO_SPEECH]: {
      available: !!(config?.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY),
      reason: config?.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY ? undefined : 'ELEVENLABS_API_KEY not set',
    },
  };
}

// Re-export extension tools for convenience
export { SerperSearchTool } from './SerperSearchTool.js';
export { GiphySearchTool } from '../../../agentos-extensions/registry/curated/media/giphy/src/tools/giphySearch.js';
export { ImageSearchTool } from '../../../agentos-extensions/registry/curated/media/image-search/src/tools/imageSearch.js';
export { TextToSpeechTool } from '../../../agentos-extensions/registry/curated/media/voice-synthesis/src/tools/textToSpeech.js';
export { NewsSearchTool } from '../../../agentos-extensions/registry/curated/research/news-search/src/tools/newsSearch.js';
