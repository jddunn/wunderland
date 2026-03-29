/**
 * @file agentos-runtime.ts
 * @description Thin adapter around the public AgentOS orchestration runtime kernel.
 *
 * Keeping this import boundary local lets Wunderland tests substitute workspace source
 * without forcing Vitest to resolve the full published AgentOS package graph.
 */

export * from '@framers/agentos/orchestration/runtime-kernel';
