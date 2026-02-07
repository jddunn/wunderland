/**
 * @fileoverview Integration tests for AgentManifest — round-trip export/validate/import.
 * @module wunderland/core/__tests__/AgentManifest.integration.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { exportAgent, importAgent, validateManifest } from '../AgentManifest.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const SAMPLE_CONFIG = {
  seedId: 'seed_test',
  displayName: 'Test Agent',
  bio: 'A test agent',
  personality: {
    honesty: 0.8,
    emotionality: 0.5,
    extraversion: 0.6,
    agreeableness: 0.7,
    conscientiousness: 0.8,
    openness: 0.7,
  },
  systemPrompt: 'You are a test agent.',
  security: {
    preLLMClassifier: true,
    dualLLMAudit: true,
    outputSigning: false,
  },
  skills: ['summarize', 'github'],
  suggestedChannels: ['webchat', 'slack'],
};

const SAMPLE_PERSONA = '# Test Agent\n\nYou are a helpful test agent with broad knowledge.';

/** Temp dirs to clean up after each test */
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-test-'));
  tempDirs.push(dir);
  return dir;
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
  tempDirs.length = 0;
});

// ── Round-trip: export -> validate -> import ────────────────────────────────

describe('AgentManifest round-trip export -> validate -> import', () => {
  it('should export, validate, and import an agent with all fields intact', () => {
    // --- Setup source directory ---
    const sourceDir = createTempDir();
    writeFileSync(
      join(sourceDir, 'agent.config.json'),
      JSON.stringify(SAMPLE_CONFIG, null, 2),
      'utf-8',
    );
    writeFileSync(join(sourceDir, 'PERSONA.md'), SAMPLE_PERSONA, 'utf-8');

    // --- Export ---
    const manifest = exportAgent(sourceDir);

    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.seedId).toBe('seed_test');
    expect(manifest.name).toBe('Test Agent');
    expect(manifest.description).toBe('A test agent');
    expect(manifest.hexacoTraits.honesty).toBe(0.8);
    expect(manifest.hexacoTraits.openness).toBe(0.7);
    expect(manifest.skills).toEqual(['summarize', 'github']);
    expect(manifest.channels).toEqual(['webchat', 'slack']);
    expect(manifest.persona).toBe(SAMPLE_PERSONA);
    expect(manifest.systemPrompt).toBe('You are a test agent.');
    expect(manifest.exportedAt).toBeTruthy();
    expect(manifest.sealed).toBe(false);

    // --- Validate ---
    const isValid = validateManifest(manifest);
    expect(isValid).toBe(true);

    // --- Import into target directory ---
    const targetDir = createTempDir();
    importAgent(manifest, join(targetDir, 'imported'));

    const importedDir = join(targetDir, 'imported');

    // Verify agent.config.json was created and fields match
    const importedConfigPath = join(importedDir, 'agent.config.json');
    expect(existsSync(importedConfigPath)).toBe(true);

    const importedConfig = JSON.parse(readFileSync(importedConfigPath, 'utf-8'));
    expect(importedConfig.seedId).toBe('seed_test');
    expect(importedConfig.displayName).toBe('Test Agent');
    expect(importedConfig.bio).toBe('A test agent');
    expect(importedConfig.personality.honesty).toBe(0.8);
    expect(importedConfig.personality.openness).toBe(0.7);
    expect(importedConfig.skills).toEqual(['summarize', 'github']);
    expect(importedConfig.suggestedChannels).toEqual(['webchat', 'slack']);
    expect(importedConfig.systemPrompt).toBe('You are a test agent.');

    // Verify PERSONA.md was created and content matches
    const importedPersonaPath = join(importedDir, 'PERSONA.md');
    expect(existsSync(importedPersonaPath)).toBe(true);

    const importedPersona = readFileSync(importedPersonaPath, 'utf-8');
    expect(importedPersona).toBe(SAMPLE_PERSONA);

    // Verify skills/ directory was created
    const skillsDir = join(importedDir, 'skills');
    expect(existsSync(skillsDir)).toBe(true);
  });
});

// ── Export sealed agent ─────────────────────────────────────────────────────

describe('AgentManifest export sealed agent', () => {
  it('should set sealed=true and configHash from sealed.json', () => {
    const sourceDir = createTempDir();
    writeFileSync(
      join(sourceDir, 'agent.config.json'),
      JSON.stringify(SAMPLE_CONFIG, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(sourceDir, 'sealed.json'),
      JSON.stringify({ configHash: 'sha256:abc123def456' }),
      'utf-8',
    );

    const manifest = exportAgent(sourceDir);

    expect(manifest.sealed).toBe(true);
    expect(manifest.configHash).toBe('sha256:abc123def456');
  });
});

// ── Import without persona ──────────────────────────────────────────────────

describe('AgentManifest import without persona', () => {
  it('should not create PERSONA.md when persona field is absent', () => {
    const manifest = {
      manifestVersion: 1 as const,
      exportedAt: new Date().toISOString(),
      seedId: 'seed_no_persona',
      name: 'No Persona Agent',
      description: 'An agent without persona',
      hexacoTraits: {
        honesty: 0.5,
        emotionality: 0.5,
        extraversion: 0.5,
        agreeableness: 0.5,
        conscientiousness: 0.5,
        openness: 0.5,
      },
      skills: ['search'],
      channels: ['webchat'],
      // persona intentionally omitted
    };

    const targetDir = createTempDir();
    importAgent(manifest, join(targetDir, 'no-persona'));

    const importedDir = join(targetDir, 'no-persona');

    // agent.config.json should exist
    expect(existsSync(join(importedDir, 'agent.config.json'))).toBe(true);

    // PERSONA.md should NOT be created
    expect(existsSync(join(importedDir, 'PERSONA.md'))).toBe(false);

    // skills/ directory should still be created
    expect(existsSync(join(importedDir, 'skills'))).toBe(true);
  });
});
