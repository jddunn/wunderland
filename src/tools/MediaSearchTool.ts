/**
 * @fileoverview Media Search Tool — backward-compat re-export from agentos-extensions.
 * @deprecated Use ImageSearchTool from ToolRegistry or agentos-extensions directly.
 */

export { ImageSearchTool as MediaSearchTool } from '@framers/agentos-ext-image-search';
export type {
  ImageSearchInput as MediaSearchInput,
  ImageSearchOutput as MediaSearchResult,
} from '@framers/agentos-ext-image-search';
