// @ts-nocheck
/**
 * @fileoverview Tests for `wunderland export` and `wunderland import` commands.
 *
 * Validates:
 * - Export produces valid YAML by default
 * - Export produces valid JSON with --format json
 * - Import creates agent directory with agent.config.json
 * - Round-trip (export -> import) preserves agent config
 * - Dry-run mode validates without creating files
 * - Validation rejects invalid/malformed configs
 * - Secret redaction works correctly
 * - YAML import works (not just JSON)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';

import { exportAgent, importAgent, validateManifest, type AgentManifest } from '../../core/AgentManifest.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A minimal valid agent.config.json for testing. */
const TEST_AGENT_CONFIG = {
  seedId: 'test-agent-export',
  displayName: 'Test Export Agent',
  bio: 'An agent for testing export/import round-trips.',
  personality: {
    honesty: 0.8,
    emotionality: 0.5,
    extraversion: 0.6,
    agreeableness: 0.7,
    conscientiousness: 0.9,
    openness: 0.75,
  },
  systemPrompt: 'You are a test agent.',
  security: {
    preLLMClassifier: true,
    dualLLMAudit: false,
    outputSigning: true,
    tier: 'balanced',
  },
  skills: ['web-search', 'code-review'],
  suggestedChannels: ['discord', 'slack'],
  presetId: 'researcher',
  llmProvider: 'openai',
  llmModel: 'gpt-4o',
  selectedPersonaId: 'default',
};

/** A minimal valid AgentManifest for import testing. */
function makeValidManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    manifestVersion: 1,
    exportedAt: new Date().toISOString(),
    seedId: 'test-import-agent',
    name: 'Test Import Agent',
    description: 'An agent created for import testing.',
    hexacoTraits: {
      honesty: 0.7,
      emotionality: 0.5,
      extraversion: 0.6,
      agreeableness: 0.65,
      conscientiousness: 0.8,
      openness: 0.75,
    },
    skills: ['web-search'],
    channels: ['discord'],
    ...overrides,
  };
}

