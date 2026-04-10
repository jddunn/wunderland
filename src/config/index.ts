// @ts-nocheck
/**
 * @fileoverview Agent configuration loading, validation, and resolution.
 *
 * Provides the full config pipeline: load from disk or object, validate against
 * the Wunderland agent-config schema, merge with presets and personas, and
 * resolve the effective runtime configuration including LLM credentials.
 *
 * @module wunderland/config
 */

// ── Config loading & LLM resolution ────────────────────────────────────────
export { loadAgentConfig, resolveLlmConfig, resolveProviderId } from './load.js';
export type { ResolvedLlmConfig } from './load.js';

// ── Schema validation ──────────────────────────────────────────────────────
export { validateWunderlandAgentConfig } from './schema.js';

// ── Error types ────────────────────────────────────────────────────────────
export { WunderlandConfigError } from './errors.js';
export type { WunderlandConfigIssue } from './errors.js';

// ── Effective agent config (preset + persona merge) ────────────────────────
export {
  resolveEffectiveAgentConfig,
  buildDiscoveryOptionsFromAgentConfig,
} from './effective-agent-config.js';
export type { EffectiveAgentConfigResult } from './effective-agent-config.js';

// ── Wallet config types (merged from wallet/) ─────────────────────────────
export * from './wallet-types.js';

// ── Persona registry ───────────────────────────────────────────────────────
export {
  resolveConfiguredPersonas,
  resolveSelectedPersonaId,
  summarizePersona,
  extractSystemPromptFromPersona,
  extractHexacoTraitsFromPersona,
  buildRagConfigFromPersona,
} from './persona-registry.js';
export type {
  ResolvedPersonaEntry,
  PersonaSummary,
  ResolvedPersonaCatalog,
} from './persona-registry.js';
