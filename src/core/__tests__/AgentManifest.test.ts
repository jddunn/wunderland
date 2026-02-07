/**
 * @fileoverview Tests for AgentManifest — export, import, and validation of agent manifests.
 * @module wunderland/core/__tests__/AgentManifest.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  exportAgent,
  importAgent,
  validateManifest,
  type AgentManifest,
} from '../AgentManifest.js';

// ── Mock node:fs ────────────────────────────────────────────────────────────

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);

// ── Helpers ─────────────────────────────────────────────────────────────────

const SAMPLE_DIR = '/agents/test-agent';

const SAMPLE_CONFIG = {
  seedId: 'seed-abc-123',
  displayName: 'TestBot',
  bio: 'A helpful test agent',
  presetId: 'preset-alpha',
  personality: {
    honesty: 0.9,
    emotionality: 0.4,
    extraversion: 0.7,
    agreeableness: 0.6,
    conscientiousness: 0.85,
    openness: 0.75,
  },
  systemPrompt: 'You are TestBot, a meticulous tester.',
  skills: ['web-search', 'code-exec'],
  suggestedChannels: ['telegram', 'discord'],
  security: {
    tier: 'standard',
    preLLMClassifier: true,
    dualLLMAudit: false,
    outputSigning: true,
  },
};

const SAMPLE_PERSONA = '# TestBot Persona\n\nI am a meticulous tester of all things.';

const SAMPLE_SEALED = { configHash: 'sha256-abc123def456' };

function buildMinimalManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    manifestVersion: 1,
    exportedAt: '2026-01-15T12:00:00.000Z',
    seedId: 'seed-abc-123',
    name: 'TestBot',
    description: 'A helpful test agent',
    hexacoTraits: {
      honesty: 0.9,
      emotionality: 0.4,
      extraversion: 0.7,
      agreeableness: 0.6,
      conscientiousness: 0.85,
      openness: 0.75,
    },
    skills: ['web-search', 'code-exec'],
    channels: ['telegram', 'discord'],
    ...overrides,
  };
}

/**
 * Set up the fs mocks so that existsSync returns true for specified paths
 * and readFileSync returns appropriate content.
 */
function setupFsMocks(opts: {
  configExists?: boolean;
  config?: Record<string, unknown>;
  personaExists?: boolean;
  persona?: string;
  sealedExists?: boolean;
  sealedContent?: string;
} = {}) {
  const {
    configExists = true,
    config = SAMPLE_CONFIG,
    personaExists = false,
    persona = SAMPLE_PERSONA,
    sealedExists = false,
    sealedContent = JSON.stringify(SAMPLE_SEALED),
  } = opts;

  const configPath = join(SAMPLE_DIR, 'agent.config.json');
  const personaPath = join(SAMPLE_DIR, 'PERSONA.md');
  const sealedPath = join(SAMPLE_DIR, 'sealed.json');

  mockExistsSync.mockImplementation((p: unknown) => {
    const path = String(p);
    if (path === configPath) return configExists;
    if (path === personaPath) return personaExists;
    if (path === sealedPath) return sealedExists;
    return false;
  });

  mockReadFileSync.mockImplementation((p: unknown, _encoding?: unknown) => {
    const path = String(p);
    if (path === configPath) return JSON.stringify(config);
    if (path === personaPath) return persona;
    if (path === sealedPath) return sealedContent;
    throw new Error(`Unexpected readFileSync call: ${path}`);
  });
}

// ── Reset mocks ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// exportAgent
// ============================================================================

