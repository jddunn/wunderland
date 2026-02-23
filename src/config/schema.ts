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
  expectString('displayName');
  expectString('bio');
  expectString('systemPrompt');
  expectString('llmProvider');
  expectString('llmModel');
  expectString('securityTier');
  expectString('permissionSet');
  expectString('toolAccessProfile');
  expectString('executionMode');
  expectBoolean('lazyTools');

  if (cfg.extensions !== undefined) {
    if (!isPlainObject(cfg.extensions)) {
      issues.push({ path: 'extensions', message: 'Expected object.' });
    } else {
      const exts = cfg.extensions as Record<string, unknown>;
      if (exts.tools !== undefined && !isStringArray(exts.tools)) {
        issues.push({ path: 'extensions.tools', message: 'Expected string[]' });
      }
      if (exts.voice !== undefined && !isStringArray(exts.voice)) {
        issues.push({ path: 'extensions.voice', message: 'Expected string[]' });
      }
      if (exts.productivity !== undefined && !isStringArray(exts.productivity)) {
        issues.push({ path: 'extensions.productivity', message: 'Expected string[]' });
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
      for (const strField of ['embeddingProvider', 'embeddingModel']) {
        if (disc[strField] !== undefined && typeof disc[strField] !== 'string') {
          issues.push({ path: `discovery.${strField}`, message: 'Expected string.' });
        }
      }
      if (disc.scanManifests !== undefined && typeof disc.scanManifests !== 'boolean') {
        issues.push({ path: 'discovery.scanManifests', message: 'Expected boolean.' });
      }
    }
  }

  return { config: input as WunderlandAgentConfig, issues };
}

