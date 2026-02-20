/**
 * @fileoverview Config Validator — JSON Schema validation for agent.config.json
 * @module wunderland/cli/config/config-validator
 *
 * Provides early validation of agent configuration files with clear,
 * actionable error messages. Supports config version migration.
 */

// ============================================================================
// Types
// ============================================================================

export interface ValidationError {
  /** Dot-path to the problematic field (e.g. "inferenceHierarchy.primaryModel.modelId"). */
  path: string;
  /** Human-readable error message. */
  message: string;
  /** Severity: 'error' must be fixed, 'warning' is advisory. */
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  /** Config version detected. */
  configVersion: string;
  /** Whether a migration is available. */
  migrationAvailable: boolean;
}

// ============================================================================
// Known provider/model values for validation hints
// ============================================================================

const KNOWN_PROVIDERS = new Set([
  'openai', 'anthropic', 'ollama', 'openrouter', 'bedrock',
  'gemini', 'github-copilot', 'minimax', 'qwen', 'moonshot',
  'venice', 'cloudflare-ai', 'xiaomi-mimo', 'nvidia', 'glm',
  'xai', 'deepseek', 'groq', 'together', 'fireworks',
  'perplexity', 'mistral', 'cohere',
]);

const KNOWN_SECURITY_TIERS = new Set([
  'dangerous', 'permissive', 'balanced', 'strict', 'paranoid',
]);

const KNOWN_TOOL_PROFILES = new Set([
  'social-citizen', 'social-observer', 'social-creative', 'assistant', 'unrestricted',
]);

// ============================================================================
// ConfigValidator
// ============================================================================

/**
 * Validates agent.config.json structure and values.
 *
 * @example
 * ```typescript
 * const validator = new ConfigValidator();
 * const result = validator.validate(configObject);
 * if (!result.valid) {
 *   for (const err of result.errors) {
 *     console.error(`${err.path}: ${err.message}`);
 *   }
 * }
 * ```
 */
export class ConfigValidator {
  /** Current config schema version. */
  static readonly CURRENT_VERSION = '2.0';