describe('exportAgent', () => {
  it('should throw when agent.config.json does not exist', () => {
    setupFsMocks({ configExists: false });

    expect(() => exportAgent(SAMPLE_DIR)).toThrow('agent.config.json not found');
  });

  it('should read config and build manifest with correct field mapping', () => {
    setupFsMocks({ configExists: true });

    const manifest = exportAgent(SAMPLE_DIR);

    expect(manifest.seedId).toBe(SAMPLE_CONFIG.seedId);
    expect(manifest.name).toBe(SAMPLE_CONFIG.displayName);
    expect(manifest.description).toBe(SAMPLE_CONFIG.bio);
    expect(manifest.hexacoTraits.honesty).toBe(SAMPLE_CONFIG.personality.honesty);
    expect(manifest.hexacoTraits.emotionality).toBe(SAMPLE_CONFIG.personality.emotionality);
    expect(manifest.hexacoTraits.extraversion).toBe(SAMPLE_CONFIG.personality.extraversion);
    expect(manifest.hexacoTraits.agreeableness).toBe(SAMPLE_CONFIG.personality.agreeableness);
    expect(manifest.hexacoTraits.conscientiousness).toBe(SAMPLE_CONFIG.personality.conscientiousness);
    expect(manifest.hexacoTraits.openness).toBe(SAMPLE_CONFIG.personality.openness);
    expect(manifest.skills).toEqual(SAMPLE_CONFIG.skills);
    expect(manifest.channels).toEqual(SAMPLE_CONFIG.suggestedChannels);
    expect(manifest.systemPrompt).toBe(SAMPLE_CONFIG.systemPrompt);
  });

  it('should set manifestVersion to 1', () => {
    setupFsMocks();

    const manifest = exportAgent(SAMPLE_DIR);

    expect(manifest.manifestVersion).toBe(1);
  });

  it('should set exportedAt to an ISO 8601 string', () => {
    setupFsMocks();

    const before = new Date().toISOString();
    const manifest = exportAgent(SAMPLE_DIR);
    const after = new Date().toISOString();

    // Verify it is a valid ISO string by parsing it
    const exportDate = new Date(manifest.exportedAt);
    expect(exportDate.toISOString()).toBe(manifest.exportedAt);

    // Verify it falls within the expected time range
    expect(manifest.exportedAt >= before).toBe(true);
    expect(manifest.exportedAt <= after).toBe(true);
  });

  it('should set presetId from config', () => {
    setupFsMocks();

    const manifest = exportAgent(SAMPLE_DIR);

    expect(manifest.presetId).toBe('preset-alpha');
  });

  it('should read PERSONA.md if it exists', () => {
    setupFsMocks({ personaExists: true });

    const manifest = exportAgent(SAMPLE_DIR);

    expect(manifest.persona).toBe(SAMPLE_PERSONA);
  });

  it('should omit persona if PERSONA.md does not exist', () => {
    setupFsMocks({ personaExists: false });

    const manifest = exportAgent(SAMPLE_DIR);

    expect(manifest.persona).toBeUndefined();
  });

  it('should read sealed.json and set sealed=true with configHash when it exists', () => {
    setupFsMocks({ sealedExists: true });

    const manifest = exportAgent(SAMPLE_DIR);

    expect(manifest.sealed).toBe(true);
    expect(manifest.configHash).toBe(SAMPLE_SEALED.configHash);
  });

  it('should handle missing sealed.json (sealed=false, no configHash)', () => {
    setupFsMocks({ sealedExists: false });

    const manifest = exportAgent(SAMPLE_DIR);

    expect(manifest.sealed).toBe(false);
    expect(manifest.configHash).toBeUndefined();
  });

  it('should handle malformed sealed.json gracefully (sealed=false)', () => {
    setupFsMocks({
      sealedExists: true,
      sealedContent: '{ this is not valid JSON !!!',
    });

    const manifest = exportAgent(SAMPLE_DIR);

    expect(manifest.sealed).toBe(false);
    expect(manifest.configHash).toBeUndefined();
  });

  it('should default skills to empty array when not in config', () => {
    const configWithoutSkills = { ...SAMPLE_CONFIG };
    delete (configWithoutSkills as Record<string, unknown>).skills;

    setupFsMocks({ config: configWithoutSkills });

    const manifest = exportAgent(SAMPLE_DIR);

    expect(manifest.skills).toEqual([]);
  });

  it('should default channels to empty array when suggestedChannels is not in config', () => {
    const configWithoutChannels = { ...SAMPLE_CONFIG };
    delete (configWithoutChannels as Record<string, unknown>).suggestedChannels;

    setupFsMocks({ config: configWithoutChannels });

    const manifest = exportAgent(SAMPLE_DIR);

    expect(manifest.channels).toEqual([]);
  });

  it('should default personality traits when personality is missing from config', () => {
    const configWithoutPersonality = { ...SAMPLE_CONFIG };
    delete (configWithoutPersonality as Record<string, unknown>).personality;

    setupFsMocks({ config: configWithoutPersonality });

    const manifest = exportAgent(SAMPLE_DIR);

    // Defaults from the source
    expect(manifest.hexacoTraits.honesty).toBe(0.7);
    expect(manifest.hexacoTraits.emotionality).toBe(0.5);
    expect(manifest.hexacoTraits.extraversion).toBe(0.6);
    expect(manifest.hexacoTraits.agreeableness).toBe(0.65);
    expect(manifest.hexacoTraits.conscientiousness).toBe(0.8);
    expect(manifest.hexacoTraits.openness).toBe(0.75);
  });

  it('should set securityTier from config security.tier', () => {
    setupFsMocks();

    const manifest = exportAgent(SAMPLE_DIR);

    expect(manifest.securityTier).toBe('standard');
  });

  it('should set systemPrompt to undefined when not a string in config', () => {
    const configWithBadPrompt = { ...SAMPLE_CONFIG, systemPrompt: 42 };
    setupFsMocks({ config: configWithBadPrompt as unknown as Record<string, unknown> });

    const manifest = exportAgent(SAMPLE_DIR);

    expect(manifest.systemPrompt).toBeUndefined();
  });
});

