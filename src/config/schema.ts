import type { WunderlandAgentConfig } from '../api/types.js';
import type { WunderlandConfigIssue } from './errors.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function validateWunderlandAgentConfig(input: unknown): { config: WunderlandAgentConfig; issues: WunderlandConfigIssue[] } {
  const issues: WunderlandConfigIssue[] = [];
  if (!isPlainObject(input)) {
    issues.push({ path: '', message: 'Config must be a JSON object.' });
    return { config: {}, issues };
  }

  const cfg = input as Record<string, unknown>;

  const expectString = (key: string) => {
    if (cfg[key] === undefined) return;
    if (typeof cfg[key] !== 'string') {
      issues.push({ path: key, message: `Expected string (got ${typeof cfg[key]}).` });
    }
  };

  const expectBoolean = (key: string) => {
    if (cfg[key] === undefined) return;
    if (typeof cfg[key] !== 'boolean') {
      issues.push({ path: key, message: `Expected boolean (got ${typeof cfg[key]}).` });
    }
  };

  expectString('seedId');
  expectString('presetId');
  expectString('displayName');
  expectString('bio');
  expectString('systemPrompt');
  expectString('selectedPersonaId');
  expectString('llmProvider');
  expectString('llmModel');
  expectString('toolFailureMode');
  expectString('securityTier');
  expectString('permissionSet');
  expectString('toolAccessProfile');
  expectString('executionMode');
  expectBoolean('lazyTools');
  if (cfg.skills !== undefined && !isStringArray(cfg.skills)) {
    issues.push({ path: 'skills', message: 'Expected string[]' });
  }

  if (typeof cfg.toolFailureMode === 'string') {
    const m = cfg.toolFailureMode.trim().toLowerCase();
    if (m !== 'fail_open' && m !== 'fail_closed') {
      issues.push({ path: 'toolFailureMode', message: 'Expected "fail_open" or "fail_closed".' });
    }
  }

  if (cfg.toolCalling !== undefined) {
    if (!isPlainObject(cfg.toolCalling)) {
      issues.push({ path: 'toolCalling', message: 'Expected object.' });
    } else {
      const toolCalling = cfg.toolCalling as Record<string, unknown>;
      if (toolCalling.strictToolNames !== undefined && typeof toolCalling.strictToolNames !== 'boolean') {
        issues.push({ path: 'toolCalling.strictToolNames', message: 'Expected boolean.' });
      }
    }
  }

  if (cfg.extensions !== undefined) {
    if (!isPlainObject(cfg.extensions)) {
      issues.push({ path: 'extensions', message: 'Expected object.' });
    } else {
      const exts = cfg.extensions as Record<string, unknown>;
      for (const [key, value] of Object.entries(exts)) {
        if (value !== undefined && !isStringArray(value)) {
          issues.push({ path: `extensions.${key}`, message: 'Expected string[]' });
        }
      }
    }
  }

  if (cfg.ollama !== undefined) {
    if (!isPlainObject(cfg.ollama)) {
      issues.push({ path: 'ollama', message: 'Expected object.' });
    } else {
      const ollama = cfg.ollama as Record<string, unknown>;
      if (ollama.baseUrl !== undefined && typeof ollama.baseUrl !== 'string') {
        issues.push({ path: 'ollama.baseUrl', message: 'Expected string.' });
      }
      for (const numField of ['numCtx', 'numGpu']) {
        if (ollama[numField] !== undefined && typeof ollama[numField] !== 'number') {
          issues.push({ path: `ollama.${numField}`, message: 'Expected number.' });
        }
      }
    }
  }

  if (cfg.secrets !== undefined) {
    if (!isPlainObject(cfg.secrets)) {
      issues.push({ path: 'secrets', message: 'Expected object mapping string -> string.' });
    } else {
      for (const [k, v] of Object.entries(cfg.secrets as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          issues.push({ path: `secrets.${k}`, message: `Expected string (got ${typeof v}).` });
        }
      }
    }
  }

  if (cfg.storage !== undefined) {
    if (!isPlainObject(cfg.storage)) {
      issues.push({ path: 'storage', message: 'Expected object.' });
    } else {
      const st = cfg.storage as Record<string, unknown>;
      if (st.backend !== undefined && st.backend !== 'local' && st.backend !== 'cloud') {
        issues.push({ path: 'storage.backend', message: 'Expected "local" or "cloud".' });
      }
      if (st.dbPath !== undefined && typeof st.dbPath !== 'string') {
        issues.push({ path: 'storage.dbPath', message: 'Expected string.' });
      }
      if (st.connectionString !== undefined && typeof st.connectionString !== 'string') {
        issues.push({ path: 'storage.connectionString', message: 'Expected string.' });
      }
      if (st.autoIngest !== undefined) {
        if (!isPlainObject(st.autoIngest)) {
          issues.push({ path: 'storage.autoIngest', message: 'Expected object.' });
        } else {
          const ai = st.autoIngest as Record<string, unknown>;
          if (ai.enabled !== undefined && typeof ai.enabled !== 'boolean') {
            issues.push({ path: 'storage.autoIngest.enabled', message: 'Expected boolean.' });
          }
          if (ai.importanceThreshold !== undefined && typeof ai.importanceThreshold !== 'number') {
            issues.push({ path: 'storage.autoIngest.importanceThreshold', message: 'Expected number.' });
          }
          if (ai.maxPerTurn !== undefined && typeof ai.maxPerTurn !== 'number') {
            issues.push({ path: 'storage.autoIngest.maxPerTurn', message: 'Expected number.' });
          }
        }
      }
    }
  }

  if (cfg.discovery !== undefined) {
    if (!isPlainObject(cfg.discovery)) {
      issues.push({ path: 'discovery', message: 'Expected object.' });
    } else {
      const disc = cfg.discovery as Record<string, unknown>;
      if (disc.enabled !== undefined && typeof disc.enabled !== 'boolean') {
        issues.push({ path: 'discovery.enabled', message: 'Expected boolean.' });
      }
      for (const numField of ['tier0Budget', 'tier1Budget', 'tier2Budget', 'tier1TopK', 'tier2TopK']) {
        if (disc[numField] !== undefined && typeof disc[numField] !== 'number') {
          issues.push({ path: `discovery.${numField}`, message: 'Expected number.' });
        }
      }
      for (const numField of ['tier1MinRelevance', 'graphBoostFactor']) {
        if (disc[numField] !== undefined && typeof disc[numField] !== 'number') {
          issues.push({ path: `discovery.${numField}`, message: 'Expected number.' });
        }
      }
      for (const strField of ['embeddingProvider', 'embeddingModel']) {
        if (disc[strField] !== undefined && typeof disc[strField] !== 'string') {
          issues.push({ path: `discovery.${strField}`, message: 'Expected string.' });
        }
      }
      if (disc.recallProfile !== undefined) {
        if (
          typeof disc.recallProfile !== 'string'
          || !['aggressive', 'balanced', 'precision'].includes(disc.recallProfile)
        ) {
          issues.push({
            path: 'discovery.recallProfile',
            message: 'Expected "aggressive", "balanced", or "precision".',
          });
        }
      }
      if (disc.scanManifests !== undefined && typeof disc.scanManifests !== 'boolean') {
        issues.push({ path: 'discovery.scanManifests', message: 'Expected boolean.' });
      }
      if (disc.config !== undefined && !isPlainObject(disc.config)) {
        issues.push({ path: 'discovery.config', message: 'Expected object.' });
      }
    }
  }

  if (cfg.rag !== undefined) {
    if (!isPlainObject(cfg.rag)) {
      issues.push({ path: 'rag', message: 'Expected object.' });
    } else {
      const rag = cfg.rag as Record<string, unknown>;
      for (const boolField of [
        'enabled',
        'includeGraphRag',
        'includeAudit',
        'includeDebug',
        'includeMetadata',
        'exposeMemoryRead',
        'exposeRagQuery',
      ]) {
        if (rag[boolField] !== undefined && typeof rag[boolField] !== 'boolean') {
          issues.push({ path: `rag.${boolField}`, message: 'Expected boolean.' });
        }
      }
      for (const strField of ['backendUrl', 'authToken', 'authTokenEnvVar', 'defaultCollectionId']) {
        if (rag[strField] !== undefined && typeof rag[strField] !== 'string') {
          issues.push({ path: `rag.${strField}`, message: 'Expected string.' });
        }
      }
      for (const numField of ['defaultTopK', 'similarityThreshold']) {
        if (rag[numField] !== undefined && typeof rag[numField] !== 'number') {
          issues.push({ path: `rag.${numField}`, message: 'Expected number.' });
        }
      }
      if (rag.collectionIds !== undefined && !isStringArray(rag.collectionIds)) {
        issues.push({ path: 'rag.collectionIds', message: 'Expected string[]' });
      }
      if (rag.queryVariants !== undefined && !isStringArray(rag.queryVariants)) {
        issues.push({ path: 'rag.queryVariants', message: 'Expected string[]' });
      }
      if (rag.preset !== undefined) {
        if (
          typeof rag.preset !== 'string'
          || !['fast', 'balanced', 'accurate'].includes(rag.preset)
        ) {
          issues.push({ path: 'rag.preset', message: 'Expected "fast", "balanced", or "accurate".' });
        }
      }
      if (rag.strategy !== undefined) {
        if (
          typeof rag.strategy !== 'string'
          || !['similarity', 'mmr', 'hybrid_search'].includes(rag.strategy)
        ) {
          issues.push({ path: 'rag.strategy', message: 'Expected "similarity", "mmr", or "hybrid_search".' });
        }
      }
      if (rag.filters !== undefined && !isPlainObject(rag.filters)) {
        issues.push({ path: 'rag.filters', message: 'Expected object.' });
      }
      if (rag.strategyParams !== undefined) {
        if (!isPlainObject(rag.strategyParams)) {
          issues.push({ path: 'rag.strategyParams', message: 'Expected object.' });
        } else {
          const params = rag.strategyParams as Record<string, unknown>;
          for (const numField of ['mmrLambda', 'mmrCandidateMultiplier']) {
            if (params[numField] !== undefined && typeof params[numField] !== 'number') {
              issues.push({ path: `rag.strategyParams.${numField}`, message: 'Expected number.' });
            }
          }
        }
      }
      if (rag.rewrite !== undefined) {
        if (!isPlainObject(rag.rewrite)) {
          issues.push({ path: 'rag.rewrite', message: 'Expected object.' });
        } else {
          const rewrite = rag.rewrite as Record<string, unknown>;
          if (rewrite.enabled !== undefined && typeof rewrite.enabled !== 'boolean') {
            issues.push({ path: 'rag.rewrite.enabled', message: 'Expected boolean.' });
          }
          if (rewrite.maxVariants !== undefined && typeof rewrite.maxVariants !== 'number') {
            issues.push({ path: 'rag.rewrite.maxVariants', message: 'Expected number.' });
          }
        }
      }
      if (rag.hyde !== undefined) {
        if (!isPlainObject(rag.hyde)) {
          issues.push({ path: 'rag.hyde', message: 'Expected object.' });
        } else {
          const hyde = rag.hyde as Record<string, unknown>;
          for (const boolField of ['enabled', 'adaptiveThreshold', 'fullAnswerGranularity']) {
            if (hyde[boolField] !== undefined && typeof hyde[boolField] !== 'boolean') {
              issues.push({ path: `rag.hyde.${boolField}`, message: 'Expected boolean.' });
            }
          }
          for (const numField of [
            'initialThreshold',
            'minThreshold',
            'thresholdStep',
            'maxHypothesisTokens',
          ]) {
            if (hyde[numField] !== undefined && typeof hyde[numField] !== 'number') {
              issues.push({ path: `rag.hyde.${numField}`, message: 'Expected number.' });
            }
          }
          if (
            hyde.hypothesisSystemPrompt !== undefined &&
            typeof hyde.hypothesisSystemPrompt !== 'string'
          ) {
            issues.push({
              path: 'rag.hyde.hypothesisSystemPrompt',
              message: 'Expected string.',
            });
          }
        }
      }
    }
  }

  if (cfg.personaRegistry !== undefined) {
    if (!isPlainObject(cfg.personaRegistry)) {
      issues.push({ path: 'personaRegistry', message: 'Expected object.' });
    } else {
      const registry = cfg.personaRegistry as Record<string, unknown>;
      for (const boolField of ['enabled', 'includeBuiltIns', 'recursive']) {
        if (registry[boolField] !== undefined && typeof registry[boolField] !== 'boolean') {
          issues.push({ path: `personaRegistry.${boolField}`, message: 'Expected boolean.' });
        }
      }
      for (const strField of ['fileExtension', 'selectedPersonaId']) {
        if (registry[strField] !== undefined && typeof registry[strField] !== 'string') {
          issues.push({ path: `personaRegistry.${strField}`, message: 'Expected string.' });
        }
      }
      if (registry.paths !== undefined && !isStringArray(registry.paths)) {
        issues.push({ path: 'personaRegistry.paths', message: 'Expected string[]' });
      }
    }
  }

  if (cfg.taskOutcomeTelemetry !== undefined) {
    if (!isPlainObject(cfg.taskOutcomeTelemetry)) {
      issues.push({ path: 'taskOutcomeTelemetry', message: 'Expected object.' });
    } else {
      const t = cfg.taskOutcomeTelemetry as Record<string, unknown>;
      for (const boolField of ['enabled', 'persist', 'emitAlerts']) {
        if (t[boolField] !== undefined && typeof t[boolField] !== 'boolean') {
          issues.push({ path: `taskOutcomeTelemetry.${boolField}`, message: 'Expected boolean.' });
        }
      }
      for (const numField of [
        'rollingWindowSize',
        'alertBelowWeightedSuccessRate',
        'alertMinSamples',
        'alertCooldownMs',
      ]) {
        if (t[numField] !== undefined && typeof t[numField] !== 'number') {
          issues.push({ path: `taskOutcomeTelemetry.${numField}`, message: 'Expected number.' });
        }
      }
      for (const strField of ['scope', 'tableName']) {
        if (t[strField] !== undefined && typeof t[strField] !== 'string') {
          issues.push({ path: `taskOutcomeTelemetry.${strField}`, message: 'Expected string.' });
        }
      }
      if (t.storage !== undefined && !isPlainObject(t.storage)) {
        issues.push({ path: 'taskOutcomeTelemetry.storage', message: 'Expected object.' });
      }
    }
  }

  if (cfg.adaptiveExecution !== undefined) {
    if (!isPlainObject(cfg.adaptiveExecution)) {
      issues.push({ path: 'adaptiveExecution', message: 'Expected object.' });
    } else {
      const a = cfg.adaptiveExecution as Record<string, unknown>;
      for (const boolField of ['enabled', 'forceAllToolsWhenDegraded', 'forceFailOpenWhenDegraded']) {
        if (a[boolField] !== undefined && typeof a[boolField] !== 'boolean') {
          issues.push({ path: `adaptiveExecution.${boolField}`, message: 'Expected boolean.' });
        }
      }
      for (const numField of ['minSamples', 'minWeightedSuccessRate']) {
        if (a[numField] !== undefined && typeof a[numField] !== 'number') {
          issues.push({ path: `adaptiveExecution.${numField}`, message: 'Expected number.' });
        }
      }
    }
  }

  return { config: input as WunderlandAgentConfig, issues };
}
