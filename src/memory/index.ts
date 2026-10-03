/**
 * Barrel re-export for the memory module. Consumers import
 * `createMemorySystem` and friends from `wunderland/memory`.
 */

export * from './initialization/MemorySystemInitializer.js';

// The chat command and the API chat runtime import these from this barrel.
// They are named here, not star-exported, so removing one is a compile error
// in this file instead of a link-time failure in the published build.
export { injectMemoryContext, removeMemoryContext } from './retrieval/TurnMemoryRetriever.js';
export type { MessageLike } from './retrieval/TurnMemoryRetriever.js';