// ============================================================================
// importAgent
// ============================================================================

describe('importAgent', () => {
  const TARGET_DIR = '/imports/new-agent';

  it('should create target directory with mkdirSync recursive', () => {
    const manifest = buildMinimalManifest();

    importAgent(manifest, TARGET_DIR);

    expect(mockMkdirSync).toHaveBeenCalledWith(TARGET_DIR, { recursive: true });
  });

  it('should write agent.config.json with correct field mapping', () => {
    const manifest = buildMinimalManifest({
      presetId: 'preset-alpha',
      systemPrompt: 'Custom prompt here.',
      securityTier: 'standard',
      security: {
        preLLMClassifier: true,
        dualLLMAudit: true,
        outputSigning: false,
      },
    });

    importAgent(manifest, TARGET_DIR);

    const configWriteCall = mockWriteFileSync.mock.calls.find(
      (call) => String(call[0]) === join(TARGET_DIR, 'agent.config.json'),
    );
    expect(configWriteCall).toBeDefined();

    const writtenConfig = JSON.parse(configWriteCall![1] as string);
    expect(writtenConfig.seedId).toBe('seed-abc-123');
    expect(writtenConfig.displayName).toBe('TestBot');
    expect(writtenConfig.bio).toBe('A helpful test agent');
    expect(writtenConfig.personality).toEqual(manifest.hexacoTraits);
    expect(writtenConfig.skills).toEqual(['web-search', 'code-exec']);
    expect(writtenConfig.suggestedChannels).toEqual(['telegram', 'discord']);
    expect(writtenConfig.systemPrompt).toBe('Custom prompt here.');
    expect(writtenConfig.presetId).toBe('preset-alpha');
    expect(writtenConfig.skillsDir).toBe('./skills');
  });

  it('should write PERSONA.md when persona is present', () => {
    const manifest = buildMinimalManifest({ persona: 'I am a test persona.' });

    importAgent(manifest, TARGET_DIR);

    const personaWriteCall = mockWriteFileSync.mock.calls.find(
      (call) => String(call[0]) === join(TARGET_DIR, 'PERSONA.md'),
    );
    expect(personaWriteCall).toBeDefined();
    expect(personaWriteCall![1]).toBe('I am a test persona.');
    expect(personaWriteCall![2]).toBe('utf-8');
  });

  it('should not write PERSONA.md when persona is undefined', () => {
    const manifest = buildMinimalManifest({ persona: undefined });

    importAgent(manifest, TARGET_DIR);

    const personaWriteCall = mockWriteFileSync.mock.calls.find(
      (call) => String(call[0]) === join(TARGET_DIR, 'PERSONA.md'),
    );
    expect(personaWriteCall).toBeUndefined();
  });

  it('should create skills/ directory with recursive option', () => {
    const manifest = buildMinimalManifest();

    importAgent(manifest, TARGET_DIR);

    expect(mockMkdirSync).toHaveBeenCalledWith(
      join(TARGET_DIR, 'skills'),
      { recursive: true },
    );
  });

  it('should map manifest fields back to config format correctly', () => {
    const manifest = buildMinimalManifest();

    importAgent(manifest, TARGET_DIR);

    const configWriteCall = mockWriteFileSync.mock.calls.find(
      (call) => String(call[0]) === join(TARGET_DIR, 'agent.config.json'),
    );
    expect(configWriteCall).toBeDefined();

    const writtenConfig = JSON.parse(configWriteCall![1] as string);

    // manifest.name -> config.displayName
    expect(writtenConfig.displayName).toBe(manifest.name);
    // manifest.description -> config.bio
    expect(writtenConfig.bio).toBe(manifest.description);
    // manifest.hexacoTraits -> config.personality
    expect(writtenConfig.personality).toEqual(manifest.hexacoTraits);
    // manifest.channels -> config.suggestedChannels
    expect(writtenConfig.suggestedChannels).toEqual(manifest.channels);
    // manifest.skills -> config.skills
    expect(writtenConfig.skills).toEqual(manifest.skills);
  });

  it('should default systemPrompt when manifest has no systemPrompt', () => {
    const manifest = buildMinimalManifest({ systemPrompt: undefined });

    importAgent(manifest, TARGET_DIR);

    const configWriteCall = mockWriteFileSync.mock.calls.find(
      (call) => String(call[0]) === join(TARGET_DIR, 'agent.config.json'),
    );
    const writtenConfig = JSON.parse(configWriteCall![1] as string);

    expect(writtenConfig.systemPrompt).toBe(
      'You are an autonomous agent in the Wunderland network.',
    );
  });

  it('should default security when manifest has no security', () => {
    const manifest = buildMinimalManifest({ security: undefined });

    importAgent(manifest, TARGET_DIR);

    const configWriteCall = mockWriteFileSync.mock.calls.find(
      (call) => String(call[0]) === join(TARGET_DIR, 'agent.config.json'),
    );
    const writtenConfig = JSON.parse(configWriteCall![1] as string);

    expect(writtenConfig.security).toEqual({
      preLLMClassifier: true,
      dualLLMAudit: true,
      outputSigning: true,
    });
  });

  it('should merge securityTier into security object when both present', () => {
    const manifest = buildMinimalManifest({
      securityTier: 'high',
      security: {
        preLLMClassifier: true,
        dualLLMAudit: true,
        outputSigning: true,
      },
    });

    importAgent(manifest, TARGET_DIR);

    const configWriteCall = mockWriteFileSync.mock.calls.find(
      (call) => String(call[0]) === join(TARGET_DIR, 'agent.config.json'),
    );
    const writtenConfig = JSON.parse(configWriteCall![1] as string);

    expect(writtenConfig.security.tier).toBe('high');
  });

  it('should write agent.config.json as pretty-printed JSON with trailing newline', () => {
    const manifest = buildMinimalManifest();

    importAgent(manifest, TARGET_DIR);

    const configWriteCall = mockWriteFileSync.mock.calls.find(
      (call) => String(call[0]) === join(TARGET_DIR, 'agent.config.json'),
    );
    const rawContent = configWriteCall![1] as string;

    // Should end with newline
    expect(rawContent.endsWith('\n')).toBe(true);
    // Should be indented (pretty-printed with 2 spaces)
    expect(rawContent).toContain('  "seedId"');
  });
});