  validate(config: unknown): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];

    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      errors.push({ path: '', message: 'Config must be a JSON object.', severity: 'error' });
      return { valid: false, errors, warnings, configVersion: 'unknown', migrationAvailable: false };
    }

    const obj = config as Record<string, unknown>;
    const version = typeof obj.version === 'string' ? obj.version : '1.0';
    const migrationAvailable = version !== ConfigValidator.CURRENT_VERSION;

    // Required fields
    this.requireString(obj, 'seedId', errors);
    this.requireString(obj, 'name', errors);

    // HEXACO traits
    if (obj.hexacoTraits !== undefined) {
      this.validateHexaco(obj.hexacoTraits, errors, warnings);
    }

    // Security profile
    if (obj.securityProfile !== undefined) {
      this.validateSecurityProfile(obj.securityProfile, errors, warnings);
    }

    // Security tier
    if (obj.securityTier !== undefined) {
      if (typeof obj.securityTier !== 'string' || !KNOWN_SECURITY_TIERS.has(obj.securityTier)) {
        warnings.push({
          path: 'securityTier',
          message: `Unknown security tier "${obj.securityTier}". Known: ${[...KNOWN_SECURITY_TIERS].join(', ')}`,
          severity: 'warning',
        });
      }
    }

    // Inference hierarchy
    if (obj.inferenceHierarchy !== undefined) {
      this.validateInferenceHierarchy(obj.inferenceHierarchy, errors, warnings);
    }

    // Tool access profile
    if (obj.toolAccessProfile !== undefined) {
      if (typeof obj.toolAccessProfile !== 'string' || !KNOWN_TOOL_PROFILES.has(obj.toolAccessProfile)) {
        warnings.push({
          path: 'toolAccessProfile',
          message: `Unknown tool access profile "${obj.toolAccessProfile}". Known: ${[...KNOWN_TOOL_PROFILES].join(', ')}`,
          severity: 'warning',
        });
      }
    }

    // Channel bindings
    if (obj.channelBindings !== undefined) {
      this.validateChannelBindings(obj.channelBindings, errors, warnings);
    }

    // Version migration hint
    if (migrationAvailable) {
      warnings.push({
        path: 'version',
        message: `Config version "${version}" is outdated. Current version is "${ConfigValidator.CURRENT_VERSION}". Run \`wunderland migrate-config\` to upgrade.`,
        severity: 'warning',
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      configVersion: version,
      migrationAvailable,
    };
  }

  // --------------------------------------------------------------------------
  // Sub-validators
  // --------------------------------------------------------------------------

  private requireString(obj: Record<string, unknown>, key: string, errors: ValidationError[]): void {
    if (typeof obj[key] !== 'string' || !(obj[key] as string).trim()) {
      errors.push({ path: key, message: `"${key}" is required and must be a non-empty string.`, severity: 'error' });
    }
  }

  private validateHexaco(traits: unknown, errors: ValidationError[], _warnings: ValidationError[]): void {
    if (typeof traits !== 'object' || traits === null) {
      errors.push({ path: 'hexacoTraits', message: 'hexacoTraits must be an object.', severity: 'error' });
      return;
    }

    const t = traits as Record<string, unknown>;
    const required = ['honesty_humility', 'emotionality', 'extraversion', 'agreeableness', 'conscientiousness', 'openness'];

    for (const key of required) {
      const val = t[key];
      if (val === undefined) continue; // Optional; defaults will be used
      if (typeof val !== 'number') {
        errors.push({ path: `hexacoTraits.${key}`, message: `Must be a number (got ${typeof val}).`, severity: 'error' });
      } else if (val < 0 || val > 1) {
        errors.push({ path: `hexacoTraits.${key}`, message: `Must be between 0.0 and 1.0 (got ${val}).`, severity: 'error' });
      }
    }
  }

  private validateSecurityProfile(profile: unknown, errors: ValidationError[], _warnings: ValidationError[]): void {
    if (typeof profile !== 'object' || profile === null) {
      errors.push({ path: 'securityProfile', message: 'securityProfile must be an object.', severity: 'error' });
      return;
    }

    const p = profile as Record<string, unknown>;
    const boolFields = ['enablePreLLMClassifier', 'enableDualLLMAuditor', 'enableOutputSigning'];
    for (const field of boolFields) {
      if (p[field] !== undefined && typeof p[field] !== 'boolean') {
        errors.push({ path: `securityProfile.${field}`, message: `Must be a boolean (got ${typeof p[field]}).`, severity: 'error' });
      }
    }

    if (p.riskThreshold !== undefined) {
      if (typeof p.riskThreshold !== 'number' || p.riskThreshold < 0 || p.riskThreshold > 1) {
        errors.push({ path: 'securityProfile.riskThreshold', message: 'Must be a number between 0.0 and 1.0.', severity: 'error' });
      }
    }
  }

  private validateInferenceHierarchy(hierarchy: unknown, errors: ValidationError[], warnings: ValidationError[]): void {
    if (typeof hierarchy !== 'object' || hierarchy === null) {
      errors.push({ path: 'inferenceHierarchy', message: 'inferenceHierarchy must be an object.', severity: 'error' });
      return;
    }

    const h = hierarchy as Record<string, unknown>;
    const models = ['routerModel', 'primaryModel', 'auditorModel'];

    for (const modelKey of models) {
      const model = h[modelKey];
      if (!model) continue;

      if (typeof model !== 'object' || model === null) {
        errors.push({ path: `inferenceHierarchy.${modelKey}`, message: 'Must be an object with providerId and modelId.', severity: 'error' });
        continue;
      }

      const m = model as Record<string, unknown>;

      if (typeof m.providerId !== 'string' || !m.providerId) {
        errors.push({ path: `inferenceHierarchy.${modelKey}.providerId`, message: 'providerId is required.', severity: 'error' });
      } else if (!KNOWN_PROVIDERS.has(m.providerId)) {
        warnings.push({
          path: `inferenceHierarchy.${modelKey}.providerId`,
          message: `Unknown provider "${m.providerId}". This may work if you have a custom provider configured.`,
          severity: 'warning',
        });
      }

      if (typeof m.modelId !== 'string' || !m.modelId) {
        errors.push({ path: `inferenceHierarchy.${modelKey}.modelId`, message: 'modelId is required.', severity: 'error' });
      }

      if (m.temperature !== undefined && (typeof m.temperature !== 'number' || m.temperature < 0 || m.temperature > 2)) {
        errors.push({ path: `inferenceHierarchy.${modelKey}.temperature`, message: 'Must be a number between 0.0 and 2.0.', severity: 'error' });
      }

      if (m.maxTokens !== undefined && (typeof m.maxTokens !== 'number' || m.maxTokens < 1)) {
        errors.push({ path: `inferenceHierarchy.${modelKey}.maxTokens`, message: 'Must be a positive integer.', severity: 'error' });
      }
    }
  }

  private validateChannelBindings(bindings: unknown, errors: ValidationError[], _warnings: ValidationError[]): void {
    if (!Array.isArray(bindings)) {
      errors.push({ path: 'channelBindings', message: 'channelBindings must be an array.', severity: 'error' });
      return;
    }

    for (let i = 0; i < bindings.length; i++) {
      const b = bindings[i];
      if (typeof b !== 'object' || b === null) {
        errors.push({ path: `channelBindings[${i}]`, message: 'Each binding must be an object.', severity: 'error' });
        continue;
      }

      const binding = b as Record<string, unknown>;
      if (typeof binding.platform !== 'string' || !binding.platform) {
        errors.push({ path: `channelBindings[${i}].platform`, message: 'platform is required.', severity: 'error' });
      }
      if (typeof binding.channelId !== 'string' || !binding.channelId) {
        errors.push({ path: `channelBindings[${i}].channelId`, message: 'channelId is required.', severity: 'error' });
      }
    }
  }
}

// ============================================================================
// Config Migration
// ============================================================================

/**
 * Migrates agent.config.json from older versions to the current schema.
 */
export function migrateConfig(config: Record<string, unknown>): Record<string, unknown> {
  const version = typeof config.version === 'string' ? config.version : '1.0';
  let migrated = { ...config };

  // v1.0 → v2.0 migrations
  if (version === '1.0') {
    // Rename old field names
    if ('personality' in migrated && !('hexacoTraits' in migrated)) {
      migrated.hexacoTraits = migrated.personality;
      delete migrated.personality;
    }

    // Move flat provider/model to inference hierarchy
    if ('provider' in migrated && 'model' in migrated && !('inferenceHierarchy' in migrated)) {
      migrated.inferenceHierarchy = {
        routerModel: { providerId: migrated.provider, modelId: migrated.model, role: 'router' },
        primaryModel: { providerId: migrated.provider, modelId: migrated.model, role: 'primary' },
        auditorModel: { providerId: migrated.provider, modelId: migrated.model, role: 'auditor' },
      };
      delete migrated.provider;
      delete migrated.model;
    }

    migrated.version = '2.0';
  }

  return migrated;
}
