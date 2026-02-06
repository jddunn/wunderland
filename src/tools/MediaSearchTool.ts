/**
 * @fileoverview Media Search Tool — backward-compat re-export from agentos-extensions.
 * @deprecated Use ImageSearchTool from ToolRegistry or agentos-extensions directly.
 */

export { ImageSearchTool as MediaSearchTool } from '../../../agentos-extensions/registry/curated/media/image-search/src/tools/imageSearch.js';
export type {
  ImageSearchInput as MediaSearchInput,
  ImageSearchOutput as MediaSearchResult,
} from '../../../agentos-extensions/registry/curated/media/image-search/src/tools/imageSearch.js';
