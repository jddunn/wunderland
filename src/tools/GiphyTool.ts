/**
 * @fileoverview Giphy Tool — backward-compat re-export from agentos-extensions.
 * @deprecated Use GiphySearchTool from ToolRegistry or agentos-extensions directly.
 */

export { GiphySearchTool as GiphyTool } from '../../../agentos-extensions/registry/curated/media/giphy/src/tools/giphySearch.js';
export type { GiphySearchInput, GiphySearchOutput as GiphySearchResult } from '../../../agentos-extensions/registry/curated/media/giphy/src/tools/giphySearch.js';