// ============================================================================
// validateManifest
// ============================================================================

describe('validateManifest', () => {
  it('should return true for a valid manifest', () => {
    const manifest = buildMinimalManifest();
    expect(validateManifest(manifest)).toBe(true);
  });

  it('should return false for null', () => {
    expect(validateManifest(null)).toBe(false);
  });

  it('should return false for non-object (string)', () => {
    expect(validateManifest('not an object')).toBe(false);
  });

  it('should return false for non-object (number)', () => {
    expect(validateManifest(42)).toBe(false);
  });

  it('should return false for non-object (undefined)', () => {
    expect(validateManifest(undefined)).toBe(false);
  });

  it('should return false for wrong manifestVersion (e.g. 2)', () => {
    const data = { ...buildMinimalManifest(), manifestVersion: 2 };
    expect(validateManifest(data)).toBe(false);
  });

  it('should return false for manifestVersion as string "1"', () => {
    const data = { ...buildMinimalManifest(), manifestVersion: '1' };
    expect(validateManifest(data)).toBe(false);
  });

  it('should return false for missing seedId', () => {
    const data = buildMinimalManifest();
    delete (data as Record<string, unknown>).seedId;
    expect(validateManifest(data)).toBe(false);
  });

  it('should return false for missing name', () => {
    const data = buildMinimalManifest();
    delete (data as Record<string, unknown>).name;
    expect(validateManifest(data)).toBe(false);
  });

  it('should return false for missing description', () => {
    const data = buildMinimalManifest();
    delete (data as Record<string, unknown>).description;
    expect(validateManifest(data)).toBe(false);
  });

  it('should return false for missing hexacoTraits', () => {
    const data = buildMinimalManifest();
    delete (data as Record<string, unknown>).hexacoTraits;
    expect(validateManifest(data)).toBe(false);
  });

  it('should return false for hexacoTraits set to null', () => {
    const data = { ...buildMinimalManifest(), hexacoTraits: null };
    expect(validateManifest(data)).toBe(false);
  });

  it('should return false for missing skills', () => {
    const data = buildMinimalManifest();
    delete (data as Record<string, unknown>).skills;
    expect(validateManifest(data)).toBe(false);
  });

  it('should return false for skills as non-array', () => {
    const data = { ...buildMinimalManifest(), skills: 'web-search' };
    expect(validateManifest(data)).toBe(false);
  });

  it('should return false for missing channels', () => {
    const data = buildMinimalManifest();
    delete (data as Record<string, unknown>).channels;
    expect(validateManifest(data)).toBe(false);
  });

  it('should return false for channels as non-array', () => {
    const data = { ...buildMinimalManifest(), channels: 'telegram' };
    expect(validateManifest(data)).toBe(false);
  });

  it('should return true even with optional fields missing (presetId, persona, etc.)', () => {
    const data: Record<string, unknown> = {
      manifestVersion: 1,
      exportedAt: '2026-01-15T12:00:00.000Z',
      seedId: 'seed-abc-123',
      name: 'TestBot',
      description: 'A helpful test agent',
      hexacoTraits: {
        honesty: 0.9,
        emotionality: 0.4,
        extraversion: 0.7,
        agreeableness: 0.6,
        conscientiousness: 0.85,
        openness: 0.75,
      },
      skills: [],
      channels: [],
      // No presetId, persona, systemPrompt, configHash, sealed, securityTier, security
    };
    expect(validateManifest(data)).toBe(true);
  });

  it('should return true for valid manifest with all optional fields present', () => {
    const data = {
      ...buildMinimalManifest(),
      presetId: 'preset-alpha',
      persona: 'I am a bot.',
      systemPrompt: 'You are a bot.',
      configHash: 'sha256-hash',
      sealed: true,
      securityTier: 'standard',
      security: {
        preLLMClassifier: true,
        dualLLMAudit: true,
        outputSigning: true,
      },
    };
    expect(validateManifest(data)).toBe(true);
  });

  it('should return false for an empty object', () => {
    expect(validateManifest({})).toBe(false);
  });

  it('should return false for an array', () => {
    expect(validateManifest([])).toBe(false);
  });
});
