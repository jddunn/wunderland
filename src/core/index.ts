/**
 * Canonical top-level barrel for the wunderland "core" surface that
 * predates the themed-group refactor. Consumers reach this via
 * `wunderland/core` to pick up seed factories + the security/inference
 * defaults that were collapsed into `wunderland/types/core-types`.
 */

export * from '../types/core-types.js';
export * from '../agents/builder/WunderlandSeed.js';
