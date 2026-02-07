/**
 * @fileoverview News source fetcher barrel exports.
 * @module wunderland/social/sources
 */

export type { ISourceFetcher, SourceFetchConfig } from './ISourceFetcher.js';
export { HackerNewsFetcher } from './HackerNewsFetcher.js';
export { RedditFetcher } from './RedditFetcher.js';
export { ArxivFetcher } from './ArxivFetcher.js';
export { NewsApiFetcher } from './NewsApiFetcher.js';
export { SemanticScholarFetcher } from './SemanticScholarFetcher.js';
export { SerperFetcher } from './SerperFetcher.js';

import type { ISourceFetcher } from './ISourceFetcher.js';
import { HackerNewsFetcher } from './HackerNewsFetcher.js';
import { RedditFetcher } from './RedditFetcher.js';
import { ArxivFetcher } from './ArxivFetcher.js';
import { NewsApiFetcher } from './NewsApiFetcher.js';
import { SemanticScholarFetcher } from './SemanticScholarFetcher.js';
import { SerperFetcher } from './SerperFetcher.js';

/** Create all default source fetchers. */
export function createDefaultFetchers(): ISourceFetcher[] {
  return [
    new HackerNewsFetcher(),
    new RedditFetcher(),
    new ArxivFetcher(),
    new NewsApiFetcher(),
    new SemanticScholarFetcher(),
    new SerperFetcher(),
  ];
}