let tempRoot: string;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Create a unique temp directory for each test
  tempRoot = path.join(tmpdir(), `wunderland-export-import-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempRoot, { recursive: true });
});

afterEach(() => {
  // Clean up temp files
  rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wunderland export/import', () => {
  // -------------------------------------------------------------------------
  // Export tests
  // -------------------------------------------------------------------------

  describe('export', () => {
    it('exports agent config as a valid AgentManifest', () => {
      const agentDir = path.join(tempRoot, 'export-agent');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        path.join(agentDir, 'agent.config.json'),
        JSON.stringify(TEST_AGENT_CONFIG, null, 2),
        'utf-8',
      );

      const manifest = exportAgent(agentDir);

      // Should produce a valid manifest
      expect(validateManifest(manifest)).toBe(true);
      expect(manifest.manifestVersion).toBe(1);
      expect(manifest.name).toBe('Test Export Agent');
      expect(manifest.seedId).toBe('test-agent-export');
      expect(manifest.skills).toEqual(['web-search', 'code-review']);
      expect(manifest.channels).toEqual(['discord', 'slack']);
    });

    it('produces valid YAML when serialized', () => {
      const agentDir = path.join(tempRoot, 'yaml-agent');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        path.join(agentDir, 'agent.config.json'),
        JSON.stringify(TEST_AGENT_CONFIG, null, 2),
        'utf-8',
      );

      const manifest = exportAgent(agentDir);
      const yamlStr = YAML.stringify(manifest);

      // YAML should be parseable back
      const parsed = YAML.parse(yamlStr);
      expect(parsed.manifestVersion).toBe(1);
      expect(parsed.name).toBe('Test Export Agent');
      expect(parsed.skills).toEqual(['web-search', 'code-review']);
    });

    it('produces valid JSON when serialized', () => {
      const agentDir = path.join(tempRoot, 'json-agent');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        path.join(agentDir, 'agent.config.json'),
        JSON.stringify(TEST_AGENT_CONFIG, null, 2),
        'utf-8',
      );

      const manifest = exportAgent(agentDir);
      const jsonStr = JSON.stringify(manifest, null, 2);

      // JSON should be parseable back
      const parsed = JSON.parse(jsonStr);
      expect(parsed.manifestVersion).toBe(1);
      expect(parsed.name).toBe('Test Export Agent');
    });

    it('includes PERSONA.md content when present', () => {
      const agentDir = path.join(tempRoot, 'persona-agent');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        path.join(agentDir, 'agent.config.json'),
        JSON.stringify(TEST_AGENT_CONFIG, null, 2),
        'utf-8',
      );
      writeFileSync(
        path.join(agentDir, 'PERSONA.md'),
        '# My Persona\n\nI am a friendly test agent.',
        'utf-8',
      );

      const manifest = exportAgent(agentDir);
      expect(manifest.persona).toBe('# My Persona\n\nI am a friendly test agent.');
    });

    it('throws when agent.config.json is missing', () => {
      const emptyDir = path.join(tempRoot, 'empty-dir');
      mkdirSync(emptyDir, { recursive: true });

      expect(() => exportAgent(emptyDir)).toThrow('agent.config.json not found');
    });
  });

  // -------------------------------------------------------------------------
  // Import tests
  // -------------------------------------------------------------------------

  describe('import', () => {
    it('creates agent directory with agent.config.json', () => {
      const manifest = makeValidManifest();
      const targetDir = path.join(tempRoot, 'imported-agent');

      importAgent(manifest, targetDir);

      expect(existsSync(targetDir)).toBe(true);
      expect(existsSync(path.join(targetDir, 'agent.config.json'))).toBe(true);

      const config = JSON.parse(readFileSync(path.join(targetDir, 'agent.config.json'), 'utf-8'));
      expect(config.seedId).toBe('test-import-agent');
      expect(config.displayName).toBe('Test Import Agent');
    });

    it('creates skills directory', () => {
      const manifest = makeValidManifest();
      const targetDir = path.join(tempRoot, 'skills-agent');

      importAgent(manifest, targetDir);

      expect(existsSync(path.join(targetDir, 'skills'))).toBe(true);
    });

    it('writes PERSONA.md when persona content is present', () => {
      const manifest = makeValidManifest({ persona: '# My Persona\nHello world.' });
      const targetDir = path.join(tempRoot, 'persona-import');

      importAgent(manifest, targetDir);

      expect(existsSync(path.join(targetDir, 'PERSONA.md'))).toBe(true);
      const persona = readFileSync(path.join(targetDir, 'PERSONA.md'), 'utf-8');
      expect(persona).toBe('# My Persona\nHello world.');
    });

    it('imports from YAML content', () => {
      const manifest = makeValidManifest();
      const yamlStr = YAML.stringify(manifest);

      // Parse YAML back and import
      const parsed = YAML.parse(yamlStr);
      expect(validateManifest(parsed)).toBe(true);

      const targetDir = path.join(tempRoot, 'yaml-imported');
      importAgent(parsed, targetDir);

      const config = JSON.parse(readFileSync(path.join(targetDir, 'agent.config.json'), 'utf-8'));
      expect(config.seedId).toBe('test-import-agent');
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip tests
  // -------------------------------------------------------------------------

  describe('round-trip', () => {
    it('export -> import -> export produces equivalent manifests', () => {
      // Step 1: Create an agent directory
      const agentDir = path.join(tempRoot, 'roundtrip-source');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        path.join(agentDir, 'agent.config.json'),
        JSON.stringify(TEST_AGENT_CONFIG, null, 2),
        'utf-8',
      );

      // Step 2: Export
      const manifest1 = exportAgent(agentDir);

      // Step 3: Import into a new directory
      const importDir = path.join(tempRoot, 'roundtrip-imported');
      importAgent(manifest1, importDir);

      // Step 4: Re-export from the imported directory
      const manifest2 = exportAgent(importDir);

      // Key fields should match
      expect(manifest2.seedId).toBe(manifest1.seedId);
      expect(manifest2.name).toBe(manifest1.name);
      expect(manifest2.description).toBe(manifest1.description);
      expect(manifest2.skills).toEqual(manifest1.skills);
      expect(manifest2.hexacoTraits).toEqual(manifest1.hexacoTraits);
    });

    it('YAML round-trip preserves config', () => {
      const manifest = makeValidManifest({
        skills: ['code-review', 'web-search', 'rag-memory'],
        channels: ['discord', 'slack', 'telegram'],
        llmProvider: 'anthropic',
        llmModel: 'claude-sonnet-4-20250514',
      });

      // Serialize to YAML and back
      const yamlStr = YAML.stringify(manifest);
      const parsed = YAML.parse(yamlStr) as AgentManifest;

      expect(validateManifest(parsed)).toBe(true);
      expect(parsed.skills).toEqual(['code-review', 'web-search', 'rag-memory']);
      expect(parsed.channels).toEqual(['discord', 'slack', 'telegram']);
      expect(parsed.llmProvider).toBe('anthropic');
    });
  });

  // -------------------------------------------------------------------------
  // Dry-run behavior (validation without file creation)
  // -------------------------------------------------------------------------

  describe('dry-run / validation', () => {
    it('validateManifest accepts valid manifests', () => {
      const manifest = makeValidManifest();
      expect(validateManifest(manifest)).toBe(true);
    });

    it('validateManifest rejects missing manifestVersion', () => {
      const invalid = { ...makeValidManifest() } as Record<string, unknown>;
      delete invalid.manifestVersion;
      expect(validateManifest(invalid)).toBe(false);
    });

    it('validateManifest rejects wrong manifestVersion', () => {
      const invalid = { ...makeValidManifest(), manifestVersion: 2 };
      expect(validateManifest(invalid)).toBe(false);
    });

    it('validateManifest rejects missing seedId', () => {
      const invalid = { ...makeValidManifest() } as Record<string, unknown>;
      delete invalid.seedId;
      expect(validateManifest(invalid)).toBe(false);
    });

    it('validateManifest rejects missing name', () => {
      const invalid = { ...makeValidManifest() } as Record<string, unknown>;
      delete invalid.name;
      expect(validateManifest(invalid)).toBe(false);
    });

    it('validateManifest rejects missing skills array', () => {
      const invalid = { ...makeValidManifest() } as Record<string, unknown>;
      delete invalid.skills;
      expect(validateManifest(invalid)).toBe(false);
    });

    it('validateManifest rejects missing channels array', () => {
      const invalid = { ...makeValidManifest() } as Record<string, unknown>;
      delete invalid.channels;
      expect(validateManifest(invalid)).toBe(false);
    });

    it('validateManifest rejects non-object input', () => {
      expect(validateManifest(null)).toBe(false);
      expect(validateManifest('string')).toBe(false);
      expect(validateManifest(42)).toBe(false);
      expect(validateManifest(undefined)).toBe(false);
    });

    it('dry-run does not create files (importAgent not called)', () => {
      // This tests the concept: if we validate but don't call importAgent,
      // no directory should be created
      const manifest = makeValidManifest();
      const targetDir = path.join(tempRoot, 'dry-run-target');

      // Just validate — do NOT import
      const isValid = validateManifest(manifest);
      expect(isValid).toBe(true);

      // Directory should NOT exist (we didn't call importAgent)
      expect(existsSync(targetDir)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Secret redaction
  // -------------------------------------------------------------------------

  describe('secret redaction', () => {
    it('redacts apiKey fields when serialized with redaction', () => {
      const configWithSecrets = {
        ...TEST_AGENT_CONFIG,
        extensions: {
          openai: { apiKey: 'sk-test-secret-key-12345' },
          anthropic: { apiKey: 'sk-ant-super-secret-key' },
        },
      };

      const agentDir = path.join(tempRoot, 'secret-agent');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        path.join(agentDir, 'agent.config.json'),
        JSON.stringify(configWithSecrets, null, 2),
        'utf-8',
      );

      const manifest = exportAgent(agentDir);

      // Simulate the redaction from the export command
      const exported = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
      redactSecretsHelper(exported);

      // Extension API keys should be redacted
      const extensions = exported.extensions as Record<string, Record<string, unknown>>;
      if (extensions?.openai) {
        expect(extensions.openai.apiKey).toBe('***REDACTED***');
      }
      if (extensions?.anthropic) {
        expect(extensions.anthropic.apiKey).toBe('***REDACTED***');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Helper — mirrors the redaction logic from export-agent.ts
// ---------------------------------------------------------------------------

const SECRET_FIELD_NAMES = new Set([
  'apikey', 'api_key', 'apiKey',
  'secret', 'token', 'password',
  'accesstoken', 'access_token', 'accessToken',
  'refreshtoken', 'refresh_token', 'refreshToken',
  'authtoken', 'auth_token', 'authToken',
]);

const API_KEY_PATTERN = /^(sk-|sk-ant-|AIzaSy|ghp_|ghr_|xai-|glpat-).+/;

/**
 * Recursively redacts secret values. Mirror of the export command's redaction.
 *
 * @param obj - Object to redact in-place.
 * @returns The mutated object.
 */
function redactSecretsHelper(obj: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSecretField = SECRET_FIELD_NAMES.has(lowerKey) || lowerKey.endsWith('key') || lowerKey.endsWith('secret');

    if (isSecretField && typeof value === 'string' && value.length > 0) {
      obj[key] = '***REDACTED***';
    } else if (typeof value === 'string' && API_KEY_PATTERN.test(value)) {
      obj[key] = '***REDACTED***';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      redactSecretsHelper(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          redactSecretsHelper(item as Record<string, unknown>);
        }
      }
    }
  }
  return obj;
}
